'use strict';
const os = require('os');
const osName = [os.type(), os.platform(), os.release()].join(':');

module.exports = {
    initMetadataFromRequest
};

function initMetadataFromRequest(request = {}, bus = {}) {
    return {
        auth: request.auth.credentials,
        method: request.payload && request.payload.method,
        opcode: request.payload && request.payload.method ? request.payload.method.split('.').pop() : '',
        mtid: (request.payload && request.payload.id == null) ? 'notification' : 'request',
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
        serviceName: bus.config && bus.config.implementation,
        deviceId: request.headers && request.headers.deviceId,
        tenantId: request.tenantId,
        subdomain: request.subdomain,
        channel: request.channel || (request.auth.credentials || {}).channel,
        language: (request.auth.credentials || {}).language,
        ...(request.$metaInfo || {})
    };
}
