'use strict';

/**
 * Middleware that parses the query string into `req.query`, unless something before it already has. A key given more than
 * once becomes an array, up to `arrayLimit` values.
 */
module.exports = function query(options) {
  const opts = Object.assign({ arrayLimit: 100 }, options);

  return function queryParser(req, res, next) {
    if (!req.query) {
      const at = req.url.indexOf('?');
      req.query = at === -1 ? {} : parse(req.url.slice(at + 1), opts);
    }
    next();
  };
};

function parse(search, opts) {
  const out = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (!Object.hasOwn(out, key)) out[key] = value;
    else if (!Array.isArray(out[key])) out[key] = [out[key], value];
    else if (out[key].length < opts.arrayLimit) out[key].push(value);
  }
  return out;
}
