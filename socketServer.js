var ws = require('ws');
var Router = require('call').Router;
const Boom = require('boom');
var jwt = require('jsonwebtoken');

var interpolationRegex = /\{([^}]*)\}/g;
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
function permissionVerify(ctx, roomId) {
    let allowedList = ['%', roomId];
    let permitCount = ctx.permissions.map((v) => (v.actionId)).reduce((accum, c) => ((allowedList.includes(c) && accum + 1) || accum), 0);

    if (!(permitCount > 0)) {
        throw Boom.unauthorized();
    }
    return ctx;
}
var util = {
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

function SocketServer(httpServer) {
    this.router = new Router();
    this.rooms = {};
    this.wss = null;
    this.httpServer = httpServer;
    this.disableXsrf = (httpServer.config.disableXsrf && httpServer.config.disableXsrf.ws);
    this.disablePermissionVerify = (httpServer.config.disablePermissionVerify && httpServer.config.disablePermissionVerify.ws);
}

SocketServer.prototype.start = function start(server) {
    this.wss = new ws.Server({
        server: server
    });
    this.wss.on('connection', (socket) => {
        let cookies = (socket.upgradeReq.headers && socket.upgradeReq.headers.cookie) || '';
        let url = socket.upgradeReq.url.split('?').shift();
        let fingerprint = this.router.analyze(url).fingerprint;
        Promise.resolve()
        .then(() => (!this.disableXsrf && jwtXsrfCheck(
                getTokens([socket.upgradeReq.url.replace(/[^?]+\?/ig, '')], ['&', '=']), // parse url string into hash object
                getTokens([cookies], [';', '='])[this.httpServer.config.jwt.cookieKey], // parse cookie string into hash object
                this.httpServer.config.jwt.key,
                Object.assign({}, this.httpServer.config.jwt.verifyOptions, {ignoreExpiration: false})
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
                return permissionVerify(context, fingerprint);
            }
            return context;
        })
        .then((context) => (context.route.verifyClient(socket)))
        .then(() => {
            return this.router
                .route(socket.upgradeReq.method.toLowerCase(), url).route
                .handler(fingerprint, socket);
        })
        .catch((err) => {
            this.httpServer.log && this.httpServer.log.warn && this.httpServer.log.warn(Object.assign({connection: 'WS'}, err.output, {stack: err.stack}));
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
            var i = this.rooms[roomId].push(socket) - 1;
            socket.on('close', () => (this.rooms[roomId].splice(i, 1)));
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
        var formattedMessage = util.formatMessage(message);
        room.forEach(function(socket) {
            if (socket.readyState === ws.OPEN) {
                socket.send(formattedMessage);
            }
        });
    }
};

SocketServer.prototype.broadcast = function broadcast(message) {
    var formattedMessage = util.formatMessage(message);
    this.wss.clients.forEach(function(socket) {
        socket.send(formattedMessage);
    });
};

SocketServer.prototype.stop = function stop() {
    this.wss.close();
};

module.exports = SocketServer;
