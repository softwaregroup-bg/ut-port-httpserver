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
    cookiePaths:['/rpc'], // cookie paths, to which paths to bound cookies to, default: /rpc
    validationPassThrough: (true|false), // if true, validation is not mandatory for methods. default policy: restrictive
    entryPoint: './abc/index.js', // app entry point (webpack helper)
    server:{
        /*.......*/
    }

    /*.......*/
};
```
all properties from `server` will be passed to server as configuration and will be merged with `host` and `port` properties


Optional configuration options:
* `start`: function that will be called once on creation of port. It can be used for setting global variables and initializing objects.

## Validations (config) files pops

```javascript
module.exports = {
    description: '...', // from swagger description
    notes: ['...'], // from swagger notes
    tags: ['...'], // from swagger tags, it will add api automatically
    isRpc: false || true, // either this route is rpc or not
    httpMethod: '..', // (GET|POST|PUT|DELETE)
    route: '<route path>' // example "/a/b/c/{page}" will overwrite default defined route path
};
```