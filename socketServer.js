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

function SocketServer() {
    this.router = new Router();
    this.handlers = {};
    this.rooms = {};
    this.wss = null;
    this.routeId = 0;
}

SocketServer.prototype.start = function start(server) {
    this.wss = new ws.Server({
        server: server,
        verifyClient: (i, cb) => {
            var context = this.router.route(i.req.method.toLowerCase(), i.req.url);
            if (context.isBoom) {
                cb(false, context.output.payload.statusCode, context.output.payload.error);
            } else {
                this.handlers[context.route].verifyClient(i, cb);
            }
        }
    });
    this.wss.on('connection', (socket) => {
        var context = this.router.route(socket.upgradeReq.method.toLowerCase(), socket.upgradeReq.url);
        this.handlers[context.route].handler(this.router.analyze(socket.upgradeReq.url).fingerprint, socket);
    });
};

SocketServer.prototype.registerPath = function registerPath(path, verifyClient, opts) {
    let id = ++this.routeId;
    this.router.add({
        method: 'get',
        path: path
    }, id);
    if (!this.handlers[id]) {
        this.handlers[id] = {};
    }
    this.handlers[id].handler = (roomId, socket) => {
        if (!this.rooms[roomId]) {
            this.rooms[roomId] = [];
        }
        var i = this.rooms[roomId].push(socket) - 1;
        socket.on('close', () => (this.rooms[roomId].splice(i, 1)));
    };
    this.handlers[id].verifyClient = (info, cb) => {
        if (verifyClient && typeof (verifyClient) === 'function') {
            verifyClient(info.req, this.router.analyze(info.req.url).fingerprint, (err) => {
                if (err) {
                    if (err.isBoom) {
                        cb(false, err.output.payload.statusCode, err.output.payload.error);
                    } else {
                        cb(false, 500, 'Internal Server Error');
                    }
                } else {
                    cb(true);
                }
            });
        } else {
            cb(true);
        }
    };
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
