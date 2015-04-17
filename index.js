'use strict';

var Port = require('ut-bus/port');
var util = require('util');
var hapi = require('hapi');
var when = require('when');
var swagger = require('hapi-swagger');
var packageJson = require('./package.json');
var _ = require('lodash');
var handlerGenerator = require('./handlers.js');

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
    this.bus.registerLocal({'registerRequestHandler': this.registerRequestHandler.bind(this)}, 'internal');
};

HttpServerPort.prototype.start = function start() {
    Port.prototype.start.apply(this, arguments);
    var self = this;
    var httpMethods = {};
    var serverBootstrap = [];
    var connectionOptions = {
        port: this.config.port,
        state: {
            strictHeader: !(this.config.strictCookies === false)
        }
    };
    var swaggerOptions = {
        version: packageJson.version,
        pathPrefixSize:2 //this helps extracting the namespace from the second argument of the url
    };
    this.hapiServer.connection(connectionOptions);

    serverBootstrap
        .push(when.promise(function(resolve,reject){
            //register ut5 handler generator
            self.hapiServer.register({
                register: handlerGenerator,
                options: {'bus':self.bus,'imports':self.config.imports}
            }, function(err) {
                if (err)
                    return reject({error:err, stage:'rpc-generator loading'});
                return resolve('rpc-generator interface loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function(resolve,reject){
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
    serverBootstrap
        .push(when.promise(function(resolve, reject){
            self.hapiServer.start(function(err) {
                if(err)
                    return reject({error:err, stage:'starting hhtp server'});

                return resolve('Http server started at http://' + ( connectionOptions.host || '*' ) + ':' + connectionOptions.port)
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
    this.hapiServer.route(options);
};

HttpServerPort.prototype.stop = function stop() {
    this.hapiServer.stop();
    Port.prototype.stop.apply(this, arguments);
};

module.exports = HttpServerPort;


