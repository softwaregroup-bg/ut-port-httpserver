(function(define) {define(function(require) {
    //dependencies

    var Port = require('ut-bus/port');
    var util = require('util');
    var hapi = require('hapi');
    var swagger = require('hapi-swagger');

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
            basePath: 'http://localhost:' + this.config.port
        }
        this.hapiServer.connection({ port: this.config.port });

        this.hapiServer.route({
            method: 'POST',
            path: '/rpc',
            config: {
                payload : {
                    output:'data',
                    parse: true
                },
                handler: function (request, reply) {
                    try {
                        var method = methods[request.payload.method]
                        if (!method) {
                            self.bus.importMethods(methods, [request.payload.method])
                            method = methods[request.payload.method];
                        }
                        method(request.payload).then(function (r) {
                                if (r.$$) {
                                    delete r.$$;
                                }
                                if (r.authentication) {
                                    delete r.authentication;
                                }
                                var ress = {
                                    jsonrpc: '2.0',
                                    id: request.payload.id,
                                    result: r
                                };
                                reply(ress);
                            },
                            function (erMsg) {
                                if (erMsg.$$ && erMsg.$$.opcode == 'login') {
                                    res.status(401);
                                }
                                var erMs = erMsg.$$ ? erMsg.$$.errorMessage : erMsg.message;
                                var erPr = erMsg.$$ ? (erMsg.$$.errorPrint ? erMsg.$$.errorPrint : erMs) : (erMsg.errorPrint ? erMsg.errorPrint : erMs);
                                reply({
                                    jsonrpc: '2.0',
                                    id: request.payload.id,
                                    error: {
                                        code: erMsg.$$ ? erMsg.$$.errorCode : (erMsg.code ? erMsg.code : '-1'),
                                        message: erMs,
                                        errorPrint: erPr
                                    }
                                });
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
                },
                tags: ['api']
            }

        });

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
