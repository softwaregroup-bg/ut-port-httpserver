var assign = require('lodash.assign');
var merge = require('lodash.merge');
var cloneDeep = require('lodash.clonedeep');
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
            method: joi.string().valid(routeConfig.method).required(),
            params: routeConfig.config.params.label('params').required()
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
    var validations = {};

    function addDebugInfo(msg, err) {
        err && port.config.debug || (port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.debug = err);
    }

    var rpcHandler = port.handler = function rpcHandler(request, _reply, customReply) {
        var startTime = process.hrtime();
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
        var byMethodValidate = function byMethodValidate(checkType, data) {
            var vr;
            if (checkType === 'request') {
                vr = validations[request.payload.method].request.payload.validate(request.payload);
                vr.method = 'payload';
            } else if (checkType === 'response') {
                vr = validations[request.payload.method].response.validate(data);
                vr.method = 'response';
            }
            return vr;
        };
        var doValidate = function doValidate(checkType, data) {
            if (Object.keys(validations[request.payload.method]).length === 2) {
                var validationResult = byMethodValidate(checkType, data);
                if (validationResult.error) {
                    handleError({
                        message: validationResult.error.message,
                        validation: {
                            source: validationResult.method,
                            keys: validationResult.error.details.map((k) => {
                                return k.path;
                            })
                        },
                        code: validationResult.error.name
                    });
                    return false;
                }
            } else if (!validations[request.payload.method] && !port.config.validationPassThrough) {
                handleError(errors.ValidationNotFound(`Method ${request.payload.method} not found`), _reply);
                return false;
            }
            return true;
        };

        if (!doValidate('request')) {
            return;
        }
        port.log.trace && port.log.trace({
            payload: request.payload
        });

        if (request.params.method && (!request.payload || !request.payload.jsonrpc)) {
            request.payload = {
                method: request.params.method,
                jsonrpc: '2.0',
                id: '1',
                params: cloneDeep(request.payload || {})
            };
        } else if (request.params.method && request.payload.jsonrpc) {
            if (
                (typeof request.params.method === 'string' && request.params.method !== request.payload.method) ||
                (Array.isArray(request.params.method) && (request.params.method.indexOf(request.payload.method) < 0))
            ) {
                return handleError({
                    code: '-1',
                    message: 'Invalid request method, url method and jsonRpc method should be the same',
                    errorPrint: 'Invalid request method, url method and jsonRpc method should be the same'
                });
            }
        }
        var endReply = {
            jsonrpc: '2.0',
            id: (request && request.payload && request.payload.id) || ''
        };
        if (!request.payload || !request.payload.method || !request.payload.id) {
            return handleError({
                code: '-1',
                message: (request.payload && !request.payload.id ? 'Missing request id' : 'Missing request method'),
                errorPrint: 'Invalid request!'
            });
        }

        var processMessage = function(msgOptions) {
            msgOptions = msgOptions || {};
            try {
                var $meta = {
                    auth: request.auth.credentials,
                    method: request.payload.method,
                    opcode: request.payload.method.split('.').pop(),
                    mtid: 'request',
                    requestHeaders: request.headers,
                    ipAddress: request.info && request.info.remoteAddress,
                    frontEnd: request.headers && request.headers['user-agent']
                };
                if (msgOptions.language) {
                    $meta.language = msgOptions.language;
                }
                $meta.callback = function(response) {
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
                            if (doValidate('response', endReply)) {
                                return customReply(reply, endReply, $meta);
                            }
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
                    if (typeof customReply === 'function') {
                        if (doValidate('response', response)) {
                            customReply(reply, response, $meta);
                        }
                    } else {
                        if (doValidate('response', endReply)) {
                            reply(endReply, $meta.responseHeaders, $meta.statusCode);
                        }
                    }
                    return true;
                };
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
        }
        if (
            request.payload.method === 'identity.forgottenPasswordRequest' ||
            request.payload.method === 'identity.forgottenPasswordValidate' ||
            request.payload.method === 'identity.forgottenPassword' ||
            request.payload.method === 'identity.registerRequest' ||
            request.payload.method === 'identity.registerValidate'
        ) {
            return processMessage();
        }
        port.bus.importMethod('identity.check')(
            request.payload.method === 'identity.check' ? assign({}, request.payload.params, request.auth.credentials)
                : assign({actionId: request.payload.method}, request.auth.credentials))
        .then((res) => {
            if (request.payload.method === 'identity.check') {
                endReply.result = res;
                if (res['identity.check'] && res['identity.check'].sessionId) {
                    var tz = (request.payload && request.payload.params && request.payload.params.timezone) || '+00:00';
                    return reply(endReply)
                        .state(
                            port.config.jwt.cookieKey,
                            jwt.sign({
                                timezone: tz,
                                actorId: res['identity.check'].actorId,
                                sessionId: res['identity.check'].sessionId
                            }, port.config.jwt.key),
                            port.config.cookie
                        );
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
                    return handleError({
                        code: '-1',
                        message: `Missing Permission for ${request.payload.method}`,
                        errorPrint: `Missing Permission for ${request.payload.method}`
                    });
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
        handler: rpcHandler
    }, port.config.routes.rpc));

    port.bus.importMethods(httpMethods, port.config.api);
    function rpcRouteAdd(method, path, routeConfig) {
        pendingRoutes.unshift(merge({}, port.config.routes.rpc, {
            method: 'POST',
            path: path,
            config: {
                auth: ((routeConfig.config && typeof (routeConfig.config.auth) === 'undefined') ? 'jwt' : routeConfig.config.auth),
                description: routeConfig.config.description || routeConfig.method,
                notes: (routeConfig.config.notes || []).concat([routeConfig.method + ' method definition']),
                tags: (routeConfig.config.tags || []).concat(['api', port.config.id, routeConfig.method])
            },
            handler: function(req, repl) {
                req.params.method = (routeConfig.config || {}).paramsMethod || method;
                return rpcHandler(req, repl);
            }
        }));
    };
    Object.keys(httpMethods).forEach(function(key) { // create routes for all methods
        if (key.endsWith('.routeConfig') && Array.isArray(httpMethods[key])) { // only documented methods will be added to the api
            httpMethods[key].forEach(function(routeConfig) {
                assertRouteConfig(routeConfig);
                validations[routeConfig.method] = getReqRespValidation(routeConfig);
                if (routeConfig.config && routeConfig.config.route) {
                    rpcRouteAdd(routeConfig.method, routeConfig.config.route, routeConfig);
                } else {
                    rpcRouteAdd(routeConfig.method, '/rpc/' + routeConfig.method.split('.').join('/'), routeConfig);
                    rpcRouteAdd(routeConfig.method, '/rpc/' + routeConfig.method, routeConfig);
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
