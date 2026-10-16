'use strict';

const Layer = require('./layer');
const methods = require('../methods');
const debug = require('../debug')('switchyard:route');

/**
 * The handlers for one path, by HTTP method. `route.get(fn)` adds a handler for GET; `route.all(fn)` one for every method.
 */
class Route {
  constructor(path) {
    this.path = path;
    this.stack = [];
    this.methods = {};
    debug('new %o', path);
  }

  /** Whether the route has a handler for `method`. A route that handles GET handles HEAD too. */
  handlesMethod(method) {
    if (this.methods._all) return true;

    let name = typeof method === 'string' ? method.toLowerCase() : method;
    if (name === 'head' && !this.methods.head) name = 'get';
    return Boolean(this.methods[name]);
  }

  /** The methods the route answers, upper-cased, for an Allow header. */
  allowedMethods() {
    const allowed = Object.keys(this.methods).filter(method => method !== '_all');
    if (this.methods.get && !this.methods.head) allowed.push('head');
    return allowed.map(method => method.toUpperCase());
  }

  /** Runs the request through the route's handlers for its method, then calls `done`. */
  dispatch(req, res, done) {
    const stack = this.stack;
    let index = 0;
    if (stack.length === 0) return done();

    let method = req.method.toLowerCase();
    if (method === 'head' && !this.methods.head) method = 'get';
    req.route = this;

    const next = err => {
      // next('route') leaves this route; next('router') leaves the router.
      if (err && err === 'route') return done();
      if (err && err === 'router') return done(err);

      const layer = stack[index++];
      if (!layer) return done(err);
      if (layer.method && layer.method !== method) return next(err);

      if (err) layer.handleError(err, req, res, next);
      else layer.handleRequest(req, res, next);
    };

    next();
  }

  /** Adds handlers that run for every method. */
  all(...handlers) {
    for (const handle of handlers.flat()) {
      if (typeof handle !== 'function') {
        throw new TypeError('Route.all() requires a callback function but got a ' + typeof handle);
      }
      const layer = new Layer('/', {}, handle);
      layer.method = undefined;
      this.methods._all = true;
      this.stack.push(layer);
    }
    return this;
  }
}

methods.forEach(function (method) {
  Route.prototype[method] = function (...handlers) {
    for (const handle of handlers.flat()) {
      if (typeof handle !== 'function') {
        throw new TypeError('Route.' + method + '() requires a callback function but got a ' + typeof handle);
      }
      debug('%s %o', method, this.path);
      const layer = new Layer('/', {}, handle);
      layer.method = method;
      this.methods[method] = true;
      this.stack.push(layer);
    }
    return this;
  };
});

module.exports = Route;
