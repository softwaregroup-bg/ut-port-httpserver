(function(define) {define(function(require) {
    //dependencies

    var Port = require('ut-bus/port');
    var util = require('util');
    var hapi = require('hapi');
    var when = require('when');
    var swagger = require('hapi-swagger');
    var packageJson = require('./package.json');
    var _ = require('lodash');

    function HttpServerPort() {
        Port.call(this);
        this.config = {
            id: null,
            logLevel: '',
            type: 'httpserver',
            port: 8002
        };

        this.hapiServer = null;
        this.hapiRoutes = [];
    }

    util.inherits(HttpServerPort, Port);

    HttpServerPort.prototype.init = function init() {
        Port.prototype.init.apply(this, arguments);
        this.hapiServer = new hapi.Server();
        this.bus.registerLocal({'registerRequestHandler': this.registerRequestHandler.bind(this)}, 'internal');
    };

    HttpServerPort.prototype.start = function start() {
        Port.prototype.start.apply(this, arguments);
        var self = this;
        var methods = {};
        var swaggerOptions = {
            version: packageJson.version
        }
        this.hapiServer.connection({ port: this.config.port });

        var swaggerMethods = {};
        self.bus.importMethods(swaggerMethods, self.config.imports);
        var rpcHandler = function (request, reply) {
            var endReply = {
                jsonrpc: '2.0',
                id: request.payload.id,
            };

            try {
                if(!request.payload.method){
                    endReply.error = {
                        code: '-1',
                        message: 'Missing request method',
                        errorPrint: 'Invalid request!'
                    }

                    return reply(endReply);
                }

                var method = methods[request.payload.method]
                if (!method) {
                    self.bus.importMethods(methods, [request.payload.method])
                    method = methods[request.payload.method];
                }
                if(!request.payload.params){
                    request.payload.params = {};
                }
                request.payload.params.$$ = {authentication: request.payload.authentication};
                when(when.lift(method)(request.payload.params))
                    .then(function (r) {
                        if (r.$$) {
                            delete r.$$;
                        }
                        if (r.authentication) {
                            delete r.authentication;
                        }
                        endReply.result = r;
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
                    .done()
            } catch (err){
                endReply.error = {
                    code: '-1',
                    message: err.message,
                    errorPrint: err.message
                }

                return reply(endReply);
            }
        };

        this.hapiRoutes.push({
            method: 'POST',
            path: '/rpc',
            config: {
                payload : {
                    output:'data',
                    parse: true
                },
                handler: rpcHandler
            }

        });

        Object.keys(swaggerMethods).forEach(function(key) {
            // create routes for all methods
            var method = swaggerMethods[key]
            var route = {
                method: "POST",
                path: '/' + key.split('.').join('/'),
                handler: function (request, reply) {
                    var payload = _.cloneDeep(request.payload);
                    request.payload.method = key;
                    request.payload.jsonrpc = '2.0';
                    request.payload.id = '1';

                    // TODO Change this in the future
                    if (payload.username && payload.password) {
                        request.payload.authentication = {
                            username: payload.username,
                            password: payload.password
                        }
                        delete payload.username;
                        delete payload.password;
                    } else if (payload.fingerPrint) {
                        request.payload.authentication = {
                            fingerPrint: payload.fingerPrint
                        }
                        delete payload.fingerPrint;
                    } else if (payload.sessionId) {
                        request.payload.authentication = {
                            sessionId: payload.sessionId
                        }
                    }
                    // TODO END
                    request.payload.params = payload;

                    rpcHandler(request, function (result){
                        return reply(result.result || result.error);
                    })
                }
            };

            if (Object.keys(method)) {
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
            }

            this.hapiRoutes.push(route)
        });

        //TODO: delete this test
        /*this.hapiRoutes.push({
            method: "GET",
            path: '/test' ,
            config: {
                handler: function (request, reply) {
                    var method = self.bus.importMethod('temp.getTest');
                    method().then(function (res) {
                        reply(res);
                    });
                }
            }
        });*/

        this.hapiServer.route(this.hapiRoutes);

        this.hapiServer.register({
            register: swagger,
            options: swaggerOptions
        }, function(err) {
            if (err) {
                console.log('plugin swagger load error');
            } else {
                self.hapiServer.start(function() {
                    console.log('swagger interface loaded');
                });
            }
        });
    };

    HttpServerPort.prototype.registerRequestHandler = function(options){
        this.hapiRoutes.push(options);
    };

    HttpServerPort.prototype.stop = function stop() {
        this.hapiServer.stop();
        Port.prototype.stop.apply(this, arguments);
    };

    return HttpServerPort;

});}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(require); }));
