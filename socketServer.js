var ws = require('ws');
var Router = require('call').Router;
var interpolationRegex = /\{([^}]*)\}/g;
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
}

SocketServer.prototype.start = function start(server) {
    this.wss = new ws.Server({
        server: server
    });
    this.wss.on('connection', (socket) => {
        socket.on('message', (message, raw) => {
            let jwtString = message.split('login:').pop();
            var p = new Promise((resolve, reject) => {
                var context = this.router.route(socket.upgradeReq.method.toLowerCase(), socket.upgradeReq.url);
                if (context.isBoom) {
                    throw context;
                }
                resolve(context);
            });
            p.then((context) => (context.route.verifyClient(socket, jwtString)))
            .then(() => {
                return this.router
                    .route(socket.upgradeReq.method.toLowerCase(), socket.upgradeReq.url).route
                    .handler(this.router.analyze(socket.upgradeReq.url).fingerprint, socket);
            })
            .catch((err) => {
                this.httpServer.log && this.httpServer.log.warn && this.httpServer.log.warn(Object.assign({connection: 'WS'}, err.output));
                socket.close(4000 + parseInt(err.output.payload.statusCode)); // based on https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
            });
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
        verifyClient: (socket, jwtString) => {
            return Promise.resolve()
                .then(() => {
                    if (verifyClient && typeof (verifyClient) === 'function') {
                        return verifyClient(jwtString, this.router.analyze(socket.upgradeReq.url).fingerprint);
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
