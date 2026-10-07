'use strict';

const { STATUS_CODES } = require('node:http');
const utils = require('./utils');

/**
 * The helpers a handler answers with, around Node's own response: `res.reply.status(201).json(user)`.
 */
class Response {
  constructor(res, req, app) {
    this.res = res;
    this.req = req;
    this.app = app;
  }

  status(code) {
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      throw new RangeError('Invalid status code: ' + JSON.stringify(code) + '. Status code must be an integer from 100 to 999.');
    }
    this.res.statusCode = code;
    return this;
  }

  /** Sets one header, or each of an object's. A Content-Type given by short name is expanded and gets a charset. */
  set(field, value) {
    if (typeof field === 'object') {
      for (const key of Object.keys(field)) this.set(key, field[key]);
      return this;
    }

    let header = Array.isArray(value) ? value.map(String) : String(value);
    if (field.toLowerCase() === 'content-type') {
      if (Array.isArray(header)) throw new TypeError('Content-Type cannot be set to an Array');
      header = utils.setCharset(utils.normalizeType(header), 'utf-8');
    }
    this.res.setHeader(field, header);
    return this;
  }

  get(field) {
    return this.res.getHeader(field);
  }

  /** Sends a string as HTML, a Buffer as bytes and anything else as JSON, with a length and the app's ETag. */
  send(body) {
    let chunk = body;

    switch (typeof chunk) {
      case 'string':
        if (!this.get('Content-Type')) this.set('Content-Type', 'html');
        break;
      case 'boolean':
      case 'number':
      case 'object':
        if (chunk === null) {
          chunk = '';
        } else if (Buffer.isBuffer(chunk)) {
          if (!this.get('Content-Type')) this.set('Content-Type', 'bin');
        } else {
          return this.json(chunk);
        }
        break;
    }

    if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8');
    if (chunk !== undefined) this.set('Content-Length', chunk.length);

    const generateETag = this.app && this.app.set('etag fn');
    if (generateETag && chunk && chunk.length && !this.get('ETag')) {
      const etag = generateETag(chunk);
      if (etag) this.set('ETag', etag);
    }

    // These statuses have no body.
    const statusCode = this.res.statusCode;
    if (statusCode === 204 || statusCode === 304) {
      this.res.removeHeader('Content-Type');
      this.res.removeHeader('Content-Length');
      chunk = '';
    }

    if (this.req && this.req.method === 'HEAD') this.res.end();
    else this.res.end(chunk);
    return this;
  }

  json(obj) {
    const app = this.app;
    const body = stringify(obj, app && app.set('json replacer'), app && app.set('json spaces'));
    if (!this.get('Content-Type')) this.set('Content-Type', 'application/json');
    return this.send(body);
  }

  sendStatus(code) {
    const body = STATUS_CODES[code] || String(code);
    this.status(code);
    this.set('Content-Type', 'txt');
    return this.send(body);
  }

  redirect(url, status) {
    const code = status || 302;
    const address = encodeURI(url);
    this.status(code);
    this.set('Location', address);
    this.set('Content-Type', 'txt');
    return this.send(STATUS_CODES[code] + '. Redirecting to ' + address);
  }
}

/** JSON that is safe to inline in a script tag: the characters that would end one are escaped. */
function stringify(value, replacer, spaces) {
  const json = replacer || spaces ? JSON.stringify(value, replacer, spaces) : JSON.stringify(value);
  if (json === undefined) return json;
  return json.replace(/[<>&]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

module.exports = Response;
