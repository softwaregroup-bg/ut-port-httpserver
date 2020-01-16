'use strict';
const path = require('path');
const hapi = require('hapi');
const inert = require('inert');
const h2o2 = require('h2o2');
const jwt = require('hapi-auth-jwt2');
const basicAuth = require('hapi-auth-basic');
const handlers = require('./handlers');
const fs = require('fs-plus');
const SocketServer = require('ut-wss');
const uuid = require('uuid/v4');
const errorsFactory = require('./errors');
const serverRequire = require;

module.exports = ({utPort}) => class HttpServerPort extends utPort {
    constructor({config}) {
        super(...arguments);
        if (config && config.routes && config.routes.rpc && config.routes.rpc.config) {
            if (config.routes.rpc.options) {
                throw new Error('Rename routes.rpc.config to routes.rpc.options in port ' + config.id);
            } else {
                config.routes.rpc.options = config.routes.rpc.config;
                delete config.routes.rpc.config;
                this.log.warn && this.log.warn('Rename routes.rpc.config to routes.rpc.options in port ' + config.id, {
                    $meta: {
                        mtid: 'deprecation',
                        method: 'httpServerPort.constructor'
                    },
                    args: { id: config.id }
                });
            }
        }
        Object.assign(this.errors, errorsFactory(this.bus.errors));
        this.hapiServers = [];
        this.socketServers = [];
        this.socketSubscriptions = [];
        this.routes = [];
        this.stream = {};
    }
    get defaults() {
        return {
            type: 'httpserver',
            port: 8080,
            connections: [],
            namespace: [],
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
            oidc: {},
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
    }
    async init() {
        const result = await super.init(...arguments);
        this.latency = this.counter && this.counter('average', 'lt', 'Latency');
        this.bytesSent = this.counter && this.counter('counter', 'bs', 'Bytes sent', 300);
        this.bytesReceived = this.counter && this.counter('counter', 'br', 'Bytes received', 300);
        this.bus.registerLocal({
            registerRequestHandler: this.registerRequestHandler.bind(this)
        }, this.config.id);
        if (this.config.host || this.config.ingress) {
            this.config.k8s = {
                ports: [{
                    name: 'http-server',
                    service: true,
                    ingress: [].concat(this.config.ingress || {}).map(ingress => ({
                        host: this.config.host,
                        ...ingress
                    })),
                    containerPort: this.config.port
                }]
            };
        }
        return result;
    }
    async createServer(config) {
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
            h2o2
        ]);

        server.auth.strategy('jwt', 'jwt', this.merge({
            validate: () => ({isValid: true}) // errors will be matched in the rpc handler
        }, this.config.jwt));
        server.auth.default('jwt');

        server.route(this.routes);
        const utApi = this.config.swagger && await require('ut-api')({
            service: this.config.id,
            oidc: this.config.oidc,
            auth: false,
            ui: {
                ...this.config.swagger,
                services: this.config.swagger.services && (
                    () => Promise.all(this.config.swagger.services.map(name =>
                        this.bus.importMethod(name + '.service.get')({})
                            .then(result => ({namespace: name, ...result}))
                    )).catch(error => {
                        this.error(error);
                        throw error;
                    })
                )
            }
        });
        server.route(handlers(this, this.errors, utApi));

        return server;
    }
    async exec(...params) {
        let $meta = params && params.length > 1 && params[params.length - 1];
        let methodName = ($meta && $meta.method) || 'exec';
        let method = this.findHandler(methodName);
        method = method || this.methods.exec;
        if (method instanceof Function) {
            return method.apply(this, params);
        } else {
            throw this.bus.errors['bus.methodNotFound']({ params: { method: $meta && $meta.method } });
        }
    }
    async start() {
        this.bus && this.bus.attachHandlers(this.methods, this.config.imports, this);
        this.context = {requests: {}};
        this.stream = this.pull({exec: this.exec}, this.context);
        await new Promise((resolve, reject) => {
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
        });
        var servers = [];
        if (this.config.connections && this.config.connections.length) {
            servers = this.config.connections.map(connection => this.createServer(
                Object.assign({
                    port: (this.config.port == null) ? 8080 : this.config.port,
                    host: this.config.host,
                    address: this.config.address
                }, connection))
            );
        } else {
            servers = [this.createServer({
                port: (this.config.port == null) ? 8080 : this.config.port,
                host: this.config.host,
                address: this.config.address
            })];
        }
        this.hapiServers = await Promise.all(servers);
        await super.start(...arguments);
        if (this.socketSubscriptions.length) {
            this.hapiServers.forEach(server => {
                var socketServer = new SocketServer(this, this.config);
                this.socketSubscriptions.forEach(pathParams => socketServer.registerPath.apply(socketServer, pathParams));
                this.socketServers.push(socketServer);
                if (this.hapiServers.length === 1) { // @TODO: fix this.... put this here because there is no concept how to separate soc. serv. from multiple hapi servers
                    socketServer.start(this.hapiServers[0].listener);
                }
            });
        }
        await Promise.all(this.hapiServers.map(server => server.start()));
        await Promise.all(this.hapiServers.map(server => {
            server.route({
                method: 'GET',
                path: '/healthz',
                options: {
                    auth: false,
                    handler: (request, h) => ((this.isReady && 'ok') || h.response('service not available').code(503))
                }
            });
            if (this.bus.config.registry && this.config.registry !== false) {
                let info = this.server.info;
                let registryConfig = this.merge(
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
                    this.config.registry);
                registryConfig.check.http = `${registryConfig.protocol || info.protocol}://${registryConfig.address}:${registryConfig.port}/healthz`;
                return this.bus.importMethod('registry.service.add')(registryConfig);
            };
        }));
        return true;
    }
    registerRequestHandler(items) {
        items.map(handler => (handler.config && this.log.warn && this.log.warn('Rename "config" to "options" for handler ' + handler.path, {
            $meta: {
                mtid: 'deprecation',
                method: 'httpServerPort.registerRequestHandler'
            },
            args: {id: handler.path}
        })));
        if (this.hapiServers.length) {
            this.hapiServers.map(server => server.route(items));
        } else {
            Array.prototype.push.apply(this.routes, items);
        }
    }
    registerSocketSubscription(path, verifyClient, opts) {
        this.socketSubscriptions.push([path, verifyClient, opts]);
        return (params, message) =>
            this.socketServers &&
            (this.socketServers.length === 1) && // TODO: fix this... prevent pulbishing on multiple socett servers for now
            this.socketServers.map((socketServer) => socketServer.publish({path: path, params: params}, message));
    }
    enableHotReload(config) {
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
                if (!Array.isArray(config.plugins)) {
                    return reject(new Error('config.plugins must be an Array'));
                }
                let compiler = webpack(config);
                let assetsConfig = {
                    noInfo: true,
                    publicPath: config.output.publicPath,
                    stats: {
                        colors: true
                    },
                    watchOptions: {
                        aggregateTimeout: 500,
                        ignored: /(node_modules[\\/](?!(impl|ut)-)|\.git)/
                    }
                };
                if (process.platform === 'darwin') {
                    assetsConfig.watchOptions = {
                        ignored: /(node_modules[\\/](?!(impl|ut)-)|\.git)/,
                        aggregateTimeout: 1000,
                        poll: false,
                        useFsEvents: true,
                        watch: true
                    };
                } else if (process.platform !== 'win32') {
                    assetsConfig.watchOptions = {
                        ignored: /(node_modules[\\/](?!(impl|ut)-)|\.git)/,
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
                    plugin: serverRequire('./hapi-webpack-plugin'),
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
            }
        });
    }
    async stop() {
        this.socketServers && this.socketServers.map((socketServer) => socketServer.stop());
        await Promise.all(this.hapiServers.map(server => server.stop()));
        return super.stop(...arguments);
    }
    status() {
        return {
            port: this.hapiServers && this.hapiServers[0] && this.hapiServers[0].info && this.hapiServers[0].info.port
        };
    }
};
