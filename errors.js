'use strict';
module.exports = ({defineError, getError, fetchErrors}) => {
    if (!getError('httpServerPort')) {
        const HttpServer = defineError('httpServerPort', undefined, 'HTTP server generic');

        defineError('validationNotFound', HttpServer, 'Validation for method {method} not found');
        defineError('notPermitted', HttpServer, 'Missing Permission for {method}');
        defineError('xsrfTokenMismatch', HttpServer, 'private token != public token; cors error');
        defineError('methodNotFound', HttpServer, 'Method not found');
    }

    return fetchErrors('httpServerPort');
};
