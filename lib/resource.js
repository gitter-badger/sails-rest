/**
 * Module dependencies
 */
var async = require('async'),
    restify = require('restify'),
    url = require('url'),
    _ = require('lodash'),
    _i = require('underscore.inflections'),
    _s = require('underscore.string'),
    RestError = require('./rest-error');

/**
 * A Remote Resource DataStore
 *
 * @param {Object} config
 * @param {Object} collections
 * @returns {Object}
 * @api public
 */
var Resource = module.exports = function(config, collections) {
  this.client = Resource.createClient(config);

  if (config.cache) {
    this.cache = config.cache;
  }

  this.config = config;

  this.collections = collections;

  return this;
};

/**
 * Generate a pathname to use for a request
 * @param {Object} config - connection configuration
 * @param {String} method - request method
 * @param {Object} values - data being send (if any)
 * @param {Object} options - options passed from the calling method
 * @returns {Object}
 * @api public
 */
Resource.getPathname = function(config, method, values, options){
  return config.pathname + '/' + config.resource + (config.action ? '/' + config.action : '');
};

/**
 * Format result object according to schema
 * @param {Object} result
 * @param {Object} collection - collection the result object belongs to
 * @param {Object} config - connection configuration
 * @returns {Object}
 * @api private
 */
Resource.formatResult = function(result, collection, config) {
  if (_.isFunction(config.beforeFormatResult)) {
    result = config.beforeFormatResult(result);
  }

  // Unserialize values
  result = collection._transformer.unserialize(result);
  collection._cast.run(result);

  if (_.isFunction(config.afterFormatResult)) {
    result = config.afterFormatResult(result);
  }

  return result;
};

/**
 * Format results according to schema
 * @param {Array} results - objects (model instances)
 * @param {Object} collection - collection the result object belongs to
 * @param {Object} config - connection configuration
 * @returns {Array}
 * @api private
 */
Resource.formatResults = function(results, collection, config) {
  if (_.isFunction(config.beforeFormatResults)) {
    results = config.beforeFormatResults(results);
  }

  results = _.map(results, function(result) {
    return Resource.formatResult(result, collection, config);
  });

  if (_.isFunction(config.afterFormatResults)) {
    results = config.afterFormatResults(results);
  }

  return results;
};

/**
 * Ensure results are contained in an array. Resolves variants in API responses such as `results` or `objects` instead of `[.....]`
 * @param {Object|Array} data - response data to format as results array
 * @param {Object} collection - collection the result object belongs to
 * @param {Object} config - connection configuration
 * @returns {Object|Array}
 * @api private
 */
Resource.getResultsAsCollection = function(data, collection, config) {
  var d = (data.objects || data.results || data),
      a = _.isArray(d) ? d : [d];

  return Resource.formatResults(a, collection, config);
};

/**
 * Create client to REST API
 * @param {Object} config
 * @returns {Object} - Restify client
 * @api private
 */
Resource.createClient = function(config) {
  var client,
      type = _s.join('', 'create', _s.capitalize(config.type), 'Client');

  if (!_.isFunction(restify[type])) {
    throw new Error('Invalid type provided: ' + config.type);
  }

  client = restify[type]({
    url: url.format({
      protocol: config.protocol,
      hostname: config.hostname,
      host: config.host,
      port: config.port
    }),
    headers: config.headers
  });

  if (config.basicAuth) {
    client.basicAuth(config.basicAuth.username, config.basicAuth.password);
  }

  return client;
};

/**
 * Makes a REST request via restify
 * @param {String} collectionName - collection the result object belongs to
 * @param {String} methodName - name of CRUD method being used
 * @param {Function} callback - callback from method
 * @param {Object} options - options from method
 * @param {Object|Array} [values] - values from method
 * @returns {*}
 */
Resource.prototype.request = function(collectionName, methodName, callback, options, values) {
  var r,
      opt,
      uri,
      cache,
      pathname,
      self = this,
      client = this.client,
      config = _.cloneDeep(this.config),
      restMethod = config.methods[methodName],
      collection = this.collections[collectionName];

  // Validate passed HTTP method
  if (!_.isFunction(client[restMethod])) {
    callback(new Error('Invalid REST method: ' + restMethod));
    return;
  }

  // Override config settings from options if available
  if (options && _.isPlainObject(options)) {
    _.each(config, function(val, key) {
      if (_.has(options, key)) {
        config[key] = options[key];
      }
    });
  }

  // if resource name not set in config,
  // try to get it from pluralized form of collectionName
  if (!config.resource) {
    config.resource = _i.pluralize(collectionName);
  }

  pathname = config.getPathname(config, restMethod, values, options);

  if (options && options.where) {
    if (options.where.id) {
      // Add id to pathname if provided
      pathname += '/' + options.where.id;
      delete options.where.id;
    } else if (methodName === 'destroy' || methodName === 'update') {
      // Find all and make new request for each.
      self.find(collectionName, options, function(err, results) {
        if (err) return callback(err);

        _.each(results, function(result, i) {
          var cb = ((i + 1) === results.length) ? callback : _.noop,
              options = {
                where: {
                  id: result.id
                }
              };

          self.request(collectionName, methodName, cb, options, values);
        });
      });

      return;
    }

    // Add where statement as query parameters if requesting via GET
    if (restMethod === 'get') {
      _.extend(config.query, (options.where || {}));
      ['skip', 'limit', 'offset'].forEach(function(key){
        if(options[key] !== undefined){
          config.query[key] = options[key];
        }
      });
    }
    // Set opt if additional where statements are available
    else if (_.size(options.where)) {
      opt = options.where;
    } else {
      delete options.where;
    }
  }

  if (!opt && values) {
    opt = values;

    if (options) {
      opt = _.extend(options, opt);
    }
  }

  // Add pathname to connection
  config.pathname = pathname;

  // Format URI
  uri = url.format(config);

  cache = this.cache;

  // Retrieve data from the cache
  if (methodName === 'find') {
    r = cache && cache.engine.get(uri);
  }

  if (r) {
    callback(null, r);
  } else if (_.isFunction(client[restMethod])) {
    var path = uri.replace(client.url.href, '/');

    var cb = function(err, req, res, data) {
      var restError,
      // check if response code is in 4xx or 5xx range
          responseErrorCode = res && /^(4|5)\d+$/.test(res.statusCode.toString());

      if (err && ( res === undefined || res === null || responseErrorCode ) ) {
        restError = new RestError(err.message, {req: req, res: res, data: data});
        callback(restError);
      } else {
        if (methodName === 'find') {
          r = Resource.getResultsAsCollection(data, collection, config);
          if (cache) {
            cache.engine.set(uri, r);
          }
        } else {
          r = Resource.formatResult(data, collection, config);
          if (cache) {
            cache.engine.del(uri);
          }
        }
        callback(null, r);
      }
    };

    // Make request via restify
    if (opt) {
      client[restMethod](path, opt, cb);
    } else {
      client[restMethod](path, cb);
    }
  }
};

/**
 * Selects records match the criteria
 * @param {String} collection
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */
Resource.prototype.find = function(collection, options, callback) {
  this.request(collection, 'find', callback, options);
};

/**
 * Insert A Record
 * @param {String} collection
 * @param {Object} values
 * @param {Function} callback
 * @return {Object}
 * @api public
 */
Resource.prototype.create = function(collection, values, callback) {
  this.request(collection, 'create', callback, null, values);
};

/**
 * Update A Record
 * @param {String} collection
 * @param {Object} options
 * @param {Object} values
 * @param {Function} callback
 * @api public
 */
Resource.prototype.update = function(collection, options, values, callback) {
  this.request(collection, 'update', callback, options, values);
};

/**
 * Destroy A Record
 * @param {String} collection
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */
Resource.prototype.destroy = function(collection, options, callback) {
  this.request(collection, 'destroy', callback, options);
};