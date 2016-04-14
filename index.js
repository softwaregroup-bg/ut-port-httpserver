'use strict';

var Port = require('ut-bus/port');
var util = require('util');
var hapi = require('hapi');
var Inert = require('inert');
var Vision = require('vision');
var when = require('when');
var _ = {
    assign: require('lodash/object/assign'),
    isArray: require('lodash/lang/isArray'),
    isObject: require('lodash/lang/isObject'),
    isString: require('lodash/lang/isString')
};
var swagger = require('hapi-swagger');
var packageJson = require('./package.json');
var handlerGenerator = require('./handlers.js');
var through2 = require('through2');
var fs = require('fs');

function HttpServerPort() {
    Port.call(this);
    this.config = {
        id: null,
        logLevel: '',
        type: 'httpserver',
        port: 8002,
        ports: [],
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
    this.latency = this.counter && this.counter('average', 'lt', 'Latency');
    this.hapiServer = new hapi.Server();
    this.bus.registerLocal({registerRequestHandler: this.registerRequestHandler.bind(this)}, this.config.id);
};

HttpServerPort.prototype.start = function start() {
    this.bus && this.bus.importMethods(this.config, this.config.imports, undefined, this);
    Port.prototype.start.apply(this, arguments);
    this.stream = through2.obj();
    this.pipeReverse(this.stream, {trace: 0, callbacks: {}});

    var self = this;
    var serverBootstrap = [];
    var ports = this.config.ports;
    var httpProp = {host: this.config.host};

    if (!ports || (ports.length < 1)) {
        ports = [this.config.port];
    }

    var swaggerOptions = {
        version: packageJson.version,
        pathPrefixSize: 2 // this helps extracting the namespace from the second argument of the url
    };

    if (this.config.server) {
        _.assign(httpProp, this.config.server);
    }

    if (this.config.swagger) {
        _.assign(swaggerOptions, this.config.swagger);
    }

    for (var i = 0, portsLen = ports.length; i < portsLen; i = i + 1) {
        this.hapiServer.connection(Object.assign({}, httpProp, {port: ports[i]}));
    }
    this.hapiServer.register([Inert, Vision], function() {
    });
    this.hapiServer.route(this.routes);
    serverBootstrap
        .push(when.promise(function(resolve, reject) {
            // register ut5 handlers
            self.hapiServer.register({
                register: handlerGenerator,
                options: self
            }, function(err) {
                if (err) {
                    return reject({error: err, stage: 'ut5 handlers loading..'});
                }
                return resolve('rpc-generator interface loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function(resolve, reject) {
            // register swagger
            self.hapiServer.register({
                register: swagger,
                options: swaggerOptions
            }, function(err) {
                if (err) {
                    return reject({error: err, stage: 'swagger loading'});
                }
                return resolve('swagger interface loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function(resolve, reject) {
            if (!self.config.hasOwnProperty('yar')) {
                resolve('yar not enabled');
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
            }, function(err) {
                if (err) {
                    return reject({error: err, stage: 'http-auth-cookie loading'});
                }
                return resolve('yar loaded');
            });
        }));
    serverBootstrap
        .push(when.promise(function(resolve, reject) {
            self.hapiServer.start(function(err) {
                if (err) {
                    return reject({error: err, stage: 'starting hhtp server'});
                }
                return resolve('Http server started at http://' + (httpProp.host || '*') + ':[' + ports.join(',') + ']');
            });
        }));
    serverBootstrap
        .push(when.promise(function(resolve, reject) {
            var fileUploadTempDir = self.bus.config.workDir + '/uploads';
            fs.access(fileUploadTempDir, fs.R_OK | fs.W_OK, function(err) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        fs.mkdir(fileUploadTempDir, function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve('Temp dir for file uploads has been created: ' + fileUploadTempDir);
                            }
                        });
                    } else {
                        reject(err);
                    }
                } else {
                    resolve('Temp dir for file uploads has been verified: ' + fileUploadTempDir);
                }
            });
        }));
    return when.all(serverBootstrap).then(function(result) {
        self.log.info && self.log.info({message: result, $meta: {opcode: 'port.started'}});
    });
};

HttpServerPort.prototype.registerRequestHandler = function(handlers) {
    if (this.hapiServer.route && this.hapiServer.connections.length) {
        this.hapiServer.route(handlers);
    } else {
        Array.prototype.push.apply(this.routes, (handlers instanceof Array) ? handlers : [handlers]);
    }
};

HttpServerPort.prototype.enableHotReload = function enableHotReload(config) {
    var self = this;
    return when.promise(function(resolve, reject) {
        if (self.hotReload) {
            resolve(true);
        } else if (self.config.packer === 'webpack') {
            var webpack = require('webpack');
            if (!_.isObject(config.output)) {
                return reject(new Error('config.output must be an Object'));
            }
            if (!_.isString(config.output.publicPath)) {
                return reject(new Error('config.output.publicPath must be a String'));
            }
            if (!_.isObject(config.entry)) {
                return reject(new Error('config.entry must be an Object'));
            }
            for (var name in config.entry) {
                if (config.entry.hasOwnProperty(name)) {
                    if (!_.isArray(config.entry[name])) {
                        return reject(new Error(config.entry[name] + ' should be an Array'));
                    }
                    config.entry[name].unshift('webpack-hot-middleware/client');
                }
            }
            if (!_.isArray(config.plugins)) {
                return reject(new Error('config.plugins must be an Array'));
            }
            config.plugins.push(new webpack.HotModuleReplacementPlugin());
            var compiler = webpack(config);
            var assets = {
                noInfo: true,
                publicPath: config.output.publicPath,
                stats: {
                    colors: true
                }/*,
                watchOptions: {
                    aggregateTimeout: 300,
                    poll: true,
                    watch: true
                }*/
            };
            var hot = {publicPath: config.output.publicPath};
            self.hapiServer.register({
                register: require('hapi-webpack-plugin'),
                options: {compiler, assets, hot}
            }, function(err) {
                if (err) {
                    reject(err);
                } else {
                  self.hotReload = true;
                  resolve(true);
                }
            });
        } else {
            // imlement lasso hot reload
        }
    });
};

HttpServerPort.prototype.stop = function stop() {
    var self = this;
    return when.promise(function(resolve, reject) {
        self.hapiServer.stop(function() {
            when(Port.prototype.stop.apply(self, arguments)).then(resolve).catch(reject);
        });
    });
};

module.exports = HttpServerPort;
