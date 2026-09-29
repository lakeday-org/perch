/** The language pack selects syntax boundaries; token estimates decide how much source fits. */
import pack from '@xberg-io/tree-sitter-language-pack';
import { textTokens, TOKEN_LIMITS, IncompleteCheckError } from './tokens.js';

/** A suffix bounded in estimated tokens, without splitting a Unicode character. */
function overlapStart(bytes, end, tokens) {
  let low = 0, high = end;
  while (low < high) {
    let mid = Math.floor((low + high) / 2);
    // Back up to the character's lead byte. Skipping forward could land on `high` itself, and then neither branch moved the
    // range: an emoji or CJK character straddling the midpoint hung the search for good.
    while (mid > low && (bytes[mid] & 0xc0) === 0x80) mid--;
    if (textTokens(bytes.subarray(mid, end).toString('utf8')) <= tokens) high = mid;
    else low = mid + 1;
    if (high - low < 4) break;
  }
  let start = high;
  while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}

/** Bytes handed to the native chunker at once. */
export const WINDOW_BYTES = 256 * 1024;

/**
 * The native chunker's syntax-bounded pieces of a source, given it a window at a time. Its time grows with the square of what
 * it is handed: a 4 MB file took five seconds to split and an 8 MB one a minute, where parsing either takes a fraction of one.
 * Windows end on a line break, so a piece is only ever cut at a place a line could end anyway.
 */
function nativeChunks(bytes, options) {
  const pieces = [];
  for (let from = 0; from < bytes.length;) {
    let to = Math.min(bytes.length, from + WINDOW_BYTES);
    if (to < bytes.length) {
      const newline = bytes.lastIndexOf(10, to - 1);
      if (newline >= from) to = newline + 1;
      else while (to > from + 1 && (bytes[to] & 0xc0) === 0x80) to--;
    }
    const chunks = pack.process(bytes.subarray(from, to).toString('utf8'), options).chunks;
    if (!chunks?.length) return [];
    for (const chunk of chunks) pieces.push({ startByte: chunk.startByte + from, endByte: chunk.endByte + from, content: chunk.content });
    from = to;
  }
  return pieces;
}

export function sourceChunks(source, { path, maxTokens = TOKEN_LIMITS.state / 2, overlap = 256 } = {}) {
  if (!Number.isInteger(maxTokens) || maxTokens < 32) throw new IncompleteCheckError('no token budget remains for source');
  const bytes = Buffer.from(source), tokens = textTokens(source);
  if (tokens <= maxTokens) return [{ source, startByte: 0, endByte: bytes.length, line: 1, endLine: source.split('\n').length }];
  const language = pack.detectLanguageFromPath(path ?? '') ?? 'markdown';
  const repeated = Math.min(overlap, Math.floor(maxTokens / 4));
  // The native API takes bytes. Derive its split target from this source's token density,
  // then validate chunks in tokens. This is not a file or request byte limit.
  let target = Math.max(4, Math.floor(bytes.length * (maxTokens - repeated) / tokens));
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
  const lineAt = offset => {
    let low = 0, high = starts.length;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (starts[mid] <= offset) low = mid + 1; else high = mid; }
    return low;
  };
  for (;;) {
    const chunks = nativeChunks(bytes, { language, chunkMaxSize: target, structure: false, imports: false, exports: false });
    if (!chunks?.length) throw new IncompleteCheckError(`${path}: parser produced no chunks`);
    let through = 0, largest = 0;
    const result = [];
    for (const chunk of chunks) {
      if (chunk.startByte !== through || chunk.endByte <= through || chunk.endByte > bytes.length)
        throw new IncompleteCheckError(`${path}: chunk ranges omit or reorder source at byte ${through}`);
      if (chunk.content !== bytes.subarray(chunk.startByte, chunk.endByte).toString('utf8'))
        throw new IncompleteCheckError(`${path}: chunk content differs from the source`);
      const previous = result.at(-1)?.startByte ?? 0;
      const start = previous + overlapStart(bytes.subarray(previous, chunk.startByte), chunk.startByte - previous, repeated);
      const body = bytes.subarray(start, chunk.endByte).toString('utf8');
      largest = Math.max(largest, textTokens(body));
      result.push({ source: body, startByte: start, endByte: chunk.endByte, line: lineAt(start), endLine: lineAt(Math.max(start, chunk.endByte - 1)) });
      through = chunk.endByte;
    }
    if (through !== bytes.length) throw new IncompleteCheckError(`${path}: unread source after byte ${through}`);
    if (largest <= maxTokens) return result;
    const smaller = Math.max(4, Math.floor(target * Math.min(0.8, maxTokens / largest)));
    if (smaller >= target) throw new IncompleteCheckError(`${path}: native chunk cannot fit the token budget`);
    target = smaller;
  }
}
