// swagger fix => https://github.com/glennjones/hapi-swagger/pull/428/files
const Hoek = require('hoek');
const Utilities = require('hapi-swagger/lib/utilities');
const Properties = require('hapi-swagger/lib/properties');
/**
 * parse alternatives property
 *
 * @param  {Object} property
 * @param  {Object} joiObj
 * @param  {String} name
 * @param  {String} parameterType
 * @param  {Boolean} useDefinitions
 * @return {Object}
 */
Properties.prototype.parseAlternatives = function(property, joiObj, name, parameterType, useDefinitions) {
    // convert .try() alternatives structures
    if (Hoek.reach(joiObj, '_inner.matches.0.schema')) {
        // add first into definitionCollection
        let child = joiObj._inner.matches[0].schema;
        let childName = Utilities.geJoiLabel(joiObj);
        //name, joiObj, parent, parameterType, useDefinitions, isAlt
        property = this.parseProperty(childName, child, property, parameterType, useDefinitions, false);

        // create the alternatives without appending to the definitionCollection
        if (property && this.settings.xProperties === true) {
            let altArray = joiObj._inner.matches.map((obj) => {
                let altName = (Utilities.geJoiLabel(obj.schema) || name);
                //name, joiObj, parent, parameterType, useDefinitions, isAlt
                return this.parseProperty(altName, obj.schema, property, parameterType, useDefinitions, true);
            });
            property['x-alternatives'] = Hoek.clone(altArray);
        }
    }

    // convert .when() alternatives structures
    else {
        // add first into definitionCollection
        let child = joiObj._inner.matches[0].then;
        let childName = (Utilities.geJoiLabel(child) || name);
        //name, joiObj, parent, parameterType, useDefinitions, isAlt
        property = this.parseProperty(childName, child, property, parameterType, useDefinitions, false);

        // create the alternatives without appending to the definitionCollection
        if (property && this.settings.xProperties === true) {
            let altArray = joiObj._inner.matches
                .reduce((res, obj) => {
                    obj.then && res.push(obj.then);
                    obj.otherwise && res.push(obj.otherwise);
                    return res;
                }, [])
                .map((joiNewObj) => {
                    let altName = (Utilities.geJoiLabel(joiNewObj) || name);
                    return this.parseProperty(altName, joiNewObj, property, parameterType, useDefinitions, true);
                })
                .filter((obj) => obj);
            property['x-alternatives'] = Hoek.clone(altArray);
        }
    }

    //if (!property.$ref && Utilities.geJoiLabel(joiObj)) {
    //    property.name = Utilities.geJoiLabel(joiObj);
    //}

    return property;
};
