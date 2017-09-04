var path = require('path');
var Port = require('ut-bus/port');
var util = require('util');
var hapi = require('hapi');
var inert = require('inert');
var vision = require('vision');
var jwt = require('hapi-auth-jwt2');
var basicAuth = require('hapi-auth-basic');
var mergeWith = require('lodash.mergewith');
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
        identityNamespace: 'identity',
        routes: {
            rpc: {
                method: 'POST',
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
        publicMethods: [
            'identity.forgottenPasswordRequest',
            'identity.forgottenPasswordValidate',
            'identity.forgottenPassword',
            'identity.registerRequest',
            'identity.registerValidate'
        ],
        cookie: {
            ttl: 100 * 60 * 1000, // expires a year from today
            encoding: 'none', // we already used JWT to encode
            isSecure: true, // warm & fuzzy feelings
            isHttpOnly: true, // prevent client alteration
            clearInvalid: false, // remove invalid cookies
            strictHeader: true // don't allow violations of RFC 6265
        },
        cookiePaths: '/rpc',
        disableXsrf: {http: false, ws: false}, // disable xsrf support for http and ws(web sockets)
        disablePermissionVerify: {ws: false}, // disable verification of services, eg pass requests without checks
        setSecurityHeaders: false,
        fileUpload: {
            maxFileName: 100,
            payloadMaxBytes: 5242880, // 5 MB. Default is 1048576 (1MB)
            extensionsWhiteList: ['pdf', 'doc', 'docx', 'xls', 'txt', 'jpg', 'jpeg', 'png']
        },
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
            },
            signOptions: {
                expiresIn: '1h',
                algorithm: 'HS256'
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
    var args = Array.prototype.slice.call(arguments);
    this.stream = through2.obj();
    this.pipeReverse(this.stream, {
        trace: 0,
        callbacks: {}
    });

    if (this.config.connections && this.config.connections.length) {
        this.config.connections.forEach((connection) => {
            this.hapiServer.connection(Object.assign({port: (this.config.port == null) ? 8080 : this.config.port}, connection));
        });
    } else {
        this.hapiServer.connection({
            port: (this.config.port == null) ? 8080 : this.config.port
        });
    }

    if (this.config.setSecurityHeaders) {
        this.hapiServer.ext('onPreResponse', function(request, reply) {
            if (request.response && request.response.header) {
                request.response.header('X-Content-Type-Options', 'nosniff');
                request.response.header('X-Frame-Options', 'SAMEORIGIN');
                request.response.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            }
            return reply.continue();
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
        return new Promise((resolve, reject) => {
            this.hapiServer.register([
                basicAuth,
                jwt,
                inert,
                vision, {
                    register: swagger,
                    options: this.config.swagger
                }
            ], (e) => (e ? reject(e) : resolve()));
        });
    })
    .then(() => {
        this.hapiServer.auth.strategy('basic', 'basic', {
            validateFunc: (request, username, password, cb) => {
                cb(null, true, {username: username, password: password});
            }
        });
        this.hapiServer.auth.strategy('jwt', 'jwt', true, mergeWith({
            validateFunc: (decoded, request, cb) => (cb(null, true)) // errors will be matched in the rpc handler
        }, this.config.jwt));
        return 0;
    })
    .then(() => {
        this.hapiServer.route(this.routes);
        this.hapiServer.route(handlers(this));
        return 0;
    })
    .then(() => Port.prototype.start.apply(this, args))
    .then(() => {
        if (this.socketSubscriptions.length) {
            this.socketServer = new SocketServer(this, this.config);
            this.socketSubscriptions.forEach((config) => this.socketServer.registerPath.apply(this.socketServer, config));
            this.socketServer.start(this.hapiServer.listener);
        }
        return 0;
    })
    .then(() => new Promise((resolve, reject) => {
        this.hapiServer.start((e) => {
            if (e) {
                return reject(e);
            } else if (this.bus.config.registry && this.config.registry !== false) {
                this.hapiServer.route({
                    method: 'GET',
                    path: '/health',
                    config: {
                        auth: false,
                        handler: (request, reply) => {
                            return this.isReady ? reply('ok') : reply('service not available').code(503);
                        }
                    }
                });
                let info = this.hapiServer.info;
                let config = mergeWith(
                    // defaults
                    {
                        name: this.bus.config.implementation,
                        address: info.host, // info.address is 0.0.0.0 so we use the host
                        port: info.port,
                        context: {
                            type: 'http'
                        },
                        check: {
                            interval: '10s'
                        }
                    },
                    // custom
                    this.config.registry,
                    // override
                    {
                        check: {
                            http: `${info.protocol}://${info.host}:${info.port}/health`
                        }
                    }
                );
                return this.bus.importMethod('registry.service.add')(config)
                    .then(resolve)
                    .catch(reject);
            }
            return resolve();
        });
    }))
    .then(() => {
        this.log.info && this.log.info({
            message: 'HTTP server started',
            $meta: {
                mtid: 'event',
                opcode: 'port.started'
            }
        });
        return true;
    });
};

HttpServerPort.prototype.registerRequestHandler = function(handlers) {
    if (this.hapiServer.route && this.hapiServer.connections.length) {
        this.hapiServer.route(handlers);
    } else {
        Array.prototype.push.apply(this.routes, (handlers instanceof Array) ? handlers : [handlers]);
    }
};

HttpServerPort.prototype.registerSocketSubscription = function(path, verifyClient, opts) {
    this.socketSubscriptions.push([path, verifyClient, opts]);
    return (params, message) => this.socketServer.publish({path: path, params: params}, message);
};

HttpServerPort.prototype.enableHotReload = function enableHotReload(config) {
    return new Promise((resolve, reject) => {
        if (this.hotReload) {
            resolve(true);
        } else if (this.config.packer && this.config.packer.name === 'webpack') {
            var webpack = require('webpack');
            if (typeof config.output !== 'object') {
                return reject(new Error('config.output must be an Object'));
            }
            if (typeof config.output.publicPath !== 'string') {
                return reject(new Error('config.output.publicPath must be a String'));
            }
            if (typeof config.entry !== 'object') {
                return reject(new Error('config.entry must be an Object'));
            }
            for (var name in config.entry) {
                if (config.entry.hasOwnProperty(name) && name !== 'vendor') {
                    if (!Array.isArray(config.entry[name])) {
                        return reject(new Error(config.entry[name] + ' should be an Array'));
                    }
                    (config.entry[name].indexOf('webpack-hot-middleware/client') < 0) && config.entry[name].unshift('webpack-hot-middleware/client');
                    (config.entry[name].indexOf('react-hot-loader/patch') < 0) && config.entry[name].unshift('react-hot-loader/patch');
                }
            }
            if (!Array.isArray(config.plugins)) {
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
            if (process.platform === 'darwin') {
                assetsConfig.watchOptions = {
                    aggregateTimeout: 1000,
                    poll: false,
                    useFsEvents: true,
                    watch: true
                };
            } else if (process.platform !== 'win32') {
                assetsConfig.watchOptions = {
                    aggregateTimeout: 300,
                    poll: true,
                    watch: true
                };
            }
            assetsConfig = mergeWith(assetsConfig, this.config.packer.assets);
            var assets = mergeWith(assetsConfig, (this.config.packer && this.config.packer.devMiddleware) || {});
            var hot = mergeWith({
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
    this.socketServer && this.socketServer.stop();
    return new Promise((resolve, reject) => {
        this.hapiServer.stop((err) => {
            return err ? reject(err) : Promise.resolve()
                .then(() => Port.prototype.stop.call(this))
                .then(resolve)
                .catch(reject);
        });
    });
};

HttpServerPort.prototype.status = function status() {
    return {
        port: this.hapiServer.info && this.hapiServer.info.port
    };
};

module.exports = HttpServerPort;
