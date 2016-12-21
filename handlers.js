var assign = require('lodash.assign');
var merge = require('lodash.merge');
var when = require('when');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var joi = require('joi');
var errors = require('./errors');

var getReqRespValidation = function getReqRespValidation(routeConfig) {
    var request = {
        payload: routeConfig.config.payload || joi.object({
            jsonrpc: joi.string().valid('2.0').required(),
            id: joi.alternatives().try(joi.number().example(1), joi.string().example('1')).required(),
            method: joi.string().valid((routeConfig.config && routeConfig.config.paramsMethod || routeConfig.method)).required(),
            params: routeConfig.config.params.label('params').required()
        }),
        params: joi.object({
            method: joi.string().valid((routeConfig.config && routeConfig.config.paramsMethod || routeConfig.method))
        })
    };
    var response = routeConfig.config.response || joi.object({
        jsonrpc: joi.string().valid('2.0').required(),
        id: joi.alternatives().try(joi.number(), joi.string()).required(),
        result: routeConfig.config.result.label('result'),
        error: joi.object({
            code: joi.number().integer().description('Error code'),
            message: joi.string().description('Debug error message'),
            errorPrint: joi.string().optional().description('User friendly error message'),
            fieldErrors: joi.any().description('Field validation errors'),
            type: joi.string().description('Error type')
        }).label('error'),
        debug: joi.object().label('debug')
    })
    .xor('result', 'error');
    return {request, response};
};

var assertRouteConfig = function assertRouteConfig(routeConfig) {
    if (!routeConfig.config.params && !routeConfig.config.payload) {
        throw new Error(`Missing 'params'/'payload' in validation schema for method: ${routeConfig.method}`);
    } else if (routeConfig.config.params && !routeConfig.config.params.isJoi) {
        throw new Error(`'params' must be a joi schema object! Method: ${routeConfig.method}`);
    } else if (routeConfig.config.payload && !routeConfig.config.payload.isJoi) {
        throw new Error(`'payload' must be a joi schema object! Method: ${routeConfig.method}`);
    } else if (!routeConfig.config.result && !routeConfig.config.response) {
        throw new Error(`Missing 'result'/'response' in validation schema for method: ${routeConfig.method}`);
    } else if (routeConfig.config.result && !routeConfig.config.result.isJoi) {
        throw new Error(`'result' must be a joi schema object! Method: ${routeConfig.method}`);
    } else if (routeConfig.config.response && !routeConfig.config.response.isJoi) {
        throw new Error(`'response' must be a joi schema object! Method: ${routeConfig.method}`);
    }
};

