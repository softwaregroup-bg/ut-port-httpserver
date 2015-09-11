'use strict';

var _ = require('lodash');
var when = require('when');

module.exports = function(server, options, next) {
    var httpMethods = {};
    var pendingRoutes = [];
    var imports = options.config.imports;

    options.bus.importMethods(httpMethods, imports);

    var rpcHandler = function rpcHandler(request, _reply) {
        options.log.trace && options.log.trace({payload:request.payload});
        var isRPC = true;
        var reply = function(resp) {
            var _resp;
            if (!isRPC) {
                _resp = resp.result || {error:resp.error};
            } else {
                _resp = resp;
            }
            return _reply(_resp);
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
        try {
            var incMsg = request.payload.params || {};
            incMsg.$$ = {auth: request.payload.auth, opcode: request.payload.method, mtid: 'request'};
            incMsg.$$.destination = request.payload.method.split('.').slice(0, -1).join('.');
            if(options.config && options.config.yar) {
                incMsg.$$.request = request;
            }
            incMsg.$$.callback = function(response) {
                if (!response) {
                    throw new Error('Add return value of method ' + request.payload.method);
                }
                if (!response.$$ || response.$$.mtid == 'error') {
                    var erMs = (response.$$ && response.$$.errorMessage) || response.message;
                    var erPr = (response.$$ && response.$$.errorPrint) || response.errorPrint;
                    var flEr = (response.$$ && response.$$.fieldErrors) || response.fieldErrors;
                    endReply.error =  {
                        code: (response.$$ && response.$$.errorCode) || response.code || -1,
                        message: erMs,
                        errorPrint: erPr ? erPr : erMs,
                        fieldErrors: flEr
                    };
                    return reply(endReply);
                }
                if (response.$$) {
                    delete response.$$;
                }
                if (response.auth) {
                    delete response.auth;
                }
                if (Array.isArray(response)) {
                    endReply.resultLength = response.length;
                }
                if (request.payload && request.payload.auth && request.payload.auth.session && request.payload.method == 'identity.check') {
                    endReply.session = {
                        id: request.payload.auth.session.id || null,
                        userId: request.payload.auth.userId || null,
                        language: request.payload.auth.session.language || null
                    };
                }
                endReply.result = response;
                reply(endReply);
                return true;
            };
            options.stream.write(incMsg);

        } catch (err) {
            endReply.error = {
                code: '-1',
                message: err.message,
                errorPrint: err.message
            };
            return reply(endReply);
        }
    };
    var defRpcRoute = {
        method: '*',
        path: '/rpc',
        config: {
            payload : {
                output:'data',
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
