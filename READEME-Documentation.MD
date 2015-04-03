# Documentation module: `hapi-swagger` #

### **Technological dependencies** ###

 - `hapi` - [Official Page](http://hapijs.com/) - [Documentation](http://hapijs.com/api)
 - `joi` - [Github Official Page](https://github.com/hapijs/joi)

### Usages ###

1. Creating automatic HTTP API documentation
1. `Documenting` URL paths e.g: "/securuty/login", "/customer/get"
1. `Validating` request/response for:
    * body/payload
    * path paramters e.g: /user/get/{id}
    * query strings e.g: /method?field1=value1&field2=value2
    * allowed headers
1. `Describing` request/respone parameters
    * `Description` for the path
    * `HTTP Method` : GET, POST etc.
    * `Parameters` from the request/response
        * `variable type`
        * `description` (optional)
        * whether the params are `optional/required`

### Accesing the docs ###

Go to: `http://localhost:{port}/documentation` where port is the http client port
### Example: ###

The following example shows validation and documentation for the path /security/login

    login: {
        description: 'Login user',
        notes: ['Login users with:', 'username and password', 'fingerprint'],
        tags: ['api', 'security'],
        returns: {
            sessionId: Joi.string().required(),
            data: Joi.object({
                id: Joi.string().required(),
                firstName: Joi.string().required(),
                lastName: Joi.string().required(),
                phoneNumber: Joi.string().required(),
                emailAddress: Joi.string().required(),
                language: Joi.string().required(),
                department: Joi.string().required(),
                accessRights: Joi.array().items(Joi.string()).required().description("allowed access right codes")
            }).required()
        }
    }

### Creating documentation for a module  ###

To create documentation and validation for a given module follow the steps below:

* Create a file `validation.js` in the module's folder that you want to document
* Add the following code at the end of the module's `index.js` file:


    require('./validation')(module.exports);

* Add dependency to `joi` in `validation.js`:


    var Joi = require('joi');

* Add the following code at the end of the of `validation.js`:


    module.exports = function(module) {
        var _ = require('lodash');
        Object.keys(module).forEach(function (value) {
            _.assign(module[value], validation[value]);
        });
    };

* Creating validation object.
    Lets say hte module `customer` exports some functions like those below:


    module.exports = {
        init: function(bus) {},
        get: function(msg) {},
        batchRegister: function(msg) {},
        search: function(msg) {},
        getAllAccounts: function(msg) {},
        getAccounts: function(msg) {},
        batchCashDeposit: function(msg) {},
        cashWithdraw: function(msg) {},
        batchCashWithdraw: function(msg) {},
        getLoanContracts: function(msg) {},
        getAllLoanContracts: function(msg) {},
        getLoanApplications: function(msg) {},
        saveLoanApplication: function(msg) {},
        saveLoanApplications: function(msg) {},
        bioEdit: function(msg){},
        edit: function(msg){}
    };








