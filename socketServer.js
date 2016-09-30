var ws = require('ws');
var Router = require('call').Router;
var interpolationRegex = /\{([^\}]*)\}/g;
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
    this.rooms = {};
    this.wss = null;
}

SocketServer.prototype.start = function start(server) {
    this.wss = new ws.Server({
        server: server
    });
    this.wss.on('connection', (socket) => {
        var context = this.router.route(socket.upgradeReq.method.toLowerCase(), socket.upgradeReq.url);
        context.isBoom ? socket.terminate() : context.route(this.router.analyze(socket.upgradeReq.url).fingerprint, socket);
    });
};

SocketServer.prototype.registerPath = function registerPath(path) {
    this.router.add({
        method: 'get',
        path: path
    }, (roomId, socket) => {
        if (!this.rooms[roomId]) {
            this.rooms[roomId] = [];
        }
        var i = this.rooms[roomId].push(socket) - 1;
        socket.on('close', () => this.rooms[roomId].splice(i, 1));
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
