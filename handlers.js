var assign = require('lodash/object/assign');
var cloneDeep = require('lodash/lang/cloneDeep');
var when = require('when');
var fs = require('fs');
var jwt = require('jsonwebtoken');

module.exports = function(port) {
    var httpMethods = {};
    var pendingRoutes = [];

    var rpcHandler = function rpcHandler(request, _reply) {
        var startTime = process.hrtime();
        port.log.trace && port.log.trace({
            payload: request.payload
        });
        var isRPC = true;

        function addTime() {
            if (port.latency) {
                var diff = process.hrtime(startTime);
                port.latency(diff[0] * 1000 + diff[1] / 1000000, 1);
            }
        }

        var reply = function(resp, headers) {
            var _resp;
            if (!isRPC) {
                _resp = resp.result || {
                    error: resp.error
                };
            } else {
                _resp = resp;
            }
            addTime();
            var repl = _reply(_resp);
            headers && Object.keys(headers).forEach(function(header) {
                repl.header(header, headers[header]);
            });
            return repl;
        };

        function handleError(error, request, response) {
            var $meta = {};
            var msg = {
                jsonrpc: '2.0',
                id: (request.payload && request.payload.id) || '',
                error: error
            };
            response && port.config.debug || (port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.debug = response);
            if (port.config.receive instanceof Function) {
                return when(port.config.receive(msg, $meta)).then(function(result) {
                    reply(result, $meta.responseHeaders);
                });
            } else {
                return reply(msg);
            }
        };

        if (request.params.method && !request.payload.jsonrpc) {
            request.payload = {
                method: request.params.method,
                jsonrpc: '2.0',
                id: '1',
                params: cloneDeep(request.payload)
            };
            isRPC = false;
        } else if (request.params.method && request.payload.jsonrpc && request.params.method !== request.payload.method) {
            return handleError({
                code: '-1',
                message: 'Invalid request method, url method and jsonRpc method should be the same',
                errorPrint: 'Invalid request method, url method and jsonRpc method should be the same'
            }, {});
        }
        var endReply = {
            jsonrpc: '2.0',
            id: ''
        };
        if (!request.payload || !request.payload.method || !request.payload.id) {
            return handleError({
                code: '-1',
                message: (request.payload && !request.payload.id ? 'Missing request id' : 'Missing request method'),
                errorPrint: 'Invalid request!'
            }, {});
        }
        endReply.id = request.payload.id;

        var procesMessage = function(end) {
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
                // if(options.config && options.config.yar) {
                //    incMsg.$$.request = request;
                // }
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
                        return handleError(endReply.error, request, response);
                    }
                    if (response.auth) {
                        delete response.auth;
                    }

                    // todo find a better way to return static file
                    if ($meta && $meta.staticFileName) {
                        addTime();
                        _reply.file($meta.staticFileName, $meta.staticFileOptions);
                        return true;
                    }

                    if (Array.isArray(response)) {
                        endReply.resultLength = response.length;
                    }
                    endReply.result = response;
                    if (end && typeof (end) === 'function') {
                        return end(reply(endReply, $meta.responseHeaders));
                    }
                    reply(endReply, $meta.responseHeaders);
                    return true;
                };
                port.stream.write([request.payload.params || {}, $meta]);
            } catch (err) {
                return handleError({
                    code: err.code || '-1',
                    message: err.message,
                    errorPrint: err.message,
                    type: err.type
                }, request, err);
            }
        };

        if (request.payload.method === 'identity.closeSession' && request.auth && request.auth.credentials) {
            return procesMessage((repl) => {
                repl
                .state(
                    port.config.jwt.cookieKey,
                    '',
                    port.config.cookie
                );
            });
        }
        port.bus.importMethod('identity.check')(
            request.payload.method === 'identity.check' ? assign({}, request.payload.params, request.auth.credentials)
                : assign({actionId: request.payload.method}, request.auth.credentials))
        .then((res) => {
            if (request.payload.method === 'identity.check') {
                endReply.result = res;
                if (res['identity.check'] && res['identity.check'].sessionId) {
                    return reply(endReply)
                        .state(
                            port.config.jwt.cookieKey,
                            jwt.sign({
                                actorId: res['identity.check'].actorId,
                                sessionId: res['identity.check'].sessionId
                            }, port.config.jwt.key),
                            port.config.cookie
                        );
                } else {
                    return reply(endReply);
                }
            } else if (request.payload.method === 'permission.get') {
                return procesMessage();
            } else {
                if (res['permission.get'] && res['permission.get'].length) {
                    return procesMessage();
                } else {
                    return handleError({
                        code: '-1',
                        message: `Missing Pemission for ${request.payload.method}`,
                        errorPrint: `Missing Pemission for ${request.payload.method}`
                    }, {});
                }
            }
        })
        .catch((err) => (
            handleError({
                code: err.code || '-1',
                message: err.message,
                errorPrint: err.errorPrint || err.message,
                type: err.type
            }, request, err)
        ));
    };

    pendingRoutes.unshift(assign({
        handler: rpcHandler
    }, port.config.routes.rpc));

    pendingRoutes.unshift(assign({
        handler: (req, repl) => {
            req.params.method = 'identity.check';
            return rpcHandler(req, repl);
        }
    }, port.config.routes.rpc, {
        path: '/login',
        config: {
            auth: false
        }
    }));

    port.bus.importMethods(httpMethods, port.config.api);
    Object.keys(httpMethods).forEach(function(key) {
        // create routes for all methods
        var method = httpMethods[key];

        if (typeof method === 'function' && Object.keys(method).length > 0) { // only documented methods will be added to the api
            pendingRoutes.unshift({
                method: 'POST',
                path: '/rpc/' + key.split('.').join('/'),
                config: {
                    description: method.description,
                    notes: method.notes,
                    tags: method.tags,
                    validate: {
                        payload: method.params
                    },
                    response: {
                        schema: method.returns
                    }
                },
                handler: rpcHandler
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
