var path = require('path');
var Port = require('ut-bus/port');
var util = require('util');
var hapi = require('hapi');
var inert = require('inert');
var vision = require('vision');
var jwt = require('hapi-auth-jwt2');
var basicAuth = require('hapi-auth-basic');
var when = require('when');
var _ = {
    assign: require('lodash.assign'),
    merge: require('lodash.merge'),
    isArray: require('lodash.isarray'),
    isObject: require('lodash.isobject'),
    isString: require('lodash.isstring')
};
var swagger = require('hapi-swagger');
var packageJson = require('./package.json');
var handlers = require('./handlers.js');
var through2 = require('through2');
var fs = require('fs-plus');
var SocketServer = require('./socketServer');

function HttpServerPort() {
    Port.call(this);
    this.config = {
        id: null,
        logLevel: '',
        type: 'httpserver',
        port: 8080,
        connections: [],
        routes: {
            rpc: {
                method: '*',
                path: '/rpc/{method?}',
                config: {
                    auth: 'jwt',
                    payload: {
                        output: 'data',
                        parse: true
                    }
                }
            }
        },
        cookie: {
            ttl: 100 * 60 * 1000, // expires a year from today
            encoding: 'none', // we already used JWT to encode
            isSecure: true, // warm & fuzzy feelings
            isHttpOnly: true, // prevent client alteration
            clearInvalid: false, // remove invalid cookies
            strictHeader: true // don't allow violations of RFC 6265
        },
        cookiePaths: ['/rpc'],
        swagger: {
            info: {
                version: packageJson.version
            },
            pathPrefixSize: 2 // this helps extracting the namespace from the second argument of the url
        },
        jwt: {
            cookieKey: 'ut5-cookie',
            key: 'ut5-secret',
            verifyOptions: {
                ignoreExpiration: true,
                algorithms: ['HS256']
            }
        }
    };
    this.hapiServer = {};
    this.socketServer = null;
    this.socketSubscriptions = [];
    this.routes = [];
    this.stream = {};
}

util.inherits(HttpServerPort, Port);

HttpServerPort.prototype.init = function init() {
    Port.prototype.init.apply(this, arguments);
    this.latency = this.counter && this.counter('average', 'lt', 'Latency');
    this.hapiServer = new hapi.Server();
    this.bus.registerLocal({
        registerRequestHandler: this.registerRequestHandler.bind(this)
    }, this.config.id);
};

HttpServerPort.prototype.start = function start() {
    this.bus && this.bus.importMethods(this.config, this.config.imports, undefined, this);
    Port.prototype.start.apply(this, arguments);
    this.stream = through2.obj();
    this.pipeReverse(this.stream, {
        trace: 0,
        callbacks: {}
    });

    if (this.config.connections && this.config.connections.length) {
        this.config.connections.forEach((connection) => {
            this.hapiServer.connection(connection);
        });
    } else {
        this.hapiServer.connection({
            port: this.config.port || 8080
        });
    }

    return new Promise((resolve, reject) => {
        var fileUploadTempDir = path.join(this.bus.config.workDir, 'ut-port-httpserver', 'uploads');
        fs.access(fileUploadTempDir, fs.R_OK | fs.W_OK, function(err) {
            if (err) {
                if (err.code === 'ENOENT') {
                    fs.makeTree(fileUploadTempDir, function(err) {
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
    }).then((dir) => {
        return this.hapiServer.register([
            basicAuth,
            jwt,
            inert,
            vision, {
                register: swagger,
                options: this.config.swagger
            }
        ]);
    }).then(() => {
        this.hapiServer.auth.strategy('basic', 'basic', {
            validateFunc: (request, username, password, cb) => {
                cb(null, true, {username: username, password: password});
            }
        });
        this.hapiServer.auth.strategy('jwt', 'jwt', true, _.assign({
            validateFunc: (decoded, request, cb) => (cb(null, true)) // errors will be matched in the rpc handler
        }, this.config.jwt));
        this.hapiServer.route(this.routes);
        this.hapiServer.route(handlers(this));
        if (this.socketSubscriptions.length) {
            this.socketServer = new SocketServer();
            this.socketSubscriptions.forEach((path) => this.socketServer.registerPath(path));
            this.socketServer.start(this.hapiServer.listener);
        }
        return this.hapiServer.start();
    }).then(() => {
        this.log.info && this.log.info({
            message: 'HTTP server started',
            $meta: {
                mtid: 'event',
                opcode: 'port.started'
            }
        });
        return;
    });
};

HttpServerPort.prototype.registerRequestHandler = function(handlers) {
    if (this.hapiServer.route && this.hapiServer.connections.length) {
        this.hapiServer.route(handlers);
    } else {
        Array.prototype.push.apply(this.routes, (handlers instanceof Array) ? handlers : [handlers]);
    }
};

HttpServerPort.prototype.registerSocketSubscription = function(path) {
    this.socketSubscriptions.push(path);
    return (params, message) => this.socketServer.publish({path: path, params: params}, message);
};

HttpServerPort.prototype.enableHotReload = function enableHotReload(config) {
    return when.promise((resolve, reject) => {
        if (this.hotReload) {
            resolve(true);
        } else if (this.config.packer && this.config.packer.name === 'webpack') {
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
            var assetsConfig = {
                noInfo: true,
                publicPath: config.output.publicPath,
                stats: {
                    colors: true
                }
            };
            if (process.platform !== 'win32') {
                assetsConfig.watchOptions = {
                    aggregateTimeout: 300,
                    poll: true,
                    watch: true
                };
            }
            assetsConfig = _.merge(assetsConfig, this.config.packer.assets);
            var assets = _.assign(assetsConfig, (this.config.packer && this.config.packer.devMiddleware) || {});
            var hot = _.assign({
                publicPath: config.output.publicPath
            }, (this.config.packer && this.config.packer.hotMiddleware) || {});

            this.hapiServer.register({
                register: require('hapi-webpack-plugin'),
                options: {
                    compiler,
                    assets,
                    hot
                }
            }, function(err) {
                if (err) {
                    reject(err);
                } else {
                    this.hotReload = true;
                    resolve(true);
                }
            });
        } else {
            // @TODO implement lasso hot reload
        }
    });
};

HttpServerPort.prototype.stop = function stop() {
    var self = this;
    this.socketServer && this.socketServer.stop();
    return when.promise(function(resolve, reject) {
        self.hapiServer.stop(function() {
            when(Port.prototype.stop.apply(self, arguments)).then(resolve).catch(reject);
        });
    });
};

module.exports = HttpServerPort;
