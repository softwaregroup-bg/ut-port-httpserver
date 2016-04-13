'use strict';

var assign = require('lodash/object/assign');
var cloneDeep = require('lodash/lang/cloneDeep');
var when = require('when');
var fs = require('fs');

module.exports = function(server, options, next) {
    var httpMethods = {};
    var pendingRoutes = [];
    var imports = options.config.api;

    options.bus.importMethods(httpMethods, imports);
    var checkPermission = (options.config && options.config.checkPermission) || (options.bus.config && options.bus.config.checkPermission);

    var rpcHandler = function rpcHandler(request, _reply) {
        var startTime = process.hrtime();
        if (request.payload && request.payload.method === 'identity.closeSession') {
            request.session.reset();
        }
        options.log.trace && options.log.trace({payload: request.payload});
        var isRPC = true;

        function addTime() {
            if (options.latency) {
                var diff = process.hrtime(startTime);
                options.latency(diff[0] * 1000 + diff[1] / 1000000, 1);
            }
        }

        var reply = function(resp, headers) {
            var _resp;
            if (!isRPC) {
                _resp = resp.result || {error: resp.error};
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
            response && options.config.debug || (options.config.debug == null && options.bus.config && options.bus.config.debug) && (msg.debug = response);
            if (options.config.receive instanceof Function) {
                return when(options.config.receive(msg, $meta)).then(function(result) {
                    reply(result, $meta.responseHeaders);
                });
            } else {
                return reply(msg);
            }
        };

        var pathComponents = request.route.path.split('/').filter(function(x) { // normalize array
            // '/rpc' ---> ['', 'rpc'] , '/rpc/' ---> ['', 'rpc', '']
            return x !== '';
        });
        if (pathComponents.length > 1 && pathComponents[0] === 'rpc' && !request.payload.jsonrpc) {
            request.payload = {
                method: pathComponents.slice(1).join('.'),
                jsonrpc: '2.0',
                id: '1',
                params: cloneDeep(request.payload)
            };
            isRPC = false;
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

        var procesMessage = function() {
            try {
                var $meta = {
                    auth: request.payload.auth,
                    method: request.payload.method,
                    opcode: request.payload.method.split('.').pop(),
                    mtid: 'request',
                    requestHeaders: request.headers,
                    session: request.session && request.session.get('session')
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
                    if (request.payload && request.payload.auth && request.payload.auth.session && request.payload.method === 'identity.check') {
                        endReply.session = {
                            id: (response && response.session && response.session.id) || null,
                            userId: (response && response.userId) || null,
                            language: (response && response.session && response.session.language) || 'en'
                        };
                        delete response.userId;
                        delete response.session;
                    }
                    if (request.payload && request.payload.params && request.payload.params.sessionData && request.payload.method === 'identity.check') {
                        response.remoteAddress = request.info.remoteAddress;
                        request.session.set('session', response);
                    }
                    endReply.result = response;
                    reply(endReply, $meta.responseHeaders);
                    return true;
                };
                options.stream.write([request.payload.params || {}, $meta]);
            } catch (err) {
                return handleError({
                    code: '-1',
                    message: err.message,
                    errorPrint: err.message
                }, request, err);
            }
        };
        if (checkPermission && request.payload.method !== 'identity.check' && request.payload.method !== 'permission.check') {
            when(options.bus.importMethod('permission.check')(request.payload.method, {session: request.session.get('session')}))
                .then(function(permissions) {
                    if (request.session) {
                        var session = request.session.get('session');
                        if (session) {
                            session.permissions = permissions;
                            request.session.set('session', session);
                        }
                    }
                    return permissions;
                })
                .then(procesMessage)
                .catch(function(err) {
                    if (err.permissions) {
                        if (request.session) {
                            var session = request.session.get('session');
                            if (session) {
                                session.permissions = err.permissions;
                                request.session.set('session', session);
                            }
                        }
                    }
                    return handleError({
                        code: err.code || '-1',
                        message: err.message,
                        errorPrint: err.errorPrint || err.message
                    }, request, err);
                })
                .done();
        } else {
            return procesMessage();
        }
    };
    var defRpcRoute = {
        method: '*',
        path: '/rpc/{method?}',
        config: {
            payload: {
                output: 'data',
                parse: true
            },
            handler: rpcHandler
        }
    };
    if (options.config.handlers) { // global config for handlers
        if (options.config.handlers.rpc) { // for RPC handlers
            // merge config with default handler only, because we can set per handler when is used with swagger
            assign(defRpcRoute.config, options.config.handlers.rpc);
        }
    }
    pendingRoutes.unshift(defRpcRoute);

    Object.keys(httpMethods).forEach(function(key) {
        // create routes for all methods
        var method = httpMethods[key];

        if (typeof method === 'function' && Object.keys(method).length > 0) { // only documented methods will be added to the api
            var route = {
                method: 'POST',
                path: '/rpc/' + key.split('.').join('/'),
                handler: rpcHandler
            };

            route.config = {
                description: method.description,
                notes: method.notes,
                tags: method.tags,
                validate: {
                    payload: method.params
                },
                response: {
                    schema: method.returns
                }
            };
            pendingRoutes.unshift(route);
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
                    var path = options.bus.config.workDir + '/uploads/' + fileName;
                    var ws = fs.createWriteStream(path);
                    ws.on('error', function(err) {
                        options.log.error && options.log.error(err);
                        reply('');
                    });
                    file.pipe(ws);
                    file.on('end', function(err) {
                        if (err) {
                            options.log.error && options.log.error(err);
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
    server.route(pendingRoutes);
    return next();
};
module.exports.attributes = {
    name: 'ut-route-generato',
    version: '0.0.1'
};
