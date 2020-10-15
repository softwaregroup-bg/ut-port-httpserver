'use strict';
const path = require('path');
const mergeWith = require('lodash.mergewith');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const joi = require('joi');
const uuid = require('uuid/v4');

const common= require('./common');
const initMetadataFromRequest = common.initMetadataFromRequest;

const getReqRespRpcValidation = function getReqRespRpcValidation(routeConfig) {
    let request = {
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
    let response = routeConfig.config.response || (routeConfig.config.result && joi.object({
        jsonrpc: joi.string().valid('2.0').required(),
        id: joi.alternatives().try(joi.number(), joi.string()).required(),
        result: routeConfig.config.result.label('result'),
        error: joi.object({
            code: joi.number().integer().description('Error code'),
            message: joi.string().description('Debug error message'),
            errorPrint: joi.string().optional().description('User friendly error message'),
            print: joi.string().optional().description('User friendly error message'),
            fieldErrors: joi.any().description('Field validation errors'),
            details: joi.object().optional().description('Error udf details'),
            type: joi.string().description('Error type')
        }).label('error'),
        debug: joi.object().label('debug')
    })
    .xor('result', 'error'));
    return {request, response};
};

const getReqRespValidation = function getReqRespValidation(routeConfig) {
    return {
        request: {
            payload: routeConfig.config.payload,
            params: routeConfig.config.params
        },
        response: routeConfig.config.result
    };
};

const assertRouteConfig = function assertRouteConfig(routeConfig) {
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

module.exports = function(port, errors) {
    let httpMethods = {};
    let pendingRoutes = [];
    let config = {};
    let validations = {};

    function addDebugInfo(msg, err) {
        (err && port.config.debug) || ((port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.debug = err));
    }

    const byMethodValidate = function byMethodValidate(checkType, method, data) {
        let vr;
        if (checkType === 'request') {
            vr = validations[method].request.payload.validate(data);
            vr.method = 'payload';
        } else if (checkType === 'response') {
            vr = validations[method].response.validate(data);
            vr.method = 'response';
        }
        return vr;
    };
    const doValidate = function doValidate(checkType, method, data, next) {
        if (!method) {
            next(errors.NotPermitted(`Method not defined`));
        } else if (Object.keys(validations[method] || {}).length === 2) {
            let validationResult = byMethodValidate(checkType, method, data);
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

    const prepareIdentityCheckParams = common.prepareIdentityCheckParamsFunc(port);

    const rpcHandler = port.handler = function rpcHandler(request, _reply, customReply) {
        port.log.trace && port.log.trace({payload: request && request.payload});

        const reply = function(resp, headers, statusCode) {
            let repl = _reply(resp);
            headers && Object.keys(headers).forEach(function(header) {
                repl.header(header, headers[header]);
            });
            if (statusCode) {
                repl.code(statusCode);
            }
            return repl;
        };

        function handleError(error, response) {
            let $meta = {};
            let msg = {
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
        let privateToken = request.auth && request.auth.credentials && request.auth.credentials.xsrfToken;
        let publicToken = request.headers && request.headers['x-xsrf-token'];
        let auth = request.route.settings && request.route.settings.auth && request.route.settings.auth.strategies;
        let routeConfig = ((config[request.params.method] || {}).config || {});

        if (!(routeConfig.disableXsrf || (port.config.disableXsrf && port.config.disableXsrf.http)) && (auth && auth.indexOf('jwt') >= 0) && (!privateToken || privateToken === '' || privateToken !== publicToken)) {
            port.log.error && port.log.error({httpServerSecurity: 'fail', reason: 'private token != public token; cors error'});
            return handleError({
                statusCode: 401,
                error: 'Unauthorized',
                message: 'Invalid token',
                attributes: {
                    error: 'Invalid token'
                }
            });
        }
        if (request.params && request.params.isRpc && (!request.payload || !request.payload.jsonrpc)) {
            return handleError({
                code: '-1',
                message: 'Malformed JSON RPC Request',
                errorPrint: 'Malformed JSON RPC Request'
            });
        }
        let endReply = {
            jsonrpc: request.payload.jsonrpc,
            id: (request && request.payload && request.payload.id)
        };

        const processMessage = function(msgOptions) {
            let $meta;
            function callReply(response) {
                if (typeof customReply === 'function') {
                    customReply(reply, response, $meta);
                } else {
                    reply(endReply, $meta.responseHeaders, $meta.statusCode);
                }
            }
            msgOptions = msgOptions || {};
            try {
                $meta = initMetadataFromRequest(request, port.bus);
                if (msgOptions.language) {
                    $meta.language = msgOptions.language;
                }
                if (msgOptions.protection) {
                    $meta.protection = msgOptions.protection;
                }
                const callback = function(response) {
                    if (response === undefined) {
                        throw new Error('Add return value of method ' + request.payload.method);
                    }
                    if (!$meta || $meta.mtid === 'error') {
                        let erMs = $meta.errorMessage || response.message;
                        endReply.error = {
                            code: $meta.errorCode || response.code || -1,
                            message: erMs,
                            errorPrint: $meta.errorPrint || response.print || erMs,
                            type: $meta.errorType || response.type,
                            fieldErrors: $meta.fieldErrors || response.fieldErrors,
                            details: $meta.details || response.details
                        };
                        if (typeof customReply === 'function') {
                            addDebugInfo(endReply, response);
                            return customReply(reply, endReply, $meta);
                        }
                        return handleError(endReply.error, response);
                    }
                    if (response && response.auth) {
                        delete response.auth;
                    }

                    if ($meta && $meta.responseAsIs) { // return response in a way that we receive it.
                        return reply(response, $meta.responseHeaders);
                    }
                    if ($meta && ($meta.staticFileName || $meta.tmpStaticFileName)) {
                        let fn = $meta.staticFileName || $meta.tmpStaticFileName;
                        fs.access(fn, fs.constants.R_OK, (err) => {
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
                                let s = fs.createReadStream(fn);
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
                    $meta.reply = callback;
                    $meta.trace = request.id;
                } else {
                    endReply.result = true;
                    callReply(true);
                }
                port.stream.push([request.payload.params || {}, $meta]);
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
            let $meta = initMetadataFromRequest(request, port.bus);
            let identityCheckParams = prepareIdentityCheckParams(request, identityCheckFullName);
            return port.bus.importMethod(identityCheckFullName)(identityCheckParams, $meta);
        })
        .then((res) => {
            if (request.payload.method === identityCheckFullName) {
                endReply.result = res;
                const reuseCookie = () => port.config.reuseCookie && (res['identity.check'].sessionId ===
                        (request.auth &&
                        request.auth.credentials &&
                        request.auth.credentials.sessionId));
                if (res['identity.check'] && res['identity.check'].sessionId && !reuseCookie()) {
                    let appId = request.payload.params && request.payload.params.appId;
                    let tz = (request.payload && request.payload.params && request.payload.params.timezone) || '+00:00';
                    let uuId = uuid();
                    let jwtSigned = jwt.sign({
                        timezone: tz,
                        xsrfToken: uuId,
                        actorId: res['identity.check'].actorId,
                        sessionId: res['identity.check'].sessionId,
                        channel: res['identity.check'].channel,
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
        let currentMethodConfig = (config[method] && config[method].config) || {};
        let isRpc = !(currentMethodConfig.isRpc === false);
        validations[method] = isRpc ? getReqRespRpcValidation(config[method]) : getReqRespValidation(config[method]);
        if (currentMethodConfig.paramsMethod) {
            currentMethodConfig.paramsMethod.reduce((prev, cur) => {
                if (!validations[cur]) {
                    validations[cur] = validations[method];
                }
            });
        }
        let tags = [port.config.id, config[method].method];
        if (registerInSwagger) {
            tags.unshift('api');
        }
        let responseValidation = {};
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
        let auth = ((currentMethodConfig && typeof (currentMethodConfig.auth) === 'undefined') ? 'jwt' : currentMethodConfig.auth);
        pendingRoutes.unshift(mergeWith({}, (isRpc ? port.config.routes.rpc : {}), {
            method: currentMethodConfig.httpMethod || 'POST',
            path: path,
            config: {
                handler: function(req, repl) {
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
    // pendingRoutes.push(common.uploadFile({
    //     port: port,
    //     config: port.config.fileUpload,
    //     urlPath: '/file-upload',
    //     uploadPath: '/uploads/'
    // }));

    return pendingRoutes;
};