module.exports = function(port) {
    var httpMethods = {};
    var pendingRoutes = [];
    var config = {};
    var validations = {};

    function addDebugInfo(msg, err) {
        err && port.config.debug || (port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.debug = err);
    }

    var byMethodValidate = function byMethodValidate(checkType, method, data) {
        var vr;
        if (checkType === 'request') {
            vr = validations[method].request.payload.validate(data);
            vr.method = 'payload';
        } else if (checkType === 'response') {
            vr = validations[method].response.validate(data);
            vr.method = 'response';
        }
        return vr;
    };
    var doValidate = function doValidate(checkType, method, data, next) {
        if (Object.keys(validations[method] || {}).length === 2) {
            var validationResult = byMethodValidate(checkType, method, data);
            if (validationResult.error) {
                next(validationResult.error);
            } else {
                next(null, data);
            }
        } else if (!validations[method] && !port.config.validationPassThrough) {
            next(errors.ValidationNotFound(`Method ${method} not found`));
        } else {
            next(null, data);
        }
    };

    var rpcHandler = port.handler = function rpcHandler(request, _reply, customReply) {
        var startTime = process.hrtime();
        port.log.trace && port.log.trace({payload: request.payload});
        function addTime() {
            if (port.latency) {
                var diff = process.hrtime(startTime);
                port.latency(diff[0] * 1000 + diff[1] / 1000000, 1);
            }
        }

        var reply = function(resp, headers, statusCode) {
            addTime();
            var repl = _reply(resp);
            headers && Object.keys(headers).forEach(function(header) {
                repl.header(header, headers[header]);
            });
            if (statusCode) {
                repl.code(statusCode);
            }
            return repl;
        };

        function handleError(error, response) {
            var $meta = {};
            var msg = {
                jsonrpc: (request.payload && request.payload.jsonrpc) || '',
                id: (request.payload && request.payload.id) || '',
                error: error
            };
            addDebugInfo(msg, response);
            if (port.config.receive instanceof Function) {
                return when(port.config.receive(msg, $meta)).then(function(result) {
                    return reply(result, $meta.responseHeaders, $meta.statusCode);
                });
            } else {
                return reply(msg);
            }
        }

        var endReply = {
            jsonrpc: request.payload.jsonrpc,
            id: request.payload.id
        };

        var processMessage = function(msgOptions) {
            var $meta;
            function callReply(response) {
                if (typeof customReply === 'function') {
                    customReply(reply, response, $meta);
                } else {
                    reply(endReply, $meta.responseHeaders, $meta.statusCode);
                }
            }
            msgOptions = msgOptions || {};
            try {
                $meta = {
                    auth: request.auth.credentials,
                    method: request.payload.method,
                    opcode: request.payload.method.split('.').pop(),
                    mtid: (request.payload.id == null) ? 'notification' : 'request',
                    requestHeaders: request.headers,
                    ipAddress: request.info && request.info.remoteAddress,
                    frontEnd: request.headers && request.headers['user-agent']
                };
                if (msgOptions.language) {
                    $meta.language = msgOptions.language;
                }
                var callback = function(response) {
                    if (!response) {
                        throw new Error('Add return value of method ' + request.payload.method);
                    }
                    if (!$meta || $meta.mtid === 'error') {
                        var erMs = $meta.errorMessage || response.message;
                        endReply.error = {
                            code: $meta.errorCode || response.code || -1,
                            message: erMs,
                            errorPrint: $meta.errorPrint || response.print || erMs,
                            type: $meta.errorType || response.type,
                            fieldErrors: $meta.fieldErrors || response.fieldErrors
                        };
                        if (typeof customReply === 'function') {
                            addDebugInfo(endReply, response);
                            return customReply(reply, endReply, $meta);
                        }
                        return handleError(endReply.error, response);
                    }
                    if (response.auth) {
                        delete response.auth;
                    }

                    if ($meta && $meta.staticFileName) {
                        fs.access($meta.staticFileName, fs.constants.R_OK, (err) => {
                            addTime();
                            if (err) {
                                endReply.error = {
                                    code: -1,
                                    message: 'File not found',
                                    errorPrint: 'File not found',
                                    type: $meta.errorType || response.type,
                                    fieldErrors: $meta.fieldErrors || response.fieldErrors
                                };
                                handleError(endReply.error, response);
                            } else {
                                _reply(fs.createReadStream($meta.staticFileName));
                            }
                        });

                        return true;
                    }

                    endReply.result = response;
                    if (msgOptions.end && typeof (msgOptions.end) === 'function') {
                        return msgOptions.end.call(void 0, reply(endReply, $meta.responseHeaders));
                    }
                    callReply(response);
                    return true;
                };
                if ($meta.mtid === 'request') {
                    $meta.callback = callback;
                } else {
                    endReply.result = true;
                    callReply(true);
                }
                port.stream.write([request.payload.params || {}, $meta]);
            } catch (err) {
                return handleError({
                    code: err.code || '-1',
                    message: err.message,
                    errorPrint: err.message,
                    type: err.type
                }, err);
            }
        };

        if (request.payload.method === 'identity.closeSession' && request.auth && request.auth.credentials) {
            return processMessage({
                end: (repl) => {
                    repl.state(port.config.jwt.cookieKey, '', port.config.cookie);
                }
            });
        } else if (
            request.payload.method === 'identity.forgottenPasswordRequest' ||
            request.payload.method === 'identity.forgottenPasswordValidate' ||
            request.payload.method === 'identity.forgottenPassword' ||
            request.payload.method === 'identity.registerRequest' ||
            request.payload.method === 'identity.registerValidate'
        ) {
            return processMessage();
        }
        port.bus.importMethod('identity.check')(
            request.payload.method === 'identity.check'
            ? assign({}, request.payload.params, request.auth.credentials)
            : assign({actionId: request.payload.method}, request.auth.credentials)
        )
        .then((res) => {
            if (request.payload.method === 'identity.check') {
                endReply.result = res;
                if (res['identity.check'] && res['identity.check'].sessionId) {
                    var tz = (request.payload && request.payload.params && request.payload.params.timezone) || '+00:00';
                    var jwtSigned = jwt.sign({
                        timezone: tz,
                        actorId: res['identity.check'].actorId,
                        sessionId: res['identity.check'].sessionId
                    }, port.config.jwt.key);

                    return port.config.cookiePaths.reduce((repl, path) => {
                        repl.state(
                            port.config.jwt.cookieKey,
                            jwtSigned,
                            Object.assign({path}, port.config.cookie)
                        );
                    }, reply(endReply));
                } else {
                    return reply(endReply);
                }
            } else if (request.payload.method === 'permission.get') {
                return processMessage();
            } else {
                if (res['permission.get'] && res['permission.get'].length) {
                    return processMessage({
                        language: res.language
                    });
                } else {
                    return handleError(errors.NotPermitted(`Missing Permission for ${request.payload.method}`));
                }
            }
        })
        .catch((err) => (
            handleError({
                code: err.code || '-1',
                message: err.message,
                errorPrint: err.errorPrint || err.message,
                type: err.type
            }, err)
        ));
    };

    pendingRoutes.unshift(merge({
        config: {
            handler: rpcHandler,
            description: 'rpc common validation',
            tags: ['api', 'rpc'],
            validate: {
                options: {abortEarly: false},
                query: false,
                payload: (value, options, next) => {
                    doValidate('request', value.method, value, next);
                },
                params: true
            },
            response: {
                schema: joi.object({}),
                failAction: (request, reply, value, error) => {
                    doValidate('response', request.params.method || request.payload.method, value._object, (err, result) => {
                        if (err) {
                            port.log.error && port.log.error(err);
                        }
                        reply(value._object);
                    });
                }
            }
        }
    }, port.config.routes.rpc));
    port.bus.importMethods(httpMethods, port.config.api);

    function rpcRouteAdd(method, path, registerInSwagger) {
        port.log.trace && port.log.trace({methodRegistered: method, route: path});
        validations[method] = getReqRespValidation(config[method]);

        if (config[method].config.paramsMethod) {
            config[method].config.paramsMethod.reduce((prev, cur) => {
                if (!validations[cur]) {
                    validations[cur] = validations[method];
                }
            });
        }
        var tags = [port.config.id, config[method].method];
        if (registerInSwagger) {
            tags.unshift('api');
        }
        pendingRoutes.unshift(merge({}, port.config.routes.rpc, {
            method: 'POST',
            path: path,
            config: {
                handler: function(req, repl) {
                    req.params.method = method;
                    req.id = 1;
                    return rpcHandler(req, repl);
                },
                auth: ((config[method].config && typeof (config[method].config.auth) === 'undefined') ? 'jwt' : config[method].config.auth),
                description: config[method].config.description || config[method].method,
                notes: (config[method].config.notes || []).concat([config[method].method + ' method definition']),
                tags: (config[method].config.tags || []).concat(tags),
                response: {
                    schema: validations[method].response,
                    failAction: (request, reply, value, error) => {
                        if (value instanceof Error) {
                            port.log.error && port.log.error(value);
                        }
                        reply(value._object);
                    }
                },
                validate: {
                    options: {abortEarly: false},
                    payload: validations[method].request.payload,
                    params: validations[method].request.params,
                    query: false
                }
            }
        }));
    };
    Object.keys(httpMethods).forEach(function(key) {
        if (key.endsWith('.routeConfig') && Array.isArray(httpMethods[key])) {
            httpMethods[key].forEach(function(routeConfig) {
                assertRouteConfig(routeConfig);
                config[routeConfig.method] = routeConfig;
                if (routeConfig.config && routeConfig.config.route) {
                    rpcRouteAdd(routeConfig.method, routeConfig.config.route, true);
                } else {
                    rpcRouteAdd(routeConfig.method, '/rpc/' + routeConfig.method.split('.').join('/'), true);
                    rpcRouteAdd(routeConfig.method, '/rpc/' + routeConfig.method);
                }
            });
        }
    });
    pendingRoutes.push({
        method: 'POST',
        path: '/file-upload',
        config: {
            payload: {
                maxBytes: 209715200, // default is 1048576 (1MB)
                output: 'stream',
                parse: true,
                allow: 'multipart/form-data'
            },
            handler: function(request, reply) {
                var file = request.payload.file;
                if (file) {
                    var fileName = (new Date()).getTime() + '_' + file.hapi.filename;
                    var path = port.bus.config.workDir + '/uploads/' + fileName;
                    var ws = fs.createWriteStream(path);
                    ws.on('error', function(err) {
                        port.log.error && port.log.error(err);
                        reply('');
                    });
                    file.pipe(ws);
                    file.on('end', function(err) {
                        if (err) {
                            port.log.error && port.log.error(err);
                            reply('');
                        } else {
                            reply(JSON.stringify({
                                filename: fileName,
                                headers: file.hapi.headers
                            }));
                        }
                    });
                } else {
                    // no file
                    reply('');
                }
            }
        }
    });
    return pendingRoutes;
};
