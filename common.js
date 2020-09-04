'use strict';
const os = require('os');
const osName = [os.type(), os.platform(), os.release()].join(':');
const uuid = require('uuid/v4');
const Content = require('content');
const mergeWith = require('lodash.mergewith');
const path = require('path');
const fs = require('fs');

module.exports = {
    initMetadataFromRequest,
    prepareIdentityCheckParamsFunc,
    uploadFile: function (config) {
        try {
            const port = config.port;
            const prepareIdentityCheckParams = prepareIdentityCheckParamsFunc(port);
            const maliciousFileValidate = maliciousFileValidateFunc(config.config);
            const identityCheckFullName = [port.config.identityNamespace, 'check'].join('.');
            return {
                method: 'POST',
                path: config.urlPath,
                config: {
                    auth: 'jwt',
                    cors: true,
                    payload: {
                        maxBytes: config.config.payloadMaxBytes,
                        output: 'stream',
                        allow: 'multipart/form-data'
                    },
                    handler: function(request, reply) {
                        Promise.resolve().then(() => {
                            var $meta = initMetadataFromRequest(request, port.bus);
                            var identityCheckParams = prepareIdentityCheckParams(request, identityCheckFullName);
                            return port.bus.importMethod(identityCheckFullName)(identityCheckParams, $meta);
                        }).then(async function(identity) {
                            var file = request.payload[config.hapiFileProp];
                            if (!file) {
                                file = request.payload.file;
                            }
                            const fileInfo = {
                                filename: await maliciousFileValidate(request, port, identity.person.actorId, config.hapiFileProp),
                                headers: {}
                            };
                            const uploadPath = path.join(port.bus.config.workDir, config.uploadPath, fileInfo.filename);
                            const fileStream = fs.createWriteStream(uploadPath);
                            file.on('error', err => {
                                reply({error: err}).code(400);
                            });
                            file.pipe(fileStream);
                            file.on('end', async function(err) {
                                if (err) {
                                    return reply({error: err}).code(400);
                                }
                                await port.bus.importMethod('document.maxNumberPerActor.add')({
                                    actorId: identity.person.actorId,
                                    filePath: fileInfo.filename,
                                    size: request.headers['content-length']
                                });
                                reply(JSON.stringify((fileInfo)))
                            });
                            return true;
                        }, error => {
                            port.log.error && port.log.error(error);
                            reply(error.message, 401);
                        }).catch(error => {
                            if (error.message === 'security.maxDocumentsPerDayExceeded') {
                                reply('You exceeded max documents per day').code(400);
                            } else {
                                port.log.error && port.log.error(error);
                                reply(error.message, 500);
                            }
                        });
                    }
                }
            }
        } catch(e) {
            throw e;
        }
    }
};

function maliciousFileValidateFunc(uploadConfig) {
    return function maliciousFileValidate(request, port, actorId, hapiFileProp) {
        return new Promise(async function(resolve, reject) {
            try {
                var file = request.payload[hapiFileProp];
                if (!file) {
                    file = request.payload.file;
                }
                const contentType = Content.type(request.headers['content-type']);
                if (!contentType || !contentType.boundary) return reply('Missing content type boundary').code(400);
                if (!isUploadValid(file.hapi.filename, uploadConfig)) return reply('Error while uploading file').code(400);
                if (port.bus.config && port.bus.config.documents && port.bus.config.documents.maxDocsPerDay) {
                    await port.bus.importMethod('document.maxNumberPerActor.validate')({
                        actorId: actorId,
                        size: request.headers['content-length'],
                        maxDocsPerDay: port.bus.config && port.bus.config.documents && port.bus.config.documents.maxDocsPerDay
                    });
                }
                if (!file || typeof file !== 'object') {
                    return reject(new Error('Error while uploading file'));
                }
                return resolve(`${uuid()}.${file.hapi.filename.split('.').pop()}`);
            } catch(e) {
                return reject(e);
            }
        });
    }
}

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
        deviceId: request.headers && request.headers.deviceId
    };
}

function isUploadValid(fileName, uploadConfig) {
    let isNameValid = fileName.lastIndexOf('.') > -1 && fileName.length <= uploadConfig.maxFileName;
    let uploadExtension = fileName.split('.').pop();
    let isExtensionAllowed = uploadConfig.extensionsWhiteList.indexOf(uploadExtension.toLowerCase()) > -1;
    return isNameValid && isExtensionAllowed;
};

function prepareIdentityCheckParamsFunc(port) {
    return function prepareIdentityCheckParams(request, identityCheckFullName) {
        let identityCheckParams;
        if (request.payload.method === identityCheckFullName) {
            identityCheckParams = mergeWith({}, request.payload.params);
        } else {
            identityCheckParams = {actionId: request.payload.method};
        }
        mergeWith(
            identityCheckParams,
            request.auth.credentials,
            {
                ip: (
                    (port.config.allowXFF && request.headers['x-forwarded-for'])
                        ? request.headers['x-forwarded-for']
                        : request.info.remoteAddress
                )
            }
        );
        return identityCheckParams;
    }
}
