'use strict';
var when = require('when');

module.exports = function (bus){
    var methods = {};
    return function (request, reply) {
        var endReply = {
            jsonrpc: '2.0',
            id: ''
        };
        if(!request.payload || !request.payload.method || !request.payload.id){
            endReply.error = {
                code: '-1',
                message: (request.payload && !request.payload.id ? 'Missing request id' : 'Missing request method'),
                errorPrint: 'Invalid request!'
            };
            return reply(endReply);
        }
        request.payload.params = request.payload.params || {};
        endReply.id = request.payload.id;
        try {

            var method = methods[request.payload.method];
            if (!method) {
                bus.importMethods(methods, [request.payload.method])
                method = methods[request.payload.method];
            }
            request.payload.params.$$ = {authentication: request.payload.authentication};
            when(when.lift(method)(request.payload.params))
                .then(function (r) {
                    if (!r) throw new Error('Add return value of method ' + request.payload.method);
                    if (r.$$) {
                        delete r.$$;
                    }
                    if (r.authentication) {
                        delete r.authentication;
                    }
                    endReply.result = r;
                    reply(endReply);
                })
                .catch(function (erMsg) {
                    var erMs = (erMsg.$$ && erMsg.$$.errorMessage) || erMsg.message;
                    var erPr = (erMsg.$$ && erMsg.$$.errorPrint) || erMsg.errorPrint || erMs;
                    endReply.error =  {
                        code: (erMsg.$$ && erMsg.$$.errorCode) || erMsg.code || -1,
                        message: erMs,
                        errorPrint: erPr
                    }

                    reply(endReply);
                })
                .done();
        } catch (err){
            endReply.error = {
                code: '-1',
                message: err.message,
                errorPrint: err.message
            };

            return reply(endReply);
        }
    };
};