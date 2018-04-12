'use strict';
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const joi = require('joi');
const uuid = require('uuid/v4');
const {initMetadataFromRequest} = require('./common');

const getReqRespRpcValidation = function getReqRespRpcValidation(routeConfig) {
    let request = {
        payload: routeConfig.config.payload || joi.object({
            jsonrpc: joi.string().valid('2.0').required(),
            timeout: joi.number().optional(),
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
        debug: joi.object().label('debug'),
        $meta: joi.object()
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

const isUploadValid = function isUploadValid(request, uploadConfig) {
    let file = request.payload.file;
    if (!file) {
        return false;
    }
    let fileName = file.hapi.filename;
    let isNameValid = fileName.lastIndexOf('.') > -1 && fileName.length <= uploadConfig.maxFileName;
    let uploadExtension = fileName.split('.').pop();
    let isExtensionAllowed = uploadConfig.extensionsWhiteList.indexOf(uploadExtension.toLowerCase()) > -1;
    if (file && isNameValid && isExtensionAllowed) {
        return true;
    }
    return false;
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

    function addMetaInfo(msg, $meta) {
        ($meta && port.config.debug) || ((port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.$meta = $meta));
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
    const doValidate = function doValidate(checkType, method, data) {
        if (!method) {
            throw errors.methodNotFound();
        } else if (Object.keys(validations[method] || {}).length === 2) {
            let validationResult = byMethodValidate(checkType, method, data);
            if (validationResult.error) {
                throw validationResult.error;
            }
        } else if (!validations[method] && !port.config.validationPassThrough) {
            throw errors.validationNotFound({params: {method}});
        }
    };

    let identityCheckFullName = [port.config.identityNamespace, 'check'].join('.');

    const prepareIdentityCheckParams = function prepareIdentityCheckParams(request, identityCheckFullName) {
        let identityCheckParams;
        if (request.payload.method === identityCheckFullName) {
            identityCheckParams = port.merge({}, request.payload.params);
        } else {
            identityCheckParams = {actionId: request.payload.method};
        }
        port.merge(
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

    const rpcHandler = port.handler = function rpcHandler(request, h, customReply) {
        let $meta = {};
        port.log.trace && port.log.trace({payload: request && request.payload});

        const reply = function(resp, headers, statusCode) {
            let response = h.response(resp);
            headers && Object.keys(headers).forEach(function(header) {
                response.header(header, headers[header]);
            });
            if (statusCode) {
                response.code(statusCode);
            }
            return response;
        };

        function handleError(error, response, $responseMeta) {
            let $meta = {};
            let msg = {
                jsonrpc: (request.payload && request.payload.jsonrpc) || '',
                id: (request.payload && request.payload.id) || '',
                error: error
            };
            addDebugInfo(msg, response);
            addMetaInfo(msg, $responseMeta);
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

        try {
            $meta = initMetadataFromRequest(request, port);
        } catch (error) {
            return handleError({
                code: '400',
                message: 'Validation Error',
                errorPrint: error.message
            });
        }

        let privateToken = request.auth && request.auth.credentials && request.auth.credentials.xsrfToken;
        let publicToken = request.headers && request.headers['x-xsrf-token'];
        let auth = request.route.settings && request.route.settings.auth && request.route.settings.auth.strategies;
        let routeConfig = ((config[request.params.method] || {}).config || {});

        if (!(routeConfig.disableXsrf || (port.config.disableXsrf && port.config.disableXsrf.http)) && (auth && auth.indexOf('jwt') >= 0) && (!privateToken || privateToken === '' || privateToken !== publicToken)) {
            port.log.error && port.log.error(errors.xsrfTokenMismatch());
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
        let endReply = {
            jsonrpc: request.payload.jsonrpc,
            id: (request && request.payload && request.payload.id)
        };

        const processMessage = function(msgOptions) {
            function callReply(response) {
                if (typeof customReply === 'function') {
                    return customReply(reply, response, $meta);
                } else {
                    return reply(endReply, $meta.responseHeaders, $meta.statusCode);
                }
            }
            msgOptions = msgOptions || {};
            try {
                if (msgOptions.language) {
                    $meta.language = msgOptions.language;
                }
                if (msgOptions.protection) {
                    $meta.protection = msgOptions.protection;
                }
                const callback = function(response, $responseMeta) {
                    if (response === undefined) {
                        throw new Error('Add return value of method ' + request.payload.method);
                    }
                    if (!$responseMeta || $responseMeta.mtid === 'error') {
                        let erMs = $responseMeta.errorMessage || response.message;
                        endReply.error = {
                            code: $responseMeta.errorCode || response.code || -1,
                            message: erMs,
                            errorPrint: $responseMeta.errorPrint || response.print || erMs,
                            type: $responseMeta.errorType || response.type,
                            fieldErrors: $responseMeta.fieldErrors || response.fieldErrors,
                            details: $responseMeta.details || response.details
                        };
                        if (typeof customReply === 'function') {
                            addDebugInfo(endReply, response);
                            return customReply(reply, endReply, $responseMeta);
                        }
                        return handleError(endReply.error, response, $responseMeta);
                    }
                    if (response && response.auth) {
                        delete response.auth;
                    }

                    if ($responseMeta && $responseMeta.responseAsIs) { // return response in a way that we receive it.
                        return reply(response, $responseMeta.responseHeaders);
                    }
                    if ($responseMeta && ($responseMeta.staticFileName || $responseMeta.tmpStaticFileName)) {
                        let fn = $responseMeta.staticFileName || $responseMeta.tmpStaticFileName;
                        let downloadFileName = $responseMeta.downloadFileName || fn;
                        return new Promise(function(resolve) {
                            fs.access(fn, fs.constants.R_OK, (err) => {
                                if (err) {
                                    endReply.error = {
                                        code: -1,
                                        message: 'File not found',
                                        errorPrint: 'File not found',
                                        type: $responseMeta.errorType || response.type,
                                        fieldErrors: $responseMeta.fieldErrors || response.fieldErrors
                                    };
                                    return resolve(handleError(endReply.error, response, $responseMeta));
                                } else {
                                    let s = fs.createReadStream(fn);
                                    if ($responseMeta.tmpStaticFileName) {
                                        s.on('end', () => { // cleanup, remove file after it gets send to the client
                                            process.nextTick(() => {
                                                try {
                                                    fs.unlink(fn, () => {});
                                                } catch (e) {}
                                            });
                                        });
                                    }
                                    return resolve(h.response(s)
                                        .header('Content-Type', 'application/octet-stream')
                                        .header('Content-Disposition', `attachment; filename="${path.basename(downloadFileName)}"`)
                                        .header('Content-Transfer-Encoding', 'binary'));
                                }
                            });
                        });
                    }

                    endReply.result = response;
                    addMetaInfo(endReply, $responseMeta);
                    if (msgOptions.end && typeof (msgOptions.end) === 'function') {
                        return msgOptions.end.call(undefined, reply(endReply, $responseMeta.responseHeaders));
                    }
                    return callReply(response);
                };
                if ($meta.mtid === 'request') {
                    return new Promise((resolve, reject) => {
                        $meta.reply = (response, $responseMeta) => {
                            resolve(callback(response, $responseMeta));
                        };
                        $meta.trace = request.id;
                        port.stream.push([(request.params.isRpc === false
                            ? request.payload
                            : request.payload.params) || {}, $meta]);
                    });
                } else {
                    endReply.result = true;
                    port.stream.push([(request.params.isRpc === false
                        ? request.payload
                        : request.payload.params) || {}, $meta]);
                    return callReply(true);
                }
            } catch (err) {
                return handleError({
                    code: err.code || '-1',
                    message: err.message,
                    errorPrint: err.message,
                    type: err.type
                }, err, $meta);
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

        return Promise.resolve()
            .then(() => {
                if (port.config.identityNamespace === false || (request.payload.method !== identityCheckFullName && request.route.settings.app.skipIdentityCheck === true)) {
                    return {
                        'permission.get': ['*']
                    };
                }
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
                        return handleError(errors.notPermitted({params: {method: request.payload.method}}));
                    }
                }
            })
            .catch((err) => (
                handleError({
                    code: err.code || '-1',
                    message: err.message,
                    errorPrint: err.errorPrint || err.message,
                    type: err.type
                }, err, $meta)
            ));
    };

    pendingRoutes.unshift(port.merge({
        options: {
            handler: rpcHandler,
            description: 'rpc common validation',
            tags: ['api', 'rpc'],
            validate: {
                options: {abortEarly: false},
                query: false,
                payload: value => {
                    doValidate('request', value.method, value);
                },
                params: true
            },
            response: {
                schema: (value, options) => {
                    doValidate('response', options.context.params.method || options.context.payload.method, value);
                },
                failAction: (request, h, error) => {
                    port.log.error && port.log.error(error);
                    return h.continue;
                }
            }
        }
    }, port.config.routes.rpc));
    port.bus.importMethods(httpMethods, port.config.api);

    function routeAdd(method, path, registerInSwagger) {
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
                options: {
                    response: {
                        schema: validations[method].response,
                        failAction: (request, h, error) => {
                            port.log.error && port.log.error(error);
                            return h.continue;
                        }
                    }
                }
            };
        }
        let auth = ((currentMethodConfig && typeof (currentMethodConfig.auth) === 'undefined') ? 'jwt' : currentMethodConfig.auth);
        pendingRoutes.unshift(port.merge({}, (isRpc ? port.config.routes.rpc : {}), {
            method: currentMethodConfig.httpMethod || 'POST',
            path: path,
            options: {
                handler: function(req, repl) {
                    if (!isRpc && !req.payload) {
                        req.payload = {
                            id: req.info && req.info.id,
                            jsonrpc: '2.0',
                            method,
                            params: port.merge({}, req.params, {})
                        };
                    }
                    req.params.method = method;
                    req.params.isRpc = isRpc;
                    return rpcHandler(req, repl);
                },
                app: currentMethodConfig.app,
                auth,
                description: currentMethodConfig.description || config[method].method,
                notes: (currentMethodConfig.notes || []).concat([config[method].method + ' method definition']),
                tags: (currentMethodConfig.tags || []).concat(tags),
                validate: {
                    options: {abortEarly: false},
                    payload: validations[method].request.payload,
                    params: (path.indexOf('{') >= 0) ? validations[method].request.params : undefined,
                    query: false
                }
            }
        }, responseValidation));
        return path;
    };
    let paths = [];
    Object.keys(httpMethods).forEach(function(key) {
        if (key.endsWith('.routeConfig') && Array.isArray(httpMethods[key])) {
            httpMethods[key].forEach(function(routeConfig) {
                if (routeConfig.config.isRpc === false) {
                    config[routeConfig.method] = routeConfig;
                    if (routeConfig.config.route) {
                        paths.push(routeAdd(routeConfig.method, routeConfig.config.route, true));
                    } else {
                        paths.push(routeAdd(routeConfig.method, routeConfig.method.split('.').join('/'), true));
                    }
                } else {
                    assertRouteConfig(routeConfig);
                    config[routeConfig.method] = routeConfig;
                    if (routeConfig.config && routeConfig.config.route) {
                        paths.push(routeAdd(routeConfig.method, routeConfig.config.route, true));
                    } else {
                        paths.push(routeAdd(routeConfig.method, '/rpc/' + routeConfig.method.split('.').join('/'), true));
                        paths.push(routeAdd(routeConfig.method, '/rpc/' + routeConfig.method));
                    }
                }
            });
        }
    });
    port.log.trace && port.log.trace({$meta: {mtid: 'config', opcode: 'paths'}, message: paths.sort()});
    pendingRoutes.push({
        method: 'POST',
        path: '/file-upload',
        options: {
            auth: {
                strategy: 'jwt'
            },
            payload: {
                maxBytes: port.config.fileUpload.payloadMaxBytes,
                output: 'stream',
                parse: true,
                allow: 'multipart/form-data'
            },
            handler: function(request, h) {
                return new Promise((resolve, reject) => {
                    let $meta = initMetadataFromRequest(request, port);
                    let identityCheckParams = prepareIdentityCheckParams(request, identityCheckFullName);
                    port.bus.importMethod(identityCheckFullName)(identityCheckParams, $meta).then((res) => {
                        let file = request.payload.file;
                        let isValid = isUploadValid(request, port.config.fileUpload);
                        if (!isValid) {
                            resolve(h.response('Invalid file name').code(400));
                        } else {
                            let fileName = (new Date()).getTime() + '_' + file.hapi.filename;
                            let path = port.bus.config.workDir + '/uploads/' + fileName;
                            let ws = fs.createWriteStream(path);
                            ws.on('error', function(err) {
                                port.log.error && port.log.error(err);
                                reject(err);
                            });
                            file.pipe(ws);
                            return file.on('end', function(err) {
                                if (err) {
                                    port.log.error && port.log.error(err);
                                    reject(err);
                                } else {
                                    if (file.hapi.headers['content-type'] === 'base64/png') {
                                        fs.readFile(path, (err, fileContent) => {
                                            if (err) {
                                                reject(err);
                                                return;
                                            }
                                            fileContent = fileContent.toString();
                                            let matches = fileContent.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
                                            if (matches.length === 3) {
                                                let imageBuffer = {};
                                                imageBuffer.type = matches[1];
                                                imageBuffer.data = Buffer.from(matches[2], 'base64');
                                                fileContent = imageBuffer.data;
                                                fs.writeFile(path, fileContent, (err) => {
                                                    if (err) {
                                                        reject(err);
                                                    } else {
                                                        resolve(h.response(JSON.stringify({
                                                            filename: fileName,
                                                            headers: file.hapi.headers
                                                        })));
                                                    }
                                                });
                                            } else resolve(h.response('Invalid file content').code(400));
                                        });
                                    } else {
                                        resolve(h.response(JSON.stringify({
                                            filename: fileName,
                                            headers: file.hapi.headers
                                        })));
                                    }
                                }
                            });
                        }
                        return true;
                    }).catch(err => reject(err));
                });
            }
        }
    });

    return pendingRoutes;
};
