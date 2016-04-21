var create = require('ut-error').define;

var HttpServer = create('HttpServer');
module.exports = {
    HttpServer: HttpServer
};

Object.getOwnPropertyNames(module.exports).forEach(function(key) {
    var Method = module.exports[key];
    Method.reject = function() {
        return Promise.reject(new Method(arguments)); // todo improve arguments passing
    };
});
