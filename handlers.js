var path = require('path');
var mergeWith = require('lodash.mergewith');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var joi = require('joi');
var errors = require('./errors');
var uuid = require('uuid/v4');
var os = require('os');
var osName = [os.type(), os.platform(), os.release()].join(':');

var getReqRespRpcValidation = function getReqRespRpcValidation(routeConfig) {
    var request = {
        payload: routeConfig.config.payload || joi.object({
            jsonrpc: joi.string().valid('2.0').required(),
            id: joi.alternatives().try(joi.number().example(1), joi.string().example('1')).required(),
            method: joi.string().valid((routeConfig.config && routeConfig.config.paramsMethod) || routeConfig.method).required(),
            params: routeConfig.config.params.label('params').required()
        }),
        params: joi.object({
            method: joi.string().valid((routeConfig.config && routeConfig.config.paramsMethod) || routeConfig.method)
        })
    };
    var response = routeConfig.config.response || (routeConfig.config.result && joi.object({
        jsonrpc: joi.string().valid('2.0').required(),
        id: joi.alternatives().try(joi.number(), joi.string()).required(),
        result: routeConfig.config.result.label('result'),
        error: joi.object({
            code: joi.number().integer().description('Error code'),
            message: joi.string().description('Debug error message'),
            errorPrint: joi.string().optional().description('User friendly error message'),
            print: joi.string().optional().description('User friendly error message'),
            fieldErrors: joi.any().description('Field validation errors'),
            type: joi.string().description('Error type')
        }).label('error'),
        debug: joi.object().label('debug')
    })
    .xor('result', 'error'));
    return {request, response};
};

var getReqRespValidation = function getReqRespValidation(routeConfig) {
    return {
        request: {
            payload: routeConfig.config.payload,
            params: routeConfig.config.params
        },
        response: routeConfig.config.result
    };
};

var isUploadValid = function isUploadValid(request, uploadConfig) {
    var file = request.payload.file;
    if (!file) {
        return false;
    }
    var fileName = file.hapi.filename;
    var isNameValid = fileName.lastIndexOf('.') > -1 && fileName.length <= uploadConfig.maxFileName;
    var uploadExtension = fileName.split('.').pop();
    var isExtensionAllowed = uploadConfig.extensionsWhiteList.indexOf(uploadExtension.toLowerCase()) > -1;
    if (file && isNameValid && isExtensionAllowed) {
        return true;
    }
    return false;
};

var assertRouteConfig = function assertRouteConfig(routeConfig) {
    if (!routeConfig.config.params && !routeConfig.config.payload) {
        throw new Error(`Missing 'params'/'payload' in validation schema for method: ${routeConfig.method}`);
    } else if (routeConfig.config.params && !routeConfig.config.params.isJoi) {
        throw new Error(`'params' must be a joi schema object! Method: ${routeConfig.method}`);
    } else if (routeConfig.config.payload && !routeConfig.config.payload.isJoi) {
        throw new Error(`'payload' must be a joi schema object! Method: ${routeConfig.method}`);
    } else if (routeConfig.config.result && !routeConfig.config.result.isJoi) {
        throw new Error(`'result' must be a joi schema object! Method: ${routeConfig.method}`);
    } else if (routeConfig.config.response && (!routeConfig.config.response.isJoi && routeConfig.config.response !== 'stream')) {
        throw new Error(`'response' must be a joi schema object! Method: ${routeConfig.method}`);
    }
};

module.exports = function(port) {
    var httpMethods = {};
    var pendingRoutes = [];
    var config = {};
    var validations = {};

    function addDebugInfo(msg, err) {
        (err && port.config.debug) || ((port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.debug = err));
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
        if (!method) {
            next(errors.NotPermitted(`Method not defined`));
        } else if (Object.keys(validations[method] || {}).length === 2) {
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

    let identityCheckFullName = [port.config.identityNamespace, 'check'].join('.');

    var prepareIdentityCheckParams = function prepareIdentityCheckParams(request, identityCheckFullName) {
        var identityCheckParams;
        if (request.payload.method === identityCheckFullName) {
            identityCheckParams = mergeWith({}, request.payload.params);
        } else {
            identityCheckParams = { actionId: request.payload.method };
        }
        mergeWith(
            identityCheckParams,
            request.auth.credentials,
            {
                ip: (
                    (port.config.allowXFF && request.headers['x-forwarded-for'])
                        ? request.headers['x-forwarded-for']
                        : request.info.remoteAddress
                )
            }
        );
        return identityCheckParams;
    };

    var initMetadataFromRequest = function initMetadataFromRequest(request) {
        var $meta = {
            auth: request.auth.credentials,
            method: request.payload.method,
            opcode: request.payload.method ? request.payload.method.split('.').pop() : '',
            mtid: (request.payload.id == null) ? 'notification' : 'request',
            requestHeaders: request.headers,
            ipAddress: request.info && request.info.remoteAddress,
            frontEnd: request.headers && request.headers['user-agent'],
            latitude: request.headers && request.headers.latitude,
            longitude: request.headers && request.headers.longitude,
            localAddress: request.raw && request.raw.req && request.raw.req.socket && request.raw.req.socket.localAddress,
            hostName: request.headers['x-forwarded-host'] || request.info.hostname,
            localPort: request.raw && request.raw.req && request.raw.req.socket && request.raw.req.socket.localPort,
            machineName: request.connection && request.connection.info && request.connection.info.host,
            os: osName,
            version: port.bus.config.version,
            serviceName: port.bus.config.implementation,
            deviceId: request.headers && request.headers.deviceId
        };
        return $meta;
    };

    var rpcHandler = port.handler = function rpcHandler(request, _reply, customReply) {
        var startTime = process.hrtime();
        port.log.trace && port.log.trace({payload: request && request.payload});

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
                return Promise.resolve()
                    .then(() => port.config.receive(msg, $meta))
                    .then(function(result) {
                        if (typeof customReply === 'function') {
                            return customReply(reply, result, $meta);
                        }
                        return reply(result, $meta.responseHeaders, $meta.statusCode);
                    });
            } else {
                if (typeof customReply === 'function') {
                    return customReply(reply, msg, $meta);
                }
                return reply(msg);
            }
        }
        var privateToken = request.auth && request.auth.credentials && request.auth.credentials.xsrfToken;
        var publicToken = request.headers && request.headers['x-xsrf-token'];
        var auth = request.route.settings && request.route.settings.auth && request.route.settings.auth.strategies;
        var routeConfig = ((config[request.params.method] || {}).config || {});

        if (!(routeConfig.disableXsrf || (port.config.disableXsrf && port.config.disableXsrf.http)) && (auth && auth.indexOf('jwt') >= 0) && (!privateToken || privateToken === '' || privateToken !== publicToken)) {
            port.log.error && port.log.error({httpServerSecurity: 'fail', reason: 'private token != public token; cors error'});
            return handleError({
                code: '404',
                message: 'Not found',
                errorPrint: 'Not found'
            });
        }
        if (request.params && request.params.isRpc && (!request.payload || !request.payload.jsonrpc)) {
            return handleError({
                code: '-1',
                message: 'Malformed JSON RPC Request',
                errorPrint: 'Malformed JSON RPC Request'
            });
        }
        var endReply = {
            jsonrpc: request.payload.jsonrpc,
            id: (request && request.payload && request.payload.id)
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
                $meta = initMetadataFromRequest(request);
                if (msgOptions.language) {
                    $meta.language = msgOptions.language;
                }
                if (msgOptions.protection) {
                    $meta.protection = msgOptions.protection;
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

                    if ($meta && $meta.responseAsIs) { // return response in a way that we receive it.
                        return reply(response, $meta.responseHeaders);
                    }
                    if ($meta && ($meta.staticFileName || $meta.tmpStaticFileName)) {
                        let fn = $meta.staticFileName || $meta.tmpStaticFileName;
                        fs.access(fn, fs.constants.R_OK, (err) => {
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
                                var s = fs.createReadStream(fn);
                                if ($meta.tmpStaticFileName) {
                                    s.on('end', () => { // cleanup, remove file after it gets send to the client
                                        process.nextTick(() => {
                                            try {
                                                fs.unlink(fn, () => {});
                                            } catch (e) {}
                                        });
                                    });
                                }
                                _reply(s)
                                    .header('Content-Type', 'application/octet-stream')
                                    .header('Content-Disposition', `attachment; filename="${path.basename(fn)}"`)
                                    .header('Content-Transfer-Encoding', 'binary');
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

        if (port.config.identityNamespace && (request.payload.method === [port.config.identityNamespace, 'closeSession'].join('.')) && request.auth && request.auth.credentials) {
            return processMessage({
                end: (repl) => (repl.state(
                    port.config.jwt.cookieKey,
                    request.auth.token,
                    Object.assign({path: port.config.cookiePaths}, port.config.cookie, {ttl: 0})
                ))
            });
        } else if (port.config.publicMethods && port.config.publicMethods.indexOf(request.payload.method) > -1) {
            return processMessage();
        }

        Promise.resolve()
        .then(() => {
            if (port.config.identityNamespace === false || (request.payload.method !== identityCheckFullName && request.route.settings.app.skipIdentityCheck === true)) {
                return {
                    'permission.get': ['*']
                };
            }
            let $meta = initMetadataFromRequest(request);
            let identityCheckParams = prepareIdentityCheckParams(request, identityCheckFullName);
            return port.bus.importMethod(identityCheckFullName)(identityCheckParams, $meta);
        })
        .then((res) => {
            if (request.payload.method === identityCheckFullName) {
                endReply.result = res;
                var reuseCookie = () => port.config.reuseCookie && (res['identity.check'].sessionId ===
                        (request.auth &&
                        request.auth.credentials &&
                        request.auth.credentials.sessionId));
                if (res['identity.check'] && res['identity.check'].sessionId && !reuseCookie()) {
                    var appId = request.payload.params && request.payload.params.appId;
                    var tz = (request.payload && request.payload.params && request.payload.params.timezone) || '+00:00';
                    var uuId = uuid();
                    var jwtSigned = jwt.sign({
                        timezone: tz,
                        xsrfToken: uuId,
                        actorId: res['identity.check'].actorId,
                        sessionId: res['identity.check'].sessionId,
                        scopes: endReply.result['permission.get'].map((e) => ({actionId: e.actionId, objectId: e.objectId})).filter((e) => (appId && (e.actionId.indexOf(appId) === 0 || e.actionId === '%')))
                    }, port.config.jwt.key, (port.config.jwt.signOptions || {}));
                    endReply.result.jwt = {value: jwtSigned};
                    endReply.result.xsrf = {uuId};

                    return reply(endReply)
                        .state(
                            port.config.jwt.cookieKey,
                            jwtSigned,
                            Object.assign({path: port.config.cookiePaths}, port.config.cookie)
                        )
                        .state(
                            'xsrf-token',
                            uuId,
                            Object.assign({path: port.config.cookiePaths}, port.config.cookie, {isHttpOnly: false})
                        );
                } else {
                    return reply(endReply);
                }
            } else if (request.payload.method === 'permission.get') {
                return processMessage();
            } else {
                if (res['permission.get'] && res['permission.get'].length) {
                    return processMessage({
                        language: res.language,
                        protection: res.protection
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

    pendingRoutes.unshift(mergeWith({
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

    function routeAdd(method, path, registerInSwagger) {
        port.log.trace && port.log.trace({methodRegistered: method, route: path});
        var currentMethodConfig = (config[method] && config[method].config) || {};
        var isRpc = !(currentMethodConfig.isRpc === false);
        validations[method] = isRpc ? getReqRespRpcValidation(config[method]) : getReqRespValidation(config[method]);
        if (currentMethodConfig.paramsMethod) {
            currentMethodConfig.paramsMethod.reduce((prev, cur) => {
                if (!validations[cur]) {
                    validations[cur] = validations[method];
                }
            });
        }
        var tags = [port.config.id, config[method].method];
        if (registerInSwagger) {
            tags.unshift('api');
        }
        var responseValidation = {};
        if (validations[method].response) {
            responseValidation = {
                config: {
                    response: {
                        schema: validations[method].response,
                        failAction: (request, reply, value, error) => {
                            if (value instanceof Error) {
                                port.log.error && port.log.error(value);
                            }
                            reply(value._object);
                        }
                    }
                }
            };
        }
        var auth = ((currentMethodConfig && typeof (currentMethodConfig.auth) === 'undefined') ? 'jwt' : currentMethodConfig.auth);
        pendingRoutes.unshift(mergeWith({}, (isRpc ? port.config.routes.rpc : {}), {
            method: currentMethodConfig.httpMethod || 'POST',
            path: path,
            config: {
                handler: function(req, repl) {
                    req.id = 1;
                    if (!isRpc && !req.payload) {
                        req.payload = {
                            id: req.id,
                            jsonrpc: '',
                            method,
                            params: mergeWith({}, req.params, {})
                        };
                    }
                    req.params.method = method;
                    req.params.isRpc = isRpc;
                    return rpcHandler(req, repl);
                },
                auth,
                description: currentMethodConfig.description || config[method].method,
                notes: (currentMethodConfig.notes || []).concat([config[method].method + ' method definition']),
                tags: (currentMethodConfig.tags || []).concat(tags),
                validate: {
                    options: {abortEarly: false},
                    payload: validations[method].request.payload,
                    params: validations[method].request.params,
                    query: false
                }
            }
        }, responseValidation));
    };
    Object.keys(httpMethods).forEach(function(key) {
        if (key.endsWith('.routeConfig') && Array.isArray(httpMethods[key])) {
            httpMethods[key].forEach(function(routeConfig) {
                if (routeConfig.config.isRpc === false) {
                    config[routeConfig.method] = routeConfig;
                    if (routeConfig.config.route) {
                        return routeAdd(routeConfig.method, routeConfig.config.route, true);
                    } else {
                        return routeAdd(routeConfig.method, routeConfig.method.split('.').join('/'), true);
                    }
                } else {
                    assertRouteConfig(routeConfig);
                    config[routeConfig.method] = routeConfig;
                    if (routeConfig.config && routeConfig.config.route) {
                        routeAdd(routeConfig.method, routeConfig.config.route, true);
                    } else {
                        routeAdd(routeConfig.method, '/rpc/' + routeConfig.method.split('.').join('/'), true);
                        routeAdd(routeConfig.method, '/rpc/' + routeConfig.method);
                    }
                }
            });
        }
    });
    pendingRoutes.push({
        method: 'POST',
        path: '/file-upload',
        config: {
            auth: {
                strategy: 'jwt'
            },
            payload: {
                maxBytes: port.config.fileUpload.payloadMaxBytes,
                output: 'stream',
                parse: true,
                allow: 'multipart/form-data'
            },
            handler: function(request, reply) {
                Promise.resolve()
                    .then(() => {
                        let $meta = initMetadataFromRequest(request);
                        let identityCheckParams = prepareIdentityCheckParams(request, identityCheckFullName);
                        return port.bus.importMethod(identityCheckFullName)(identityCheckParams, $meta);
                    })
                    .then((res) => {
                        var file = request.payload.file;
                        var isValid = isUploadValid(request, port.config.fileUpload);
                        if (!isValid) {
                            return reply('').code(400);
                        } else {
                            var fileName = (new Date()).getTime() + '_' + file.hapi.filename;
                            var path = port.bus.config.workDir + '/uploads/' + fileName;
                            var ws = fs.createWriteStream(path);
                            ws.on('error', function(err) {
                                port.log.error && port.log.error(err);
                                reply('');
                            });
                            file.pipe(ws);
                            return file.on('end', function(err) {
                                if (err) {
                                    port.log.error && port.log.error(err);
                                    reply('');
                                } else {
                                    if (file.hapi.headers['content-type'] === 'base64/png') {
                                        fs.readFile(path, (err, fileContent) => {
                                            if (err) reply('');
                                            fileContent = fileContent.toString();
                                            var matches = fileContent.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
                                            if (matches.length === 3) {
                                                var imageBuffer = {};
                                                imageBuffer.type = matches[1];
                                                imageBuffer.data = new Buffer(matches[2], 'base64');
                                                fileContent = imageBuffer.data;
                                                fs.writeFile(path, fileContent, (err) => {
                                                    if (err) reply('');
                                                    reply(JSON.stringify({
                                                        filename: fileName,
                                                        headers: file.hapi.headers
                                                    }));
                                                });
                                            } else reply('');
                                        });
                                    } else {
                                        reply(JSON.stringify({
                                            filename: fileName,
                                            headers: file.hapi.headers
                                        }));
                                    }
                                }
                            });
                        }
                    })
                    .catch((err) => {
                        if (err) reply('').code(401);
                    });
            }
        }
    });

    return pendingRoutes;
};
