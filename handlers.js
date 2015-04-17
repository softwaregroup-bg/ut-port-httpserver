'use strict';

var _ = require('lodash');
var when = require('when');

module.exports = function (server, options, next) {
    var methods = {};
    var httpMethods = {};
    var pendingRoutes = [];
    options.bus.importMethods(httpMethods, options.imports);

    var rpcHandler = function (request, reply) {
        if((request.route.path !== '/rpc') || (request.route.path !== '/rpc/')){
            request.payload = {
                method: request.route.path.split('/').slice(-2).join('.'),
                jsonrpc: '2.0',
                id: '1',
                params: _.cloneDeep(request.payload)
            };
        }
        var endReply = {
            jsonrpc: '2.0',
            id: '',
            error:{code:0,message:''},
            result:undefined
        };
        if(!request.payload || !request.payload.method || !request.payload.id){
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
                options.bus.importMethods(methods, [request.payload.method])
                method = methods[request.payload.method];
            }
            request.payload.params.$$ = {authentication: request.payload.authentication};
            when(when.lift(method)(request.payload.params))
                .then(function (r) {
                    if (!r) throw new Error('Add return value of method ' + request.payload.method);
                    if (r.$$) {
                        delete r.$$;
                    }
                    if (r.authentication) {
                        delete r.authentication;
                    }
                    if(r.error){
                        endReply.error.code = r.error.code;
                        endReply.error.message = r.error.message;
                        delete r.error;
                        endReply.result = r;
                    }
                    reply(endReply);
                })
                .catch(function (erMsg) {
                    var erMs = (erMsg.$$ && erMsg.$$.errorMessage) || erMsg.message;
                    var erPr = (erMsg.$$ && erMsg.$$.errorPrint) || erMsg.errorPrint || erMs;
                    endReply.error =  {
                        code: (erMsg.$$ && erMsg.$$.errorCode) || erMsg.code || -1,
                        message: erMs,
                        errorPrint: erPr
                    }

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
    pendingRoutes.unshift({
        method: '*',
        path: '/rpc',
        config: {
            payload : {
                output:'data',
                parse: true
            },
            handler: rpcHandler
        }
    });

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
            }
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
