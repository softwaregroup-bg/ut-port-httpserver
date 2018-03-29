'use strict';
module.exports = create => {
    const HttpServer = create('httpServerPort');
    return {
        validationNotFound: create('validationNotFound', HttpServer, 'Validation for method {method} not found'),
        notPermitted: create('notPermitted', HttpServer, 'Missing Permission for {method}'),
        xsrfTokenMismatch: create('xsrfTokenMismatch', HttpServer, 'private token != public token; cors error'),
        methodNotFound: create('methodNotFound', HttpServer, 'Method not found')
    };
};
