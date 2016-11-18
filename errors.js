var create = require('ut-error').define;

var HttpServer = create('HttpServer');
var ValidationNotFound = create('ValidationNotFound', 'HttpServer');
var InvalidRequest = create('InvalidRequest', 'HttpServer');
module.exports = {
    HttpServer: HttpServer,
    ValidationNotFound: ValidationNotFound,
    InvalidRequest: InvalidRequest
};

Object.getOwnPropertyNames(module.exports).forEach(function(key) {
    var Method = module.exports[key];
    Method.reject = function() {
        return Promise.reject(new Method(arguments)); // todo improve arguments passing
    };
});
