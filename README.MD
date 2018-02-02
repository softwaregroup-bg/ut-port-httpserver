# HTTP server port

This port exposes the following functionality:

1. Plain HTTP/HTTPS for static resources
1. GET/POST requests with JSON-RPC 2.0 body to the **/rpc** URL
1. GET/POST requests with JSON body equivalent of the JSON-RPC 2.0 "params" property to the **/rpc/namespace/method** URL
1. There are some predefined namespaces and their methods:
  * identity (equivalent to security)
    * **identity.login** - create a session
    * **identity.logout** - close a session
    * **identity.changePassword** - change password
  * permission
    * **permission.check** - check if a permission for an action is granted
    * **permission.list** - list permitted actions

# Planned features

1. Secure Remote Password protocol support, as defined in [RFC 2945](http://tools.ietf.org/html/rfc2945)
1. Multi language support
1. Fingerprinted resource URLs
1. WebSockets
1. Recommendations from http://stackoverflow.com/questions/549/the-definitive-guide-to-form-based-website-authentication
1. Automatic documentation of the exposed APIs

# Planned node modules to be used

1. For HTTP server: https://www.npmjs.com/package/hapi
1. For login: https://www.npmjs.com/package/jsrp
1. For fingerprinted URLs: https://www.npmjs.com/package/raptor-optimizer
1. For debugging: https://www.npmjs.com/package/tv
1. For caching: https://www.npmjs.com/package/catbox
1. For WebSockets: https://www.npmjs.com/package/shoe
1. For templates: our own module ut-template
1. For API doc: https://www.npmjs.com/package/hapi-swagger

## USAGE

#### Configuration file required options:

```javascript
    id: '',
    type: 'httpserver',
    logLevel: '',
    port: ''
```

* `id`: unique identification of port

* `logLevel`: trace, debug or info.

* `port`: the port where the server will accept connections.

* `ports`: same as port but sets multiple listening ports

* `server`: Server specific configuration

* `fileUpload`: File upload configuration

server specific configuration can be passed as object with key `server`.
For instance if we have http server port implementation as follows:
```javascript
module.exports = {
    id: 'httpserver',
    type: 'httpserver',
    logLevel: 'trace',
    port: 8003,//or use property ports, see below
    ports: [8003, 8004],
    imports:[],
    jwt: { // jwt options (https://github.com/auth0/node-jsonwebtoken)
        verifyOptions: {...}, // options that are used when verifying
        signOptions: {...}, // options that are used when signing
        key: '...' // jwt sign key
    },
    disableXsrf: {http: false, ws: false}, // disable xsrf support for http and ws(web sockets)
    disablePermissionVerify: {ws: false}, // disable verification of services, eg pass requests without checks
    setSecurityHeaders: false, // enable security headers for every request. Usefull when this headers are not set in reverse proxy
    ssoAuthUrl: '...', // to where client should be redirected in order to make single sign on authentication
    appId: 'appName', // required for permission verify in socket-server
    identityNamespace: 'identity', // default value: identity, if identityNamespace is set to false, no identity check will be applied. this is useful when other namespace than identity will be used for identity check
    cookiePaths:'/rpc', // cookie paths, to which paths to bound cookies to, default: /rpc
    fileUpload: {
        maxFileName: 100,
        payloadMaxBytes: 5242880, // 5 MB. Default is 1048576 (1MB)
        extensionsWhiteList: ['pdf', 'doc', 'docx', 'xls', 'txt', 'jpg', 'jpeg', 'png']
    },
    validationPassThrough: (true|false), // if true, validation is not mandatory for methods. default policy: restrictive
    entryPoint: './abc/index.js', // app entry point (webpack helper)
    appId: 'monitoring', // will help when socket server matches permissions.
    server:{
        /*.......*/
    },
    registry: {
        name: 'httpserver007',
        host: '17.0.0.1',
        port: '8030',
        context: {
            key1: 'value1',
            key2: 'value2'
        }
    }
    /*.......*/
};
```
all properties from `server` will be passed to server as configuration and will be merged with `host` and `port` properties

* `registry` this is an optional property instructing how the http server should regiter itself as a service in case service discovery have been enabled for the implementation (for more information about how to enable service discovery on implementation level can be found [here](https://github.com/softwaregroup-bg/ut-port-registry).
This parameter is entirely optional. If not provided then the following default values will be used:
```
    {
        name: 'the name of the implementation',
        host: 'the host the http server is started on',
        port: 'the port the http server is started on',
        context: {
            type: 'http'
        }
    }
```
If only the name needs to be changed from the default input then the following configuration must be passed:

```
    registry: {
        name: 'custom name'
    }
```
To disable service registration set
```
{
    registry: false
}
```

Optional configuration options:
* `start`: function that will be called once on creation of port. It can be used for setting global variables and initializing objects.

## Validations (config) files pops

```javascript
module.exports = {
    description: '...', // from swagger description
    notes: ['...'], // from swagger notes
    tags: ['...'], // from swagger tags, it will add api automatically
    isRpc: false || true, // either this route is rpc or not
    auth: false || '....', // authentication type (jwt ?)
    httpMethod: '..', // (GET|POST|PUT|DELETE)
    response: '...',// response and result, bot are used for response validation, if both are omitted response will not bi validated!
    result: '...',
    route: '<route path>' // example "/a/b/c/{page}" will overwrite default defined route path
};
```

## Return streamed file (used for large files)
if `staticFileName` is set file will be returned to client, but if `tmpStaticFileName` is set after file gets returned will be deleted.
Downloaded file name could be set explicitly with `downloadFileName`, otherwise `staticFileName` or `tmpStaticFileName` would be used as default.
