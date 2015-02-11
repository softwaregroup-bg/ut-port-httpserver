(function(define) {define(function(require) {
    //dependencies

    var Port = require('ut-bus/port');
    var util = require('util');
    var express = require('express');
    var bodyParser = require('body-parser');
    var through2 = require('through2');

    function HttpServerPort() {
        Port.call(this);
        this.config = {
            id: null,
            logLevel: '',
            type: 'httpserver',
            port: 8002
        };
        this.expressApp = null;
        this.rpcApp = null;
        this.expressServer = null;
    }

    util.inherits(HttpServerPort, Port);

    HttpServerPort.prototype.init = function init() {
        Port.prototype.init.apply(this, arguments);
        this.expressApp = express();
        this.rpcApp = express();
    };

    HttpServerPort.prototype.start = function start() {
        Port.prototype.start.apply(this, arguments);

        this.rpcApp.use(bodyParser.json());
        var self = this;
        var methods = {};
        this.rpcApp.post('/', function(req, res) {

            if (req.body) {
                var method = methods[req.body.method]
                if (!method){
                    self.bus.importMethods(methods, [req.body.method])
                    method = methods[req.body.method];
                }
                method(req.body).then(function(r) {
                        if (r.$$) {
                            delete r.$$;
                        }
                        if (r.authentication) {
                            delete r.authentication;
                        }
                        var ress = {
                            jsonrpc:'2.0',
                            id: req.body.id,
                            result:r
                        };
                        res.json(ress);
                    },
                    function(erMsg) {
                        if (erMsg.$$ && erMsg.$$.opcode == 'login') {
                            res.status(401);
                        }
                        var erMs = erMsg.$$ ? erMsg.$$.errorMessage : erMsg.message;
                        var erPr = erMsg.$$ ? (erMsg.$$.errorPrint ? erMsg.$$.errorPrint : erMs) : erMs;
                        res.json({
                            jsonrpc:'2.0',
                            id: req.body.id,
                            error: {
                                code: erMsg.$$ ? erMsg.$$.errorCode : '-1',
                                message: erMs,
                                errorPrint: erPr
                            }
                        });
                    }
                );
            }else {
                res.status(400);
                res.json({
                    jsonrpc:'2.0',
                    id: '0',
                    error: {
                        code: '1',
                        message: 'Missing or invalid request body'
                    }
                });
            }


        });

        this.expressApp.use('/rpc', this.rpcApp);
        this.expressServer = this.expressApp.listen(this.config.port);

    };

    HttpServerPort.prototype.stop = function stop() {
        this.expressServer.close();
        Port.prototype.stop.apply(this, arguments);
    };

    return HttpServerPort;

});}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(require); }));
