'use strict';

const { createHash } = require('node:crypto');

/** The short names a Content-Type may be given by. */
const TYPES = {
  bin: 'application/octet-stream',
  css: 'text/css',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
  text: 'text/plain',
  txt: 'text/plain',
  xml: 'application/xml',
};

/**
 * A strong ETag for a body: its length and a hash of it, so two bodies alike byte for byte share one.
 */
exports.etag = function etag(body, encoding) {
  return entityTag(body, encoding, false);
};

/**
 * A weak ETag, `W/"..."`, which says two bodies are equivalent rather than identical.
 */
exports.wetag = function wetag(body, encoding) {
  return entityTag(body, encoding, true);
};

function entityTag(body, encoding, weak) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, encoding);
  const hash = createHash('sha1').update(buf).digest('base64').slice(0, 27);
  const tag = '"' + buf.length.toString(16) + '-' + hash + '"';
  return weak ? 'W/' + tag : tag;
}

/**
 * Whether a filesystem path is absolute, on POSIX or on Windows.
 */
exports.isAbsolute = function (path) {
  if (path[0] === '/') return true;
  if (path[1] === ':' && (path[2] === '\\' || path[2] === '/')) return true;
  if (path.substring(0, 2) === '\\\\') return true;
  return false;
};

/**
 * A full MIME type for `type`, which may already be one or may be a short name such as `html` or `.json`.
 */
exports.normalizeType = function (type) {
  if (type.indexOf('/') !== -1) return type;
  return TYPES[type.replace(/^\./, '')] || 'application/octet-stream';
};

exports.normalizeTypes = function (types) {
  return types.map(exports.normalizeType);
};

/**
 * The ETag function the `etag` setting names: true or "weak" for weak tags, "strong" for strong ones, false for none, or a
 * function of the application's own.
 */
exports.compileETag = function (val) {
  if (typeof val === 'function') return val;

  switch (val) {
    case true:
    case 'weak':
      return exports.wetag;
    case false:
      return undefined;
    case 'strong':
      return exports.etag;
    default:
      throw new TypeError('unknown value for etag function: ' + val);
  }
};

/**
 * Which proxies the `trust proxy` setting trusts: all of them, the first `n` hops, a list of addresses, or none.
 */
exports.compileTrust = function (val) {
  if (typeof val === 'function') return val;
  if (val === true) return () => true;
  if (typeof val === 'number') return (address, hop) => hop < val;
  if (typeof val === 'string') {
    const addresses = val.split(',').map(item => item.trim());
    return address => addresses.includes(address);
  }
  return () => false;
};

/**
 * `type` with its charset parameter set to `charset`, replacing one it already had and keeping its other parameters.
 */
exports.setCharset = function setCharset(type, charset) {
  if (!type || !charset) return type;

  const [mime, ...params] = type.split(';').map(part => part.trim());
  const kept = params.filter(param => param && !/^charset=/i.test(param));
  return [mime, ...kept, 'charset=' + charset.toLowerCase()].join('; ');
};
