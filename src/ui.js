/**
 * Progress on stderr for interactive runs. A task is one step (a test run, a model call): while it runs a spinner and the elapsed
 * time are redrawn on one line; when it ends the line is replaced by a mark, the label, and what came back. When stderr is not a
 * terminal, or output is JSON or verbose, each task is two plain log lines instead.
 */
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const OK = '✓', FAIL = '✗', NOTE = '·';
const seconds = ms => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

export function createUi({ stream = process.stderr, live = Boolean(stream.isTTY), log = () => {} } = {}) {
  // Running tasks nest: a tool call inside a model run. The innermost is drawn; when it ends, the one around it is drawn again.
  const stack = [];
  const top = () => stack.at(-1) ?? null;
  const drawn = entry => (entry.width ? entry.label.padEnd(entry.width) : entry.label);
  const draw = () => { const current = top(); if (current) stream.write(`\r\x1b[K${current.indent}${frames[current.frame++ % frames.length]} ${drawn(current)}  ${seconds(Date.now() - current.started)}`); };
  let timer = null;
  // A step given a width is one line of a column: every label is padded to the same place, so every detail starts there too.
  // Without one it is a sentence, and the detail reads as a clause of it.
  const finishLine = (mark, entry, detail, ms) => `${entry.indent}${mark} ${drawn(entry)}${entry.width ? (detail ? `  ${detail}` : '') : detail ? ` — ${detail}` : ''}  ${seconds(ms)}`;
  return {
    live,
    /** Start one step; returns handles that end it with a mark and a detail. */
    task(label, { width = 0, indent = '' } = {}) {
      const entry = { label, width, indent, started: Date.now(), frame: 0, open: true };
      if (!live) log(label);
      else { stack.push(entry); draw(); if (!timer) timer = setInterval(draw, 100); }
      const end = (mark, detail = '') => {
        if (!entry.open) return detail;
        entry.open = false;
        const ms = Date.now() - entry.started;
        if (live) {
          const at = stack.indexOf(entry);
          if (at >= 0) stack.splice(at, 1);
          if (!stack.length && timer) { clearInterval(timer); timer = null; }
          stream.write(`\r\x1b[K${finishLine(mark, entry, detail, ms)}\n`);
          draw();
        } else log(finishLine(mark, entry, detail, ms));
        return detail;
      };
      return { ok: detail => end(OK, detail), fail: detail => end(FAIL, detail), note: detail => end(NOTE, detail), update: label2 => { entry.label = label2; } };
    },
    /** A plain line between steps: a heading for the finding, a commit, a summary. */
    say(...lines) { for (const text of lines) { if (live) { stream.write(`\r\x1b[K${text}\n`); draw(); } else log(text); } },
  };
}

/** The ui used when none is given: every step is a log line. */
export const plainUi = (log = () => {}) => createUi({ live: false, log });
