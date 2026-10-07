import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';

/**
 * Watches configuration files and emits "change" once a burst of writes to one has settled, since an editor saving a file often
 * writes it more than once.
 */
export class ConfigWatcher extends EventEmitter {
  constructor(files, { debounce = 50 } = {}) {
    super();
    this.debounce = debounce;
    this.timer = null;
    this.watchers = files.map(file => watch(file, () => this.schedule(file)));
  }

  schedule(file) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit('change', file), this.debounce);
  }

  close() {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}

export function watchConfig(files, onChange, options) {
  const watcher = new ConfigWatcher(files, options);
  watcher.on('change', onChange);
  return watcher;
}
