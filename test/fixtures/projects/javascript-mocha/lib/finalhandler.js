'use strict';

const { STATUS_CODES } = require('node:http');

/**
 * The handler a request ends in when nothing answered it: a 404, or the error's own status with its stack outside production.
 */
module.exports = function finalhandler(req, res, options) {
  const opts = options || {};
  const env = opts.env || 'development';

  return function (err) {
    let status;
    let message;

    if (err) {
      status = statusOf(err);
      message = env === 'production' ? STATUS_CODES[status] : err.stack || String(err);
      if (typeof opts.onerror === 'function') setImmediate(opts.onerror, err, req, res);
    } else {
      status = 404;
      message = 'Cannot ' + req.method + ' ' + (req.originalUrl || req.url);
    }

    // Too late to answer: drop the connection so the client sees it fail.
    if (res.headersSent) {
      if (req.socket) req.socket.destroy();
      return;
    }

    send(req, res, status, message);
  };
};

function statusOf(err) {
  const status = err.status || err.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
}

function send(req, res, status, message) {
  const body = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>' +
    escapeHtml(message).replace(/\n/g, '<br>') + '</pre>\n</body>\n</html>\n';

  res.statusCode = status;
  res.statusMessage = STATUS_CODES[status];
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));

  if (req.method === 'HEAD') return res.end();
  res.end(body, 'utf8');
}
