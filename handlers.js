'use strict';

var _ = require('lodash');
var when = require('when');

module.exports = function(server, options, next) {
    var methods = {};
    var httpMethods = {};
    var pendingRoutes = [];
    var imports = options.config.imports;

    options.bus.importMethods(httpMethods, imports);

    var rpcHandler = function(request, _reply) {
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

        if ((request.route.path !== '/rpc') && (request.route.path !== '/rpc/')) {
            isRPC = false;
            request.payload = {
                method: request.route.path.split('/').slice(-2).join('.'),
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
        request.payload.params = request.payload.params || {};
        endReply.id = request.payload.id;
        try {
            var method = methods[request.payload.method];

            if (!method) {
                options.bus.importMethods(methods, [request.payload.method]);
                method = methods[request.payload.method];
            }
            request.payload.params.$$ = {authentication: request.payload.authentication};
            if(options.config && options.config.hasOwnProperty('yar')) {
                request.payload.params.$$.request = request;
            }
            when(when.lift(method)(request.payload.params))
                .then(function(r) {
                    if (!r) {
                        throw new Error('Add return value of method ' + request.payload.method);
                    }
                    if (r.$$) {
                        delete r.$$;
                    }
                    if (r.authentication) {
                        delete r.authentication;
                    }
                    endReply.result = r;
                    reply(endReply);
                })
                .catch(function(erMsg) {
                    var erMs = (erMsg.$$ && erMsg.$$.errorMessage) || erMsg.message;
                    var erPr = (erMsg.$$ && erMsg.$$.errorPrint) || erMsg.errorPrint || erMs;
                    endReply.error =  {
                        code: (erMsg.$$ && erMsg.$$.errorCode) || erMsg.code || -1,
                        message: erMs,
                        errorPrint: erPr
                    };
                    //dispaly unhandled exeption before they are returned to response
                    console.dir('unhandled exeption');
                    console.dir(endReply);
                    console.dir('unhandled exeption end');
                    reply(endReply);
                })
                .done();
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
    if(options.config.handlers) {//global config for handlers
        if(options.config.handlers.rpc) {//for RPC handlers
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
