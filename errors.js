'use strict';
module.exports = create => {
    const HttpServer = create('httpServerPort');
    return {
        HttpServer: HttpServer,
        ValidationNotFound: create('validationNotFound', HttpServer),
        NotPermitted: create('notPermitted', HttpServer),
        MethodNotFound: create('methodNotFound', HttpServer),
        InvalidRequest: create('invalidRequest', HttpServer)
    };
};
