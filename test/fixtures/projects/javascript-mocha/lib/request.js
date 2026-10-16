'use strict';

const { normalizeTypes } = require('./utils');

/** A request header by name, in any case. Referer and Referrer are the same header. */
function header(req, name) {
  if (typeof name !== 'string') throw new TypeError('name argument is required to header()');

  const lc = name.toLowerCase();
  switch (lc) {
    case 'referer':
    case 'referrer':
      return req.headers.referrer || req.headers.referer;
    default:
      return req.headers[lc];
  }
}

/** Which of `types` the client's Accept header prefers, or false when it accepts none of them. */
function accepts(req, ...types) {
  const offered = types.flat();
  const accept = header(req, 'Accept');
  if (!accept || accept === '*/*') return offered[0] || false;

  const ranges = parseAccept(accept);
  const full = normalizeTypes(offered);
  let best = false;
  let bestQuality = 0;
  full.forEach((type, i) => {
    const q = quality(ranges, type);
    if (q > bestQuality) {
      best = offered[i];
      bestQuality = q;
    }
  });
  return best;
}

function parseAccept(value) {
  return value.split(',').map(part => {
    const [range, ...params] = part.trim().split(';');
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='));
    return { range: range.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
  }).filter(item => item.q > 0);
}

function quality(ranges, type) {
  const kind = type.split('/')[0];
  let best = 0;
  for (const { range, q } of ranges) {
    if (range === type || range === '*/*' || range === kind + '/*') best = Math.max(best, q);
  }
  return best;
}

/** "https" or "http", from X-Forwarded-Proto when the proxy in front is trusted. */
function protocol(req, trust) {
  const proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  if (!trust || !trust(req.socket && req.socket.remoteAddress, 0)) return proto;

  const forwarded = header(req, 'X-Forwarded-Proto') || proto;
  const comma = forwarded.indexOf(',');
  return comma !== -1 ? forwarded.slice(0, comma).trim() : forwarded.trim();
}

/** The host the client asked for, without its port, from X-Forwarded-Host when the proxy in front is trusted. */
function hostname(req, trust) {
  let host = header(req, 'X-Forwarded-Host');
  if (!host || !trust || !trust(req.socket && req.socket.remoteAddress, 0)) host = header(req, 'Host');
  else if (host.indexOf(',') !== -1) host = host.slice(0, host.indexOf(',')).trimEnd();
  if (!host) return undefined;

  // An IPv6 literal is bracketed, and its colons are not the port's.
  const offset = host[0] === '[' ? host.indexOf(']') + 1 : 0;
  const index = host.indexOf(':', offset);
  return index !== -1 ? host.slice(0, index) : host;
}

function xhr(req) {
  const value = header(req, 'X-Requested-With') || '';
  return value.toLowerCase() === 'xmlhttprequest';
}

module.exports = { header, accepts, protocol, hostname, xhr };
