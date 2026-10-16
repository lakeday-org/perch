'use strict';

module.exports = pathToRegexp;

/** A parameter, `/:name` or `/:name?`, or a `*` that matches anything. */
const TOKEN = /(\/)?:(\w+)(\?)?|\*/g;

/**
 * Turns an Express-style path such as `/users/:id` into a regular expression, pushing the name of each parameter onto `keys`
 * in the order its group appears.
 *
 * Options:
 *   - sensitive  match case exactly (default false)
 *   - strict     a trailing slash must match exactly (default false)
 *   - end        the expression must match the whole path (default true)
 */
function pathToRegexp(path, keys, options) {
  const opts = options || {};
  keys = keys || [];
  const flags = opts.sensitive ? '' : 'i';

  if (path instanceof RegExp) {
    // A regular expression's groups are named by position.
    const groups = path.source.match(/\((?!\?)/g) || [];
    groups.forEach((_, index) => keys.push({ name: index, optional: false }));
    return path;
  }

  if (Array.isArray(path)) {
    const sources = path.map(item => pathToRegexp(item, keys, opts).source);
    return new RegExp('(?:' + sources.join('|') + ')', flags);
  }

  let pattern = '';
  let index = 0;
  let unnamed = 0;
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(path)) !== null) {
    pattern += escapeString(path.slice(index, match.index));
    index = match.index + match[0].length;

    if (match[0] === '*') {
      keys.push({ name: unnamed++, optional: false });
      pattern += '(.*)';
      continue;
    }

    const slash = match[1] || '';
    keys.push({ name: match[2], optional: Boolean(match[3]) });
    pattern += match[3] ? '(?:' + slash + '([^/]+?))?' : slash + '([^/]+?)';
  }
  pattern += escapeString(path.slice(index));

  if (!opts.strict) pattern = pattern.replace(/\/$/, '') + '/?';
  pattern = '^' + pattern + (opts.end === false ? '(?=/|$)' : '$');

  return new RegExp(pattern, flags);
}

function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|\\])/g, '\\$1');
}
