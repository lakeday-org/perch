import { ConfigError } from '../errors.js';

/** JSON as tsconfig.json is written: with comments and trailing commas. A syntax error names the file. */
export default function parseJson(text, file = '<json>') {
  try {
    return JSON.parse(stripComments(text));
  } catch (err) {
    throw new ConfigError(`${file}: ${err.message}`, { file, cause: err });
  }
}

/** `text` without its // and /* comments or trailing commas. Strings are copied as they are. */
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
