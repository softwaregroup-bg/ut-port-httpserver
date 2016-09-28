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
    var buildKey = function(url) {
        var tokens = (url.match(this.path) || []).slice(1);
        if (tokens.length) {
            return JSON.stringify(tokens.reduce((all, token, i) => {
                all[this.tokens[i]] = token;
                return all;
            }, {}));
        }
    }.bind(this);
    this.server.on('connection', (socket) => {
        var key = buildKey(socket.upgradeReq.url);
        if (key) {
            if (!this.sockets[key]) {
                this.sockets[key] = [];
            }
            var i = this.sockets[key].length;
            this.sockets[key].push(socket);
            socket.on('close', () => {
                this.sockets[key].splice(i, 1);
            });
        } else {
            socket.terminate();
        }
    });
    this.initialized = true;
};

SocketServer.prototype.publish = function publish(params, message) {
    var key;
    var msg;
    try {
        key = JSON.stringify(params);
        if (this.sockets[key] && this.sockets[key].length) {
            msg = JSON.stringify(message);
            this.sockets[key].forEach((socket) => {
                socket.send(msg);
            });
        }
    } catch (e) {

    }
};

SocketServer.prototype.stop = function stop() {
    if (this.initialized) {
        this.server.close();
    }
};

module.exports = SocketServer;
