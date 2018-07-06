'use strict';
const os = require('os');
const joi = require('joi');
const osName = [os.type(), os.platform(), os.release()].join(':');

const metaSchema = joi.object().keys({
    timeout: joi.array().length(2).items(joi.number().min(0).integer()).optional().allow(null),
    auth: joi.object().keys({
        actorId: joi.number().positive().integer(),
        exp: joi.number().positive().integer(),
        iat: joi.number().positive().integer(),
        scopes: joi.array(),
        sessionId: joi.string().max(36),
        timezone: joi.string(),
        xsrfToken: joi.string().max(36)
    }).allow(null),
    method: joi.string().max(100),
    opcode: joi.string().allow(''),
    mtid: joi.string(),
    requestHeaders: joi.object(),
    ipAddress: joi.string().max(50),
    frontEnd: joi.string().max(250),
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
        timeout: port.timing && request.payload.timeout && port.timing.after(request.payload.timeout),
        auth: request.auth.credentials,
        method: request.payload && request.payload.method,
        opcode: request.payload && request.payload.method ? request.payload.method.split('.').pop() : '',
        mtid: (request.payload && request.payload.id) ? 'notification' : 'request',
        requestHeaders: request.headers,
        ipAddress: ((request.headers && request.headers['x-forwarded-for']) || request.info.remoteAddress).split(',')[0],
        frontEnd: request.headers && request.headers['user-agent'],
        latitude: request.headers && request.headers.latitude,
        longitude: request.headers && request.headers.longitude,
        localAddress: request.raw && request.raw.req && request.raw.req.socket && request.raw.req.socket.localAddress,
        hostName: (request.headers && request.headers['x-forwarded-host']) || request.info.hostname,
        localPort: request.raw && request.raw.req && request.raw.req.socket && request.raw.req.socket.localPort,
        machineName: request.connection && request.connection.info && request.connection.info.host,
        os: osName,
        version: bus.config && bus.config.version,
        serviceName: bus.config && (bus.config.implementation + (bus.config.service ? '/' + bus.config.service : '')),
        deviceId: request.headers && request.headers.deviceId
    }, {abortEarly: false});

    if (error) {
        throw error;
    }
    port && port.setTimer && port.setTimer(value);
    return value;
}

module.exports = {
    initMetadataFromRequest
};
