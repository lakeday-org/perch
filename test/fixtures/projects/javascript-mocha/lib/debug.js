'use strict';

const util = require('node:util');

/** The namespaces DEBUG names, read once: `switchyard:*` turns on every logger here. */
const enabled = (process.env.DEBUG || '').split(/[\s,]+/).filter(Boolean);

/**
 * A logger for one namespace that writes to stderr when DEBUG names it and does nothing otherwise.
 */
module.exports = function debug(namespace) {
  const on = enabled.some(pattern => pattern === namespace || (pattern.endsWith('*') && namespace.startsWith(pattern.slice(0, -1))));

  return function log(format, ...args) {
    if (!on) return;
    process.stderr.write(namespace + ' ' + util.format(format, ...args) + '\n');
  };
};
