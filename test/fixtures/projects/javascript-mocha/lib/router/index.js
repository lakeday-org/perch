'use strict';

const Layer = require('./layer');
const Route = require('./route');
const methods = require('../methods');
const debug = require('../debug')('switchyard:router');

/**
 * A stack of middleware and routes. A request goes down the stack until a layer matching its path answers it, and a router is
 * itself middleware, so routers mount inside one another.
 */
class Router {
  constructor(options = {}) {
    this.params = {};
    this.caseSensitive = options.caseSensitive;
    this.mergeParams = options.mergeParams;
    this.strict = options.strict;
    this.stack = [];
  }

  /** Registers a callback that runs before any route naming the parameter `name`, once per request for each value. */
  param(name, fn) {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('argument name must be a non-empty string');
    if (name[0] === ':') name = name.slice(1);
    if (typeof fn !== 'function') throw new TypeError('invalid param() call for ' + name + ', got ' + fn);

    (this.params[name] = this.params[name] || []).push(fn);
    return this;
  }

  /** Mounts middleware at `path`, or at "/" when the first argument is already a function. */
  use(path, ...handlers) {
    if (typeof path === 'function' || Array.isArray(path)) {
      handlers.unshift(path);
      path = '/';
    }

    const callbacks = handlers.flat(Infinity);
    if (callbacks.length === 0) throw new TypeError('Router.use() requires a middleware function');

    for (const fn of callbacks) {
      if (typeof fn !== 'function') throw new TypeError('Router.use() requires a middleware function but got a ' + typeof fn);
      debug('use %o %s', path, fn.name || '<anonymous>');
      const layer = new Layer(path, { sensitive: this.caseSensitive, strict: false, end: false }, fn);
      layer.route = undefined;
      this.stack.push(layer);
    }
    return this;
  }

  /** A new route at `path`, added to the stack. */
  route(path) {
    const route = new Route(path);
    const layer = new Layer(path, { sensitive: this.caseSensitive, strict: this.strict, end: true }, (req, res, next) => route.dispatch(req, res, next));
    layer.route = route;
    this.stack.push(layer);
    return route;
  }

  /** Runs a request down the stack. `out` is called when no layer answers it, with the error if one was raised. */
  handle(req, res, out) {
    const self = this;
    const stack = this.stack;
    const parentParams = req.params;
    const parentUrl = req.baseUrl || '';
    const done = restore(out, req, 'baseUrl', 'next', 'params');
    const paramCalled = {};
    let index = 0;
    let removed = '';
    let slashAdded = false;

    req.next = next;
    req.baseUrl = parentUrl;
    req.originalUrl = req.originalUrl || req.url;

    next();

    function next(err) {
      let layerError = err === 'route' ? null : err;

      // Put back what the previous layer's mount path took off the url.
      if (slashAdded) {
        req.url = req.url.slice(1);
        slashAdded = false;
      }
      if (removed.length !== 0) {
        req.baseUrl = parentUrl;
        req.url = removed + req.url;
        removed = '';
      }

      if (layerError === 'router') {
        setImmediate(done, null);
        return;
      }
      if (index >= stack.length) {
        setImmediate(done, layerError);
        return;
      }

      const path = pathname(req);
      if (path == null) return done(layerError);

      let layer;
      let match;
      let route;
      while (match !== true && index < stack.length) {
        layer = stack[index++];
        match = matchLayer(layer, path);
        route = layer.route;

        if (typeof match !== 'boolean') layerError = layerError || match;
        if (match !== true) continue;
        if (!route) continue;
        // A route never handles an error; only middleware does.
        if (layerError) {
          match = false;
          continue;
        }
        if (!route.handlesMethod(req.method)) match = false;
      }

      if (match !== true) return done(layerError);

      if (route) req.route = route;
      req.params = self.mergeParams ? mergeParams(layer.params, parentParams) : layer.params;
      const layerPath = layer.path;

      self.processParams(layer, paramCalled, req, res, paramError => {
        if (paramError) return next(layerError || paramError);
        if (route) return layer.handleRequest(req, res, next);
        trimPrefix(layer, layerError, layerPath, path);
      });
    }

    function trimPrefix(layer, layerError, layerPath, path) {
      if (layerPath.length !== 0) {
        // The match has to end on a path segment: "/admin" mounts "/admin/users", not "/administrator".
        const c = path[layerPath.length];
        if (c && c !== '/' && c !== '.') return next(layerError);

        removed = layerPath;
        req.url = req.url.slice(removed.length);
        if (req.url[0] !== '/') {
          req.url = '/' + req.url;
          slashAdded = true;
        }
        req.baseUrl = parentUrl + (removed[removed.length - 1] === '/' ? removed.slice(0, -1) : removed);
      }

      if (layerError) layer.handleError(layerError, req, res, next);
      else layer.handleRequest(req, res, next);
    }
  }

  /** Runs the param callbacks for each parameter the layer's path names, then calls `done`. */
  processParams(layer, called, req, res, done) {
    const keys = layer.keys;
    if (!keys || keys.length === 0) return done();

    const params = this.params;
    let i = 0;

    const nextParam = err => {
      if (err) return done(err);
      if (i >= keys.length) return done();

      const name = keys[i++].name;
      const value = req.params[name];
      const callbacks = params[name];
      if (value === undefined || !callbacks) return nextParam();
      if (called[name] && called[name].value === value) return nextParam();
      called[name] = { value };

      let j = 0;
      const nextCallback = callbackError => {
        if (callbackError) return done(callbackError);
        const fn = callbacks[j++];
        if (!fn) return nextParam();
        try {
          fn(req, res, nextCallback, value, name);
        } catch (e) {
          nextCallback(e);
        }
      };
      nextCallback();
    };

    nextParam();
  }
}

methods.concat('all').forEach(function (method) {
  Router.prototype[method] = function (path, ...handlers) {
    const route = this.route(path);
    route[method](...handlers);
    return this;
  };
});

function matchLayer(layer, path) {
  try {
    return layer.match(path);
  } catch (err) {
    return err;
  }
}

function pathname(req) {
  if (typeof req.url !== 'string') return undefined;
  const query = req.url.indexOf('?');
  return query === -1 ? req.url : req.url.slice(0, query);
}

function mergeParams(params, parent) {
  if (typeof parent !== 'object' || !parent) return params;
  return Object.assign({}, parent, params);
}

/** `fn`, wrapped to put back the named properties of `obj` as they are now before it runs. */
function restore(fn, obj, ...props) {
  const values = props.map(prop => obj[prop]);

  return function (...args) {
    props.forEach((prop, i) => {
      obj[prop] = values[i];
    });
    return fn.apply(this, args);
  };
}

module.exports = Router;
