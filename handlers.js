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
            var headers = [];
            if (!isRPC) {
                _resp = resp.result || {error:resp.error};
                if (resp.headers) {
                    headers = resp.headers;
                }
            } else {
                _resp = resp;
            }
            var repl = _reply(_resp);
            for (var i = 0; i < headers.length; i++) {
                var header = headers[i];
                if (header.key && header.value) {
                    repl.header(header.key, header.value);
                }
            }
            return repl;
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
        endReply.id = request.payload.id;
        try {
            var incMsg = request.payload.params || {};
            incMsg.$$ = {auth: request.payload.auth, opcode: request.payload.method, mtid: 'request'};
            var methodData = request.payload.method.split(".");
            incMsg.$$.destination = methodData[0];
            incMsg.$$.callback = function(response){
                if (!response) {
                    throw new Error('Add return value of method ' + request.payload.method);
                }
                if(!response.$$ || response.$$.mtid == 'error'){
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
                if(Array.isArray(response)){
                    endReply.resultLength = response.length;
                }
                if (response.session) {
                    endReply.session = response.session;
                    delete response.session;
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
