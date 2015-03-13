(function(define) {define(function(require) {
    //dependencies

    var Port = require('ut-bus/port');
    var util = require('util');
    var hapi = require('hapi');
    var when = require('when');
    var swagger = require('hapi-swagger');
    var Joi = require('joi');
    var packageJson = require('./package.json');

    function HttpServerPort() {
        Port.call(this);
        this.config = {
            id: null,
            logLevel: '',
            type: 'httpserver',
            port: 8002
        };

        this.hapiServer = null;
    }

    util.inherits(HttpServerPort, Port);

    HttpServerPort.prototype.init = function init() {
        Port.prototype.init.apply(this, arguments);
        this.hapiServer = new hapi.Server();
    };

    HttpServerPort.prototype.start = function start() {
        Port.prototype.start.apply(this, arguments);
        var self = this;
        var methods = {};
        var swaggerOptions = {
            basePath: 'http://localhost:' + this.config.port,
            version: packageJson.version
        }
        this.hapiServer.connection({ port: this.config.port });

        var swaggerMethods = {};
        self.bus.importMethods(swaggerMethods, self.config.imports)
        var routes = [{
            method: 'POST',
            path: '/rpc',
            config: {
                payload : {
                    output:'data',
                    parse: true
                },
                handler: function (request, reply) {
                    var endReply = {
                        jsonrpc: '2.0',
                        id: request.payload.id,
                    };

                    try {
                        if(!request.payload.method){
                            return reply({
                                jsonrpc:'2.0',
                                id: request.payload.id,
                                error: {
                                    code: '-1',
                                    message: 'Missing request method',
                                    errorPrint: 'Invalid request!'
                                }
                            });
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
                        when(method(request.payload.params)).then(function (r) {
                                if (r.$$) {
                                    delete r.$$;
                                }
                                if (r.authentication) {
                                    delete r.authentication;
                                }
                                endReply.result = r;
                                reply(endReply);
                            },
                            function (erMsg) {
                                if (erMsg.$$ && erMsg.$$.opcode == 'login') {
                                    res.status(401);
                                }
                                var erMs = erMsg.$$ ? erMsg.$$.errorMessage : erMsg.message;
                                var erPr = erMsg.$$ ? (erMsg.$$.errorPrint ? erMsg.$$.errorPrint : erMs) : (erMsg.errorPrint ? erMsg.errorPrint : erMs);
                                endReply.error =  {
                                    code: erMsg.$$ ? erMsg.$$.errorCode : (erMsg.code ? erMsg.code : '-1'),
                                        message: erMs,
                                        errorPrint: erPr
                                }
                                reply(endReply);
                            }
                        );
                    } catch (err){
                        return reply({
                            jsonrpc:'2.0',
                            id: request.payload.id,
                            error: {
                                code: '-1',
                                message: err.message,
                                errorPrint: err.message
                            }
                        });
                    }
                }
            }

        }];

        Object.keys(swaggerMethods).forEach(function(key) {
            // create routes for all methods
            var method = swaggerMethods[key]
            var route = {
                method: "POST",
                path: '/' + key.split('.').join('/'),
                handler: function (request, reply) {
                    reply(this.path);
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

            routes.push(route)
        })

        //TODO: delete this test
        routes.push({
            method: "GET",
            path: '/test' ,
            config: {
                handler: function (request, reply) {
                    reply(routes);
                }
            }
        })

        this.hapiServer.route(routes);

        //this.hapiServer.start();

        this.hapiServer.register({
            register: swagger,
            options: swaggerOptions
        }, function(err) {
            if (err) {
                console.log('plugin swagger load error');
            } else {
                self.hapiServer.start(function() {
                    console.log('swagger interface loaded');
                })
            }
        })
    };

    HttpServerPort.prototype.stop = function stop() {
        this.hapiServer.stop();
        Port.prototype.stop.apply(this, arguments);
    };

    return HttpServerPort;

});}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(require); }));
