# Documenting Implementations #

This document describes how to create automatic documentation and validation for
HTTP requests in SG impl projects. The module [hapi-swagger](https://github.com/glennjones/hapi-swagger)
is used in the port-httpserver to do so.

### **Technological dependencies** ###
 - `joi` - [Github Page and Documentation](https://github.com/hapijs/joi)

### **Useful Links** ###

 - `Hapi-swagger` - [Github Page](https://github.com/glennjones/hapi-swagger)
 - `Swagger` - [Live Demo](http://petstore.swagger.io/) [Official Site](http://swagger.io/)
 
### Usages ###

1. Creating automatic HTTP API documentation for 
1. `Documenting` URL paths based on the different methods in each module
    -  /rpc/{namespace}/{method} 
    - e.g: "`/rpc/security/login`", "`/rpc/customer/get`"
1. `Documenting` and `Validating` request/response parameters:
    * `variable type`
    * `description` (optional)
    * whether the params are `optional/required`

### Accessing the docs ###
Go to: 

```
http://localhost:{port}/documentation
```

where `port` is the http client port.

### Creating documentation for a module ###

To create documentation and validation for a given module follow the steps below:

* Create a file `validation.js` in the module's folder that you want to document
* Add dependency to `joi` in `validation.js`:

    ```js
    var Joi = require('joi');
    ```
    
* Add the following code to `index.js` in the implementation's `httpserver port`.

    ```js
    imports: ['module1', 'module2', 'module3'],
    ```
    Where module* are the names of your modules.
    
* Lets say the module `customer` exports some functions like those below:

    ```js
    module.exports = {
        init: function(bus) {},
        get: function(msg) {},
        register: function(msg) {},
        batchRegister: function(msg) {},
        search: function(msg) {},
        getAllAccounts: function(msg) {},
        cashWithdraw: function(msg) {}, 
    };
    ```
* The file `validation.js` should export an object with the same property names for each documented method.  

    ```js
    module.exports = {
        get: {},
        register: {},
        batchRegister: {},
        search: {},
        cashWithdraw: {},
    };
    ```
*  The file `server.js` should hold a `validations:{}` property for each documented module.

    ```js
    validations: {
        customer: require('./customer/validation'),
        security: require('./security/validation'),
        dictionary: require('./dictionary/validation'),
    }
    ```
    The property names in the `validations` should be the ame as the module names.
    
* Documentation and validation for a given method is written in the following format:

    ```js
    cashWithdraw: {
        description: 'Cash withdraw',
        notes: ["Withdraws given amount of money from one of the user's debit accounts."],
        tags: ['api', 'customer'],
        params: {
            charges: Joi.string().required().description("Charges for the deposit"),
            amount: Joi.string().required(),
            debitAccount: Joi.string().required(),
            confirmStage: Joi.string().description(
                " '0' - validate record or" +
                " '1' - save record or" +
                " '2' - authorize record").allow('0', '1', '3').default('1'),
            verification: Joi.object({
                fingerPrint: Joi.string(),
                otp: Joi.string().description("One time password")
            }).without('fingerPrint', 'otp')
        },
        returns: Joi.object({
            recordId: Joi.string().description("Transaction confirmation code"),
            overrideMessages: Joi.array().items(Joi.string()).description("Array with messages from t24")
        })
    },
    ```
    * `description` - short description 
    * `notes` - full length description
    * `tags: ['api']`: this should be added for the method to be shown in the
    documentation page. If a given method should be validated but not documented this property can be omitted.
    Other tags like `'customer'` can be added in order to access only paths with specific tags: 
    
    ```
    http://localhost:{port}/documentation/{tagName}
    ```
    * `params` - HTTP request body (optional)
    * `returns` - HTTP response body