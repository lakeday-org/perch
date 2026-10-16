'use strict';

const pathToRegexp = require('../path-to-regexp');
const debug = require('../debug')('switchyard:layer');

/**
 * One entry in a router's stack: a path pattern and the function to call when a request's path matches it.
 */
class Layer {
  constructor(path, options, fn) {
    const opts = options || {};
    debug('new %o', path);

    this.handle = fn;
    this.name = fn.name || '<anonymous>';
    this.params = undefined;
    this.path = undefined;
    this.keys = [];
    this.regexp = pathToRegexp(path, this.keys, opts);
    // Middleware mounted at "/" matches every path, so it skips the expression.
    this.regexp.fastSlash = path === '/' && opts.end === false;
    this.route = undefined;
  }

  /** Calls an error-handling function, which is one that takes four arguments; any other passes the error on. */
  handleError(error, req, res, next) {
    if (this.handle.length !== 4) return next(error);

    try {
      this.handle(error, req, res, next);
    } catch (err) {
      next(err);
    }
  }

  /** Calls a request handler, which takes at most three arguments; an error handler is passed over. */
  handleRequest(req, res, next) {
    if (this.handle.length > 3) return next();

    try {
      this.handle(req, res, next);
    } catch (err) {
      next(err);
    }
  }

  /** Whether the layer matches `path`, setting `params` and the matched `path` when it does. */
  match(path) {
    if (path == null) {
      this.params = undefined;
      this.path = undefined;
      return false;
    }

    if (this.regexp.fastSlash) {
      this.params = {};
      this.path = '';
      return true;
    }

    const found = this.regexp.exec(path);
    if (!found) {
      this.params = undefined;
      this.path = undefined;
      return false;
    }

    this.params = {};
    this.path = found[0];
    for (let i = 1; i < found.length; i++) {
      const key = this.keys[i - 1];
      const value = decodeParam(found[i]);
      if (value !== undefined || !Object.prototype.hasOwnProperty.call(this.params, key.name)) {
        this.params[key.name] = value;
      }
    }
    return true;
  }
}

function decodeParam(value) {
  if (typeof value !== 'string' || value.length === 0) return value;

  try {
    return decodeURIComponent(value);
  } catch (err) {
    if (err instanceof URIError) {
      err.message = "Failed to decode param '" + value + "'";
      err.status = err.statusCode = 400;
    }
    throw err;
  }
}

module.exports = Layer;
