'use strict';

(function(define) {define(function(require) {
    //dependencies

    var Port = require('ut-bus/port');
    var util = require('util');
    var hapi = require('hapi');
    var when = require('when');
    var swagger = require('hapi-swagger');
    var packageJson = require('./package.json');
    var _ = require('lodash');
    var path = require('path');
    var rpcHandler;

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
        rpcHandler = require('./rpc-handler.js')(this.bus);
    };

    HttpServerPort.prototype.start = function start() {
        Port.prototype.start.apply(this, arguments);
        var self = this;
        var swaggerMethods = {};
        var connectionOoptions = {
            port: this.config.port,
            state: {
                strictHeader: !(this.config.strictCookies === false)
            }
        };
        var swaggerOptions = {
            version: packageJson.version,
            pathPrefixSize:2 //this helps extracting the namespace from the second argument of the url
        };

        self.bus.importMethods(swaggerMethods, self.config.imports);
        this.hapiServer.connection(connectionOoptions);

        this.hapiRoutes.unshift({
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

        Object.keys(swaggerMethods).forEach(function(key) {
            // create routes for all methods
            var method = swaggerMethods[key];

            if (Object.keys(method).length > 0) {//only documented methods will be added to the api
                var route = {
                    method: 'POST',
                    path: path.join('/rpc', key.split('.').join('/')),
                    handler: function (request, reply) {
                        var payload = _.cloneDeep(request.payload);
                        request.payload = {
                            method: key,
                            jsonrpc: '2.0',
                            id: '1',
                            params: payload
                        };

                        rpcHandler(request, function (result){
                            console.log(result)
                            return reply(result.result || result.error);
                        });
                    }
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
                self.hapiRoutes.unshift(route);
            }
        });

        this.hapiServer.route(this.hapiRoutes);

        var serverBootstrap = [];
        serverBootstrap.push(when.promise(function(resolve,reject){
            //register swagger
            self.hapiServer.register({
                register: swagger,
                options: swaggerOptions
            }, function(err) {
                if (err)
                    return reject({error:err, stage:'swagger loading'});
                return resolve('swagger interface loaded');
            });
        }));
        serverBootstrap.push(when.promise(function(resolve, reject){
            self.hapiServer.start(function(err) {
                if(err)
                    return reject({error:err, stage:'starting hhtp server'});

                return resolve('Http server started at http://' + ( connectionOoptions.host || '*' ) + ':' + connectionOoptions.port)
            });
        }));

        when.all(serverBootstrap)
            .then(function(res){
                console.log(res);
            })
            .catch(function(err){
                console.log(err);
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
