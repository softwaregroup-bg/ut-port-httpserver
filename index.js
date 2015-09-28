'use strict';

var Port = require('ut-bus/port');
var util = require('util');
var hapi = require('hapi');
var Inert = require('inert');
var Vision = require('vision');
var when = require('when');
var _ = require('lodash');
var swagger = require('hapi-swagger');
var packageJson = require('./package.json');
var handlerGenerator = require('./handlers.js');
var through2 = require('through2');

function HttpServerPort() {
    Port.call(this);
    this.config = {
        id: null,
        logLevel: '',
        type: 'httpserver',
        port: 8002,
        server: undefined,
        handlers: undefined
    };

    this.hapiServer = {};
    this.routes = [];
    this.stream = {};
}

util.inherits(HttpServerPort, Port);

HttpServerPort.prototype.init = function init() {
    Port.prototype.init.apply(this, arguments);
    this.hapiServer = new hapi.Server();
    this.bus.registerLocal({'registerRequestHandler': this.registerRequestHandler.bind(this)}, 'internal');
};

HttpServerPort.prototype.start = function start() {
    Port.prototype.start.apply(this, arguments);
    this.stream = through2.obj();
    this.pipeReverse(this.stream, {trace: 0, callbacks: {}});

    var self = this;
    var serverBootstrap = [];
    var httpProp = {
        'port': this.config.port,
        'host': this.config.host
    };

    var swaggerOptions = {
        version: packageJson.version,
        pathPrefixSize: 2 //this helps extracting the namespace from the second argument of the url
    };

    if (this.config.server) {
        _.assign(httpProp, this.config.server);
    }

    if (this.config.swagger) {
        _.assign(swaggerOptions, this.config.swagger);
    }

    this.hapiServer.connection(httpProp);
    this.hapiServer.register([Inert, Vision], function () {});
    this.hapiServer.route(this.routes);
    serverBootstrap
        .push(when.promise(function (resolve, reject) {
            //register ut5 handlers
            self.hapiServer.register({
                register: handlerGenerator,
                options: {
                    'bus': self.bus,
                    'log': self.log,
                    'config': self.config,
                    stream: self.stream
                }
            }, function (err) {
                if (err) {
                    return reject({error: err, stage: 'ut5 handlers loading..'});
                }
                return resolve('rpc-generator interface loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function (resolve, reject) {
            //register swagger
            self.hapiServer.register({
                register: swagger,
                options: swaggerOptions
            }, function (err) {
                if (err) {
                    return reject({error: err, stage: 'swagger loading'});
                }
                return resolve('swagger interface loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function (resolve, reject) {
            if (!self.config.hasOwnProperty('yar')) {
                return;
            }
            var yarConfig = self.config.yar || {};
            if (!yarConfig.hasOwnProperty('maxCookieSize')) {
                yarConfig.maxCookieSize = 0;
            }
            yarConfig.cookieOptions = yarConfig.cookieOptions || {};
            if (!yarConfig.cookieOptions.password) {
                yarConfig.cookieOptions.password = 'secret';
            }
            self.hapiServer.register({
                register: require('yar'),
                options: yarConfig
            }, function (err) {
                if (err) {
                    return reject({error: err, stage: 'http-auth-cookie loading'});
                }
                return resolve('yar loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function (resolve, reject) {
            self.hapiServer.start(function (err) {
                if (err) {
                    return reject({error: err, stage: 'starting hhtp server'});
                }
                return resolve('Http server started at http://' + (httpProp.host || '*') + ':' + httpProp.port);
            });
        }));

    when.all(serverBootstrap)
        .then(function (res) {
            console.log(res);
        })
        .catch(function (err) {
            console.log(err);
        });
};

HttpServerPort.prototype.registerRequestHandler = function (handlers) {
    if (this.hapiServer.route && this.hapiServer.connections.length) {
        this.hapiServer.route(handlers);
    } else {
        Array.prototype.push.apply(this.routes, (handlers instanceof Array) ? handlers : [handlers])
    }
};

HttpServerPort.prototype.stop = function stop() {
    this.hapiServer.stop();
    Port.prototype.stop.apply(this, arguments);
};

module.exports = HttpServerPort;
