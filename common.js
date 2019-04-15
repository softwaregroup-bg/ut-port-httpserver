'use strict';
const os = require('os');
const joi = require('joi');
const osName = [os.type(), os.platform(), os.release()].join(':');

const metaSchema = joi.object().keys({
    timeout: joi.number().positive(),
    auth: joi.object().keys({
        actorId: joi.number().positive().integer(),
        exp: joi.number().positive().integer(),
        iat: joi.number().positive().integer(),
        scopes: joi.array(),
        sessionId: joi.string().max(36),
        timezone: joi.string(),
        channel: joi.string(),
        xsrfToken: joi.string().max(36)
    }).allow(null),
    method: joi.string().max(100),
    opcode: joi.string().allow(''),
    mtid: joi.string(),
    requestHeaders: joi.object(),
    forward: joi.object().keys({
        'x-request-id': joi.string(),
        'x-b3-traceid': joi.string(),
        'x-b3-spanid': joi.string(),
        'x-b3-parentspanid': joi.string(),
        'x-b3-sampled': joi.string(),
        'x-b3-flags': joi.string(),
        'x-ot-span-context': joi.string()
    }),
    ipAddress: joi.string().max(50),
    frontEnd: joi.string().max(250).allow('', null),
    latitude: joi.number(),
    longitude: joi.number(),
    localAddress: joi.string().max(50),
    hostName: joi.string().max(50),
    localPort: joi.number(),
    machineName: joi.string().max(50),
    os: joi.string().max(50),
    version: joi.string(),
    serviceName: joi.string().max(50),
    deviceId: joi.string().max(50)
});

function initMetadataFromRequest(request = {}, port = {}) {
    let bus = port.bus || {};
    const {error, value} = metaSchema.validate({
        forward: ['x-request-id', 'x-b3-traceid', 'x-b3-spanid', 'x-b3-parentspanid', 'x-b3-sampled', 'x-b3-flags', 'x-ot-span-context']
            .reduce(function(object, key) {
                var value = request.headers[key];
                if (value !== undefined) object[key] = value;
                return object;
            }, {}),
        timeout: port.timing && request.payload.timeout,
        auth: request.auth.credentials,
        method: request.payload && request.payload.method,
        opcode: request.payload && request.payload.method ? request.payload.method.split('.').pop() : '',
        mtid: (request.payload && !request.payload.id) ? 'notification' : 'request',
        requestHeaders: request.headers,
        ipAddress: ((port.config && port.config.allowXFF && request.headers && request.headers['x-forwarded-for']) || request.info.remoteAddress).split(',')[0],
        frontEnd: request.headers && request.headers['user-agent'],
        latitude: request.headers && request.headers.latitude,
        longitude: request.headers && request.headers.longitude,
        localAddress: request.raw && request.raw.req && request.raw.req.socket && request.raw.req.socket.localAddress,
        hostName: (request.headers && request.headers['x-forwarded-host']) || request.info.hostname,
        localPort: request.raw && request.raw.req && request.raw.req.socket && request.raw.req.socket.localPort,
        machineName: request.server && request.server.info && request.server.info.host,
        os: osName,
        version: bus.config && bus.config.version,
        serviceName: bus.config && (bus.config.implementation + (bus.config.service ? '/' + bus.config.service : '')),
        deviceId: request.headers && request.headers.deviceId
    }, {abortEarly: false});

    if (error) {
        throw error;
    }
    if (value.timeout != null) value.timeout = port.timing.after(value.timeout);

    value.method && port && port.setTimer && port.setTimer(value);
    return value;
}

module.exports = {
    initMetadataFromRequest
};
