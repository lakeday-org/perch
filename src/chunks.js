/** Source splitting belongs to the language pack. Perch adds overlap, budgets and verified source positions. */
import pack from '@xberg-io/tree-sitter-language-pack';

// Byte budgets deliberately leave room below Jev's token limits. They are conservative request budgets, not token counts.
export const STATE_BYTES = 24 * 1024, SINGLE_BYTES = 30 * 1024, REQUEST_BYTES = 60 * 1024;
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
export class IncompleteCheckError extends Error {
  constructor(message) { super(`Check incomplete: ${message}`); this.name = 'IncompleteCheckError'; }
}

export function sourceChunks(source, { path, maxBytes = STATE_BYTES / 2, overlap = 1024 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 32) throw new IncompleteCheckError('no room remains for source');
  const bytes = Buffer.from(source);
  if (bytes.length <= maxBytes) return [{ source, startByte: 0, endByte: bytes.length, line: 1, endLine: source.split('\n').length }];
  const language = pack.detectLanguageFromPath(path ?? '') ?? 'markdown';
  const repeated = Math.min(overlap, Math.floor(maxBytes / 4));
  const chunks = pack.process(source, { language, chunkMaxSize: maxBytes - repeated, structure: false, imports: false, exports: false }).chunks;
  if (!chunks?.length) throw new IncompleteCheckError(`${path}: parser produced no chunks`);
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
  const lineAt = offset => {
    let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= offset) low = mid + 1; else high = mid; }
    return low;
  };
  let through = 0;
  const result = [];
  for (const chunk of chunks) {
    if (chunk.startByte !== through || chunk.endByte <= through || chunk.endByte > bytes.length)
      throw new IncompleteCheckError(`${path}: chunk ranges omit or reorder source at byte ${through}`);
    if (chunk.content !== bytes.subarray(chunk.startByte, chunk.endByte).toString('utf8'))
      throw new IncompleteCheckError(`${path}: chunk content differs from the source`);
    let start = Math.max(0, chunk.startByte - repeated);
    while (start < chunk.startByte && (bytes[start] & 0xc0) === 0x80) start++;
    const body = bytes.subarray(start, chunk.endByte).toString('utf8');
    if (Buffer.byteLength(body) > maxBytes) throw new IncompleteCheckError(`${path}: native chunk is too large`);
    result.push({ source: body, startByte: start, endByte: chunk.endByte, line: lineAt(start), endLine: lineAt(Math.max(start, chunk.endByte - 1)) });
    through = chunk.endByte;
  }
  if (through !== bytes.length) throw new IncompleteCheckError(`${path}: unread source after byte ${through}`);
  return result;
}

/** Questions are independent; batch them before sending, accounting for the repeated state and every criterion. */
export function questionBatches(state, questions) {
  const size = jsonBytes(state);
  if (size > STATE_BYTES) throw new IncompleteCheckError('request state is too large; split its source before sending');
  const batches = [];
  let current = {};
  for (const [name, question] of Object.entries(questions)) {
    if (size + jsonBytes({ [name]: question }) > SINGLE_BYTES)
      throw new IncompleteCheckError(`question ${name} and its context are too large`);
    if (question.criteria && Object.keys(question.criteria).length > 255)
      throw new IncompleteCheckError(`question ${name} has more than 255 choices`);
    const next = { ...current, [name]: question };
    if (size + jsonBytes(next) > REQUEST_BYTES && Object.keys(current).length) { batches.push(current); current = {}; }
    current[name] = question;
  }
  if (Object.keys(current).length || !batches.length) batches.push(current);
  return batches;
}
