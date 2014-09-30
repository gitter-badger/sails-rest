/**
 * Rest Custom Error Object
 * @param {String} message
 * @param {Object} meta
 * @constructor
 */
var RestError = module.exports = function (message, meta) {
  this.name = "RestError";
  this.message = message || "REST Error Message";
  this.meta = meta || {};
};

RestError.prototype = new Error();
RestError.prototype.constructor = RestError;