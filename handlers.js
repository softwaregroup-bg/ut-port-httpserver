'use strict';

var _ = require('lodash');
var when = require('when');

module.exports = function(server, options, next) {
    var httpMethods = {};
    var pendingRoutes = [];
    var imports = options.config.imports;

    options.bus.importMethods(httpMethods, imports);
    var checkPermission = options.bus.config && options.bus.config.checkPermission;

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

        var reply = function(resp) {
            var _resp;
            var headers = [];
            if (!isRPC) {
                _resp = resp.result || {error: resp.error};
                if (resp.headers) {
                    headers = Object.keys(resp.headers);
                }
            } else {
                _resp = resp;
            }
            addTime();
            var repl = _reply(_resp);
            for (var i = 0; i < headers.length; i += 1) {
                repl.header(headers[i], resp.headers[headers[i]]);
            }
            return repl;
        };
        var pathComponents = request.route.path.split('/').filter(function(x) {// normalize array
            // '/rpc' ---> ['', 'rpc'] , '/rpc/' ---> ['', 'rpc', '']
            return x !== '';
        });
        if (pathComponents.length > 1 && pathComponents[0] === 'rpc') {
            isRPC = false;
            request.payload = {
                method: pathComponents.slice(1).join('.'),
                jsonrpc: '2.0',
                id: '1',
                params: _.cloneDeep(request.payload)
            };
        }
        var endReply = {
            jsonrpc: '2.0',
            id: ''
        };
        if (!request.payload || !request.payload.method || !request.payload.id) {
            endReply.error = {
                code: '-1',
                message: (request.payload && !request.payload.id ? 'Missing request id' : 'Missing request method'),
                errorPrint: 'Invalid request!'
            };
            return reply(endReply);
        }
        endReply.id = request.payload.id;

        var procesMessage = function() {
            try {
                var $meta = {
                    auth: request.payload.auth,
                    method: request.payload.method,
                    opcode: request.payload.method.split('.').pop(),
                    destination: request.payload.method.split('.').slice(0, -1).join('.'),
                    mtid: 'request',
                    session: request.session && request.session.get('session')
                };
                //if(options.config && options.config.yar) {
                //    incMsg.$$.request = request;
                //}
                $meta.callback = function(response) {
                    if (!response) {
                        throw new Error('Add return value of method ' + request.payload.method);
                    }
                    if (!$meta || $meta.mtid === 'error') {
                        var erMs = $meta.errorMessage || response.message;
                        var erPr = $meta.errorPrint || response.errorPrint;
                        var flEr = $meta.fieldErrors || response.fieldErrors;
                        endReply.error = {
                            code: $meta.errorCode || response.code || -1,
                            message: erMs,
                            errorPrint: erPr ? erPr : erMs,
                            fieldErrors: flEr
                        };
                        return reply(endReply);
                    }
                    if (response.auth) {
                        delete response.auth;
                    }

                    //todo find a better way to return static file
                    if ($meta && $meta.staticFileName) {
                        addTime();
                        _reply.file($meta.staticFileName);
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
                        request.session.set('session', response);
                    }
                    endReply.result = response;
                    reply(endReply);
                    return true;
                };
                options.stream.write([request.payload.params || {}, $meta]);

            } catch (err) {
                endReply.error = {
                    code: '-1',
                    message: err.message,
                    errorPrint: err.message
                };
                return reply(endReply);
            }
        };
        if (checkPermission && request.payload.method !== 'identity.check') {
            when(options.bus.importMethod('permission.check')(request.session.get('session'), request.payload.method))
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
                    endReply.error = {
                        code: err.code || '-1',
                        message: err.message,
                        errorPrint: err.errorPrint || err.message
                    };
                    return reply(endReply);
                })
                .done();
        } else {
            return procesMessage();
        }
    };
    var defRpcRoute = {
        method: '*',
        path: '/rpc',
        config: {
            payload: {
                output: 'data',
                parse: true
            },
            handler: rpcHandler
        }
    };
    if (options.config.handlers) {//global config for handlers
        if (options.config.handlers.rpc) {//for RPC handlers
            //merge config with default handler only, because we can set per handler when is used with swagger
            _.assign(defRpcRoute.config, options.config.handlers.rpc);
        }
    }
    pendingRoutes.unshift(defRpcRoute);

    Object.keys(httpMethods).forEach(function(key) {
        // create routes for all methods
        var method = httpMethods[key];

        if (Object.keys(method).length > 0) {//only documented methods will be added to the api
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

    server.route(pendingRoutes);
    return next();
};
module.exports.attributes = {
    name: 'ut-route-generato',
    version: '0.0.1'
};
