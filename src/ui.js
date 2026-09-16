/**
 * Progress on stderr for interactive runs. A task is one step (a test run, a model call): while it runs a spinner and the elapsed
 * time are redrawn on one line; when it ends the line is replaced by a mark, the label, and what came back. When stderr is not a
 * terminal, or output is JSON or verbose, each task is two plain log lines instead.
 */
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const OK = '✓', FAIL = '✗', NOTE = '·';
const seconds = ms => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

export function createUi({ stream = process.stderr, live = Boolean(stream.isTTY), log = () => {} } = {}) {
  let current = null;
  const draw = () => { if (current) stream.write(`\r\x1b[K${frames[current.frame++ % frames.length]} ${current.label}  ${seconds(Date.now() - current.started)}`); };
  const finishLine = (mark, label, detail, ms) => `${mark} ${label}${detail ? ` — ${detail}` : ''}  ${seconds(ms)}`;
  return {
    live,
    /** Start one step; returns handles that end it with a mark and a detail. */
    task(label) {
      const started = Date.now();
      if (!live) log(label);
      else { current = { label, started, frame: 0 }; draw(); current.timer = setInterval(draw, 100); }
      const end = (mark, detail = '') => {
        const ms = Date.now() - started;
        if (live && current) { clearInterval(current.timer); stream.write(`\r\x1b[K${finishLine(mark, label, detail, ms)}\n`); current = null; }
        else log(`${mark} ${label}${detail ? ` — ${detail}` : ''} (${seconds(ms)})`);
        return detail;
      };
      return { ok: detail => end(OK, detail), fail: detail => end(FAIL, detail), note: detail => end(NOTE, detail), update: label2 => { if (current) current.label = label2; } };
    },
    /** A plain line between steps: a heading for the finding, a commit, a summary. */
    say(text) { if (live) stream.write(`\r\x1b[K${text}\n`); else log(text); },
  };
}

/** The ui used when none is given: every step is a log line. */
export const plainUi = (log = () => {}) => createUi({ live: false, log });
