'use strict';
const create = require('ut-error').define;
const HttpServer = create('httpServerPort');
module.exports = {
    HttpServer: HttpServer,
    ValidationNotFound: create('validationNotFound', 'HttpServer'),
    NotPermitted: create('notPermitted', 'HttpServer'),
    MethodNotFound: create('methodNotFound', 'HttpServer'),
    InvalidRequest: create('invalidRequest', 'HttpServer')
};
