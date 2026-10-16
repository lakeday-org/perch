'use strict';

const http = require('node:http');
const Router = require('./router');
const View = require('./view');
const methods = require('./methods');
const finalhandler = require('./finalhandler');
const query = require('./middleware/query');
const { init } = require('./middleware/init');
const { compileETag, compileTrust } = require('./utils');
const debug = require('./debug')('switchyard:application');

/**
 * An application: settings, a router with the query parser and the response helpers mounted first, and the view engines.
 */
class Application {
  constructor(options = {}) {
    this.settings = {};
    this.engines = {};
    this.cache = {};
    this.locals = Object.create(null);
    this.mountpath = '/';
    this.router = new Router({ caseSensitive: options.caseSensitive, strict: options.strict });
    this.router.use(query(options.queryParser));
    this.router.use(init(this));
    this.defaultConfiguration(options.env || process.env.NODE_ENV || 'development');
  }

  defaultConfiguration(env) {
    this.enable('x-powered-by');
    this.set('etag', 'weak');
    this.set('env', env);
    this.set('trust proxy', false);
    this.set('views', 'views');
    if (env === 'production') this.enable('view cache');
    debug('booting in %s mode', env);
  }

  /** With one argument, the value of a setting; with two, sets it. */
  set(setting, value) {
    if (arguments.length === 1) return this.settings[setting];

    this.settings[setting] = value;
    switch (setting) {
      case 'etag':
        this.settings['etag fn'] = compileETag(value);
        break;
      case 'trust proxy':
        this.settings['trust proxy fn'] = compileTrust(value);
        break;
    }
    return this;
  }

  enabled(setting) {
    return Boolean(this.set(setting));
  }

  disabled(setting) {
    return !this.set(setting);
  }

  enable(setting) {
    return this.set(setting, true);
  }

  disable(setting) {
    return this.set(setting, false);
  }

  use(...args) {
    this.router.use(...args);
    return this;
  }

  route(path) {
    return this.router.route(path);
  }

  param(name, fn) {
    this.router.param(name, fn);
    return this;
  }

  /** Registers the template engine for files ending in `ext`. */
  engine(ext, fn) {
    if (typeof fn !== 'function') throw new Error('callback function required');
    const extension = ext[0] !== '.' ? '.' + ext : ext;
    this.engines[extension] = fn;
    return this;
  }

  /** Renders the view `name` with the application's locals and `options`. */
  render(name, options, callback) {
    const opts = Object.assign({}, this.locals, options);
    const cacheable = opts.cache != null ? opts.cache : this.enabled('view cache');
    let view = cacheable ? this.cache[name] : undefined;

    if (!view) {
      view = new View(name, { defaultEngine: this.set('view engine'), root: this.set('views'), engines: this.engines });
      if (!view.path) {
        const err = new Error('Failed to lookup view "' + name + '" in views directory "' + view.root + '"');
        err.view = view;
        return callback(err);
      }
      if (cacheable) this.cache[name] = view;
    }

    try {
      view.render(opts, callback);
    } catch (err) {
      callback(err);
    }
  }

  /** Runs a request through the application, ending in the final handler unless `callback` is given. */
  handle(req, res, callback) {
    const done = callback || finalhandler(req, res, { env: this.set('env') });
    this.router.handle(req, res, done);
  }

  callback() {
    return (req, res) => this.handle(req, res);
  }

  listen(...args) {
    const server = http.createServer(this.callback());
    return server.listen(...args);
  }
}

methods.concat('all').forEach(function (method) {
  Application.prototype[method] = function (path, ...handlers) {
    this.router[method](path, ...handlers);
    return this;
  };
});

function createApplication(options) {
  return new Application(options);
}

module.exports = createApplication;
module.exports.Application = Application;
