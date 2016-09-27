var ws = require('ws');

function SocketServer(path) {
    this.sockets = {};
    this.tokens = [];
    this.path = new RegExp(path.replace(/\{([^\}]*)\}/g, (placeHolder, label) => {
        this.tokens.push(label);
        return '(\\w+)';
    }));
    this.server = null;
    this.initialized = false;
    this.server = null;
}

SocketServer.prototype.init = function stop(server) {
    this.server = new ws.Server({
        server: server
    });
    this.server.on('connection', (socket) => {
        var label = (socket.upgradeReq.url.match(this.path) || [null]).pop();
        if (label) {
            if (!this.sockets[label]) {
                this.sockets[label] = [];
            }
            var i = this.sockets[label].length;
            this.sockets[label].push(socket);
            socket.on('close', () => {
                this.sockets[label].splice(i, 1);
            });
        } else {
            socket.terminate();
        }
    });
    this.initialized = true;
};

SocketServer.prototype.publish = function publish(params, message) {
    var label = Object.keys(params).reduce((key, cur) => {
        return key || (~this.tokens.indexOf(cur) ? params[cur] : null);
    }, null);
    if (label && this.sockets[label] && this.sockets[label].length) {
        var stringifiedMessage = JSON.stringify(message);
        this.sockets[label].forEach((socket) => {
            socket.send(stringifiedMessage);
        });
    }
};

SocketServer.prototype.stop = function stop() {
    if (this.initialized) {
        this.server.close();
    }
};

module.exports = SocketServer;
