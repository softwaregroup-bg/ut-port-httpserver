'use strict';
const path = require('path');
const util = require('util');
const hapi = require('hapi');
const inert = require('inert');
const vision = require('vision');
const jwt = require('hapi-auth-jwt2');
const basicAuth = require('hapi-auth-basic');
const swagger = require('hapi-swagger');
const packageJson = require('./package.json');
const handlers = require('./handlers');
const fs = require('fs-plus');
const SocketServer = require('ut-wss');
const uuid = require('uuid/v4');
const errorsFactory = require('./errors');
const serverRequire = require;

module.exports = function({parent}) {
    function HttpServerPort({config}) {
        parent && parent.apply(this, arguments);
        if (config && config.routes && config.routes.rpc && config.routes.rpc.config) {
            if (config.routes.rpc.options) {
                throw new Error('Rename routes.rpc.config to routes.rpc.options in port ' + config.id);
            } else {
                config.routes.rpc.options = config.routes.rpc.config;
                delete config.routes.rpc.config;
                this.log.warn && this.log.warn('Rename routes.rpc.config to routes.rpc.options in port ' + config.id);
            }
        }
        this.config = this.merge({
            id: null,
            logLevel: 'info',
            type: 'httpserver',
            port: 8080,
            connections: [],
            identityNamespace: 'identity',
            routes: {
                rpc: {
                    method: 'POST',
                    path: '/rpc/{method?}',
                    options: {
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
        }, config);
        if (this.errors) {
            Object.assign(this.errors, errorsFactory(this.defineError));
        } else {
            this.errors = errorsFactory(this.defineError);
        }
        this.hapiServers = [];
        this.socketServers = [];
        this.socketSubscriptions = [];
        this.routes = [];
        this.stream = {};
    }

    if (parent) {
        util.inherits(HttpServerPort, parent);
    }

    HttpServerPort.prototype.init = function init() {
        parent && parent.prototype.init.apply(this, arguments);
        this.latency = this.counter && this.counter('average', 'lt', 'Latency');
        this.bytesSent = this.counter && this.counter('counter', 'bs', 'Bytes sent', 300);
        this.bytesReceived = this.counter && this.counter('counter', 'br', 'Bytes received', 300);
        this.bus.registerLocal({
            registerRequestHandler: this.registerRequestHandler.bind(this)
        }, this.config.id);
    };

    HttpServerPort.prototype.createServer = async function createServer(config) {
        var server = new hapi.Server(this.merge({
            routes: {
                validate: {
                    failAction: (request, h, err) => {
                        this.log.error && this.log.error(err);
                        return err; // todo check for OWASP issues, when returning validation error details
                    }
                }
            }
        }, config));

        server.ext('onPreResponse', (request, h) => {
            if (request.response.isBoom) {
                return h.continue;
            }
            if (this.config.setSecurityHeaders) {
                if (request.response && request.response.header) {
                    request.response.header('X-Content-Type-Options', 'nosniff');
                    request.response.header('X-Frame-Options', 'SAMEORIGIN');
                    request.response.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
                }
            }
            request.response.events.on('peek', packet => {
                packet && packet.length && this.bytesSent && this.bytesSent(packet.length);
            });
            return h.continue;
        });
        server.ext('onRequest', (request, h) => {
            request.events.on('peek', packet => {
                packet && packet.length && this.bytesReceived && this.bytesReceived(packet.length);
            });
            return h.continue;
        });

        await server.register([
            basicAuth,
            jwt,
            inert,
            vision, {
                plugin: swagger,
                options: this.config.swagger
            }
        ]);

        server.auth.strategy('jwt', 'jwt', this.merge({
            validate: () => ({isValid: true}) // errors will be matched in the rpc handler
        }, this.config.jwt));
        server.auth.default('jwt');

        server.route(this.routes);
        server.route(handlers(this, this.errors));

        return server;
    };

    HttpServerPort.prototype.start = function start() {
        this.bus && this.bus.importMethods(this.config, this.config.imports, undefined, this);
        let args = Array.prototype.slice.call(arguments);
        this.context = {requests: {}};
        this.stream = this.pull(false, this.context);

        return new Promise((resolve, reject) => {
            let fileUploadTempDir = path.join(this.bus.config.workDir, 'ut-port-httpserver', 'uploads');
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
        })
            .then(() => {
                var servers = [];
                if (this.config.connections && this.config.connections.length) {
                    servers = this.config.connections.map(connection => this.createServer(
                        Object.assign({port: (this.config.port == null) ? 8080 : this.config.port}, connection))
                    );
                } else {
                    servers = [this.createServer({port: (this.config.port == null) ? 8080 : this.config.port})];
                }
                return Promise.all(servers);
            })
            .then(servers => {
                this.hapiServers = servers;
                return parent && parent.prototype.start.apply(this, args);
            })
            .then(() => {
                if (this.socketSubscriptions.length) {
                    this.hapiServers.forEach(server => {
                        var socketServer = new SocketServer(this, this.config);
                        this.socketSubscriptions.forEach(config => socketServer.registerPath.apply(socketServer, config));
                        this.socketServers.push(socketServer);
                        if (this.hapiServers.length === 1) { // @TODO: fix this.... put this here because there is no concept how to separate soc. serv. from multiple hapi servers
                            socketServer.start(this.hapiServers[0].listener);
                        }
                    });
                };
                return 0;
            })
            .then(() => Promise.all(this.hapiServers.map(server => server.start())))
            .then(() => Promise.all(this.hapiServers.map(server => {
                server.route({
                    method: 'GET',
                    path: '/health',
                    options: {
                        auth: false,
                        handler: (request, reply) => {
                            return this.isReady ? reply('ok') : reply('service not available').code(503);
                        }
                    }
                });
                if (this.bus.config.registry && this.config.registry !== false) {
                    let info = this.server.info;
                    let config = this.merge(
                    // defaults
                        {
                            name: this.bus.config.implementation,
                            address: info.host, // info.address is 0.0.0.0 so we use the host
                            port: info.port,
                            id: uuid(),
                            check: {},
                            context: {
                                type: 'http',
                                pid: process.pid
                            }
                        },
                        // custom
                        this.config.registry
                    );
                    config.check.http = `${config.protocol || info.protocol}://${config.address}:${config.port}/health`;
                    return this.bus.importMethod('registry.service.add')(config);
                };
            }))).then(() => {
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

    HttpServerPort.prototype.registerRequestHandler = function(items) {
        items.map(handler => (handler.config && this.log.warn && this.log.warn('Rename "config" to "options" for handler ' + handler.path)));
        if (this.hapiServers.length) {
            this.hapiServers.map(server => server.route(items));
        } else {
            Array.prototype.push.apply(this.routes, items);
        }
    };

    HttpServerPort.prototype.registerSocketSubscription = function(path, verifyClient, opts) {
        this.socketSubscriptions.push([path, verifyClient, opts]);
        return (params, message) =>
            this.socketServers &&
            (this.socketServers.length === 1) && // TODO: fix this... prevent publishing on multiple socket servers for now
            this.socketServers.map((socketServer) => socketServer.publish({path: path, params: params}, message)
        );
    };

    HttpServerPort.prototype.enableHotReload = function enableHotReload(config) {
        return new Promise((resolve, reject) => {
            if (this.hotReload) {
                resolve(true);
            } else if (this.config.packer && this.config.packer.name === 'webpack') {
                let webpack = serverRequire('webpack');
                if (typeof config.output !== 'object') {
                    return reject(new Error('config.output must be an Object'));
                }
                if (typeof config.output.publicPath !== 'string') {
                    return reject(new Error('config.output.publicPath must be a String'));
                }
                if (typeof config.entry !== 'object') {
                    return reject(new Error('config.entry must be an Object'));
                }
                for (let name in config.entry) {
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
                let compiler = webpack(config);
                let assetsConfig = {
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
                assetsConfig = this.merge(assetsConfig, this.config.packer.assets);
                let assets = this.merge(assetsConfig, (this.config.packer && this.config.packer.devMiddleware) || {});
                let hot = this.merge({
                    publicPath: config.output.publicPath
                }, (this.config.packer && this.config.packer.hotMiddleware) || {});

                this.hapiServers[0].register({
                    plugin: serverRequire('hapi-webpack-plugin'),
                    options: {
                        compiler,
                        assets,
                        hot
                    }
                })
                    .then(() => {
                        this.hotReload = true;
                        resolve(true);
                        return true;
                    })
                    .catch(reject);
            } else {
                // @TODO implement lasso hot reload
            }
        });
    };

    HttpServerPort.prototype.stop = function stop() {
        this.socketServers && this.socketServers.map((socketServer) => socketServer.stop());
        return Promise.all(this.hapiServers.map(server => server.stop()))
            .then(() => parent && parent.prototype.stop.call(this));
    };

    HttpServerPort.prototype.status = function status() {
        return {
            port: this.hapiServers && this.hapiServers[0] && this.hapiServers[0].info && this.hapiServers[0].info.port
        };
    };

    return HttpServerPort;
};
