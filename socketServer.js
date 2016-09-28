var ws = require('ws');
var Router = require('call').Router;
var interpolationRegex = /\{([^\}]*)\}/g;

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
        var i = this.rooms[roomId].length;
        this.rooms[roomId].push(socket);
        socket.on('close', () => {
            this.rooms[roomId].splice(i, 1);
        });
    });
};

SocketServer.prototype.publish = function publish(data, message) {
    var room = this.rooms[data.path.replace(interpolationRegex, (placeholder, label) => (data.params[label] || placeholder))];
    room.length && room.forEach((socket) => socket.send(JSON.stringify(message)));
};

SocketServer.prototype.stop = function stop() {
    this.wss.close();
};

module.exports = SocketServer;
