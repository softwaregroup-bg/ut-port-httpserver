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
                                headers: file.hapi.headers
                            };
                            const uploadPath = path.join(port.bus.config.workDir, config.uploadPath, fileInfo.filename);
                            await checkAndCreateFolder(uploadPath);
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
                            reply(error.message).code(400);
                        }).catch(error => {
                            if (error.message === 'security.maxDocumentsPerDayExceeded') {
                                reply('You exceeded max documents per day').code(400);
                            } else {
                                port.log.error && port.log.error(error);
                                reply(error.message).code(400);
                            }
                        });
                    }
                }
            }
        } catch(error) {
            port.log.error && port.log.error(error);
            reply(error.message).code(400);
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
                if (!file || typeof file !== 'object') {
                    return reject(new Error('Error while uploading file'));
                }
                const contentType = Content.type(request.headers['content-type']);
                if (!contentType || !contentType.boundary) {
                    throw new Error('Missing content type boundary');
                }
                isUploadValid(file.hapi.filename, uploadConfig);
                if (port.bus.config && port.bus.config.documents && port.bus.config.documents.maxDocsPerDay) {
                    var validate = await port.bus.importMethod('document.maxNumberPerActor.validate')({
                        actorId: actorId,
                        size: request.headers['content-length'],
                        maxDocsPerDay: port.bus.config && port.bus.config.documents && port.bus.config.documents.maxDocsPerDay
                    });
                    validate;
                }
                return resolve(generateFileName(file.hapi.filename));
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
    if (!/^[a-zA-Z0-9]{1,200}\.[a-zA-Z0-9]{1,10}$/.test(fileName)) {
        throw new Error('Invalid filename!!');
    }
    let isNameValid = fileName.lastIndexOf('.') > -1 && fileName.length <= uploadConfig.maxFileName;
    if (!isNameValid) {
        throw new Error('The file name is too long!');
    }
    let uploadExtension = fileName.split('.').pop();
    let isExtensionAllowed = uploadConfig.extensionsWhiteList.indexOf(uploadExtension.toLowerCase()) > -1;
    if (!isExtensionAllowed) {
        throw new Error('The file you are uploading is not supported!');
    }
    return true;;
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

function generateFileName(filename) {
    let date = new Date();
    let fileName = `${uuid()}.${filename.split('.').pop()}`;
    let y = date.getFullYear();
    let m = date.getMonth() + 1;
    let w = getWeekOfMonth(date);
    fileName = y + path.sep + m + path.sep + w + path.sep + fileName;
    return fileName;
}

function getWeekOfMonth(date) {
    var firstWeekday = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
    var offsetDate = date.getDate() + firstWeekday - 1;
    return Math.floor(offsetDate / 7);
}

function checkAndCreateFolder(fullFilepath){
    let filepath = path.dirname(fullFilepath);
    return new Promise((resolve, reject) => {
        try {
            fs.accessSync(filepath, fs.constants.F_OK);
            resolve(filepath);
        } catch(e) {
            try {
                filepath
                .split(path.sep)
                .reduce((prevPath, folder) => {
                const currentPath = path.join(prevPath, folder, path.sep);
                    if (!fs.existsSync(currentPath)){
                        fs.mkdirSync(currentPath);
                    }
                    return currentPath;
                }, '');
                resolve(filepath);
            } catch(err) {
                reject(err);
            }
        }
    });
}