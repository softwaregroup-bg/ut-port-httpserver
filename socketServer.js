const ws = require('ws');
const Router = require('call').Router;
const Boom = require('boom');
const jwt = require('jsonwebtoken');
const util = require('util');
const EventEmitter = require('events');

const interpolationRegex = /\{([^}]*)\}/g;
function getTokens(strs, separators) {
    if (!separators.length) {
        return {key: strs.shift(), value: strs.shift()};
    }
    var separator = separators.shift();
    return strs
        .map((s) => (getTokens(s.split(separator), separators)))
        .reduce((accum, c) => {
            if (!c.key) {
                return Object.assign(accum, c);
            }
            accum[c.key] = c.value;
            return accum;
        }, {});
}
function jwtXsrfCheck(query, cookie, hashKey, verifyOptions) {
    return new Promise((resolve, reject) => {
        if (query.xsrf === '' || !cookie || cookie === '') { // return unauthorized if something is wrong with xsrf get query param or with cookie itself
            throw Boom.unauthorized();
        }
        jwt.verify(cookie, hashKey, verifyOptions, (err, decoded) => { // verify cookie
            if (err) { // if wild error appears, mark this request as unauthorized
                return reject(Boom.unauthorized(err.name));
            }
            if (decoded.xsrfToken !== query.xsrf) { // if xsrf get param is not the same as xsrfToken from the cookie, mark this request as unauthorized
                return reject(Boom.unauthorized('Xsrf mismatch'));
            }
            resolve(decoded.scopes); // yeah we are done, on later stage will check for correct permissions
        });
    });
}
function permissionVerify(ctx, roomId, appId) {
    let allowedActionList = ['%'];
    if (appId) {
        allowedActionList.push(appId);
    }
    let allowedObjectList = ['%', roomId];
    let permitCount = ctx
        .permissions
        .filter((v) => (
          allowedActionList.includes(v.actionId) &&
          allowedObjectList.includes(v.objectId)
        )).length;

    if (!(permitCount > 0)) {
        throw Boom.unauthorized();
    }
    return ctx;
}
var helpers = {
    formatMessage: function(message) {
        var msg;
        try {
            msg = typeof message === 'string' ? message : JSON.stringify(message);
        } catch (e) {
            throw e;
        }
        return msg;
    }
};

function SocketServer(utHttpServer, config) {
    this.router = new Router();
    this.rooms = {};
    this.wss = null;
    this.utHttpServer = utHttpServer;
    this.utHttpServerConfig = config;
    this.disableXsrf = (config.disableXsrf && config.disableXsrf.ws);
    this.disablePermissionVerify = (config.disablePermissionVerify && config.disablePermissionVerify.ws);
}
util.inherits(SocketServer, EventEmitter);

SocketServer.prototype.start = function start(httpServerListener) {
    this.wss = new ws.Server({
        server: httpServerListener
    });
    this.wss.on('connection', (socket) => {
        let cookies = (socket.upgradeReq.headers && socket.upgradeReq.headers.cookie) || '';
        let url = socket.upgradeReq.url.split('?').shift();
        let fingerprint = this.router.analyze(url).fingerprint;
        Promise.resolve()
        .then(() => (!this.disableXsrf && jwtXsrfCheck(
                getTokens([socket.upgradeReq.url.replace(/[^?]+\?/ig, '')], ['&', '=']), // parse url string into hash object
                getTokens([cookies], [';', '='])[this.utHttpServerConfig.jwt.cookieKey], // parse cookie string into hash object
                this.utHttpServerConfig.jwt.key,
                Object.assign({}, this.utHttpServerConfig.jwt.verifyOptions, {ignoreExpiration: false})
            )
        ))
        .then((p) => (new Promise((resolve, reject) => {
            var context = this.router.route(socket.upgradeReq.method.toLowerCase(), url);
            if (context.isBoom) {
                throw context;
            }
            context.permissions = p;
            resolve(context);
        })))
        .then((context) => {
            if (!this.disablePermissionVerify) {
                return permissionVerify(context, fingerprint, this.utHttpServerConfig.appId);
            }
            return context;
        })
        .then((context) => (context.route.verifyClient(socket)))
        .then(() => {
            return this.router
                .route(socket.upgradeReq.method.toLowerCase(), url).route
                .handler(fingerprint, socket);
        })
        .then(() => (this.emit('connection')))
        .catch((err) => {
            if (!err.isBoom) {
                this.utHttpServer.log && this.utHttpServer.log.error && this.utHttpServer.log.error(err);
                return socket.close(4500);
            }
            this.utHttpServer.log && this.utHttpServer.log.error && this.utHttpServer.log.error(err);
            socket.close(4000 + parseInt(err.output.payload.statusCode)); // based on https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
        });
    });
};

SocketServer.prototype.registerPath = function registerPath(path, verifyClient) {
    this.router.add({
        method: 'get',
        path: path
    }, {
        handler: (roomId, socket) => {
            if (!this.rooms[roomId]) {
                this.rooms[roomId] = [];
            }
            this.rooms[roomId].push(socket);
            socket.on('close', () => {
                this.rooms[roomId] = this.rooms[roomId].filter((s) => (!(s === socket)));
            });
        },
        verifyClient: (socket) => {
            return Promise.resolve()
                .then(() => {
                    if (verifyClient && typeof (verifyClient) === 'function') {
                        return verifyClient(socket, this.router.analyze(socket.upgradeReq.url).fingerprint);
                    }
                    return 0;
                });
        }
    });
};

SocketServer.prototype.publish = function publish(data, message) {
    var room;
    try {
        room = this.rooms[data.path.replace(interpolationRegex, (placeholder, label) => (data.params[label] || placeholder))];
    } catch (e) {
        throw e;
    }
    if (room && room.length) {
        var formattedMessage = helpers.formatMessage(message);
        room.forEach(function(socket) {
            if (socket.readyState === ws.OPEN) {
                socket.send(formattedMessage);
            }
        });
    }
};

SocketServer.prototype.broadcast = function broadcast(message) {
    var formattedMessage = helpers.formatMessage(message);
    this.wss.clients.forEach(function(socket) {
        socket.send(formattedMessage);
    });
};

SocketServer.prototype.stop = function stop() {
    this.wss.close();
};

module.exports = SocketServer;
