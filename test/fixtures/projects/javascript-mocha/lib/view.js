'use strict';

const fs = require('node:fs');
const path = require('node:path');
const debug = require('./debug')('switchyard:view');

/**
 * A template on disk: found under one of the view roots by name, and rendered by the engine registered for its extension.
 */
class View {
  constructor(name, options = {}) {
    this.defaultEngine = options.defaultEngine;
    this.ext = path.extname(name);
    this.name = name;
    this.root = options.root;

    if (!this.ext && !this.defaultEngine) {
      throw new Error('No default engine was specified and no extension was provided.');
    }

    let fileName = name;
    if (!this.ext) {
      this.ext = this.defaultEngine[0] !== '.' ? '.' + this.defaultEngine : this.defaultEngine;
      fileName += this.ext;
    }

    const engines = options.engines || {};
    if (!engines[this.ext]) throw new Error('No engine registered for "' + this.ext + '"');
    this.engine = engines[this.ext];
    this.path = this.lookup(fileName);
  }

  /** The first file named `name` under any of the roots, as `name` itself or as `name/index` with the extension. */
  lookup(name) {
    const roots = [].concat(this.root);
    debug('lookup "%s"', name);

    for (const root of roots) {
      const loc = path.resolve(root, name);
      const found = this.resolve(path.dirname(loc), path.basename(loc));
      if (found) return found;
    }
    return undefined;
  }

  render(options, callback) {
    debug('render "%s"', this.path);
    this.engine(this.path, options, callback);
  }

  resolve(dir, file) {
    const ext = this.ext;

    let candidate = path.join(dir, file);
    let stat = tryStat(candidate);
    if (stat && stat.isFile()) return candidate;

    candidate = path.join(dir, path.basename(file, ext), 'index' + ext);
    stat = tryStat(candidate);
    if (stat && stat.isFile()) return candidate;
    return undefined;
  }
}

function tryStat(file) {
  try {
    return fs.statSync(file);
  } catch (e) {
    return undefined;
  }
}

module.exports = View;
