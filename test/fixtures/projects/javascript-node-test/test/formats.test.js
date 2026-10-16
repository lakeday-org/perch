import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dotenv, formatFor, ini, json } from '../src/formats/index.js';
import { ConfigError } from '../src/errors.js';

describe('formats', () => {
  describe('json', () => {
    it('parses JSON with comments and trailing commas', () => {
      const text = '{\n  // the port\n  "port": 8080, /* default */\n  "url": "http://x//y",\n}';

      assert.deepEqual(json(text), { port: 8080, url: 'http://x//y' });
    });

    it('names the file in a syntax error', () => {
      assert.throws(() => json('{ "port": }', 'config/app.json'), err => err instanceof ConfigError && err.file === 'config/app.json');
    });
  });

  describe('ini', () => {
    it('reads sections, nested sections and quoted values', () => {
      const text = '; comment\nname = app\n[db]\nport = 5432\n[db.replica]\nhost = "10.0.0.2"\n';

      assert.deepEqual(ini(text), { name: 'app', db: { port: 5432, replica: { host: '10.0.0.2' } } });
    });
  });

  describe('dotenv', () => {
    it('reads quoted values, escapes and trailing comments', () => {
      const text = 'export TOKEN=abc # set by CI\nGREETING="hello\\nworld"\nRAW=\'a\\nb\'\n# a comment\n';

      assert.deepEqual(dotenv(text), { TOKEN: 'abc', GREETING: 'hello\nworld', RAW: 'a\\nb' });
    });
  });

  describe('formatFor', () => {
    it('picks a parser by extension', () => {
      assert.equal(formatFor('config/app.jsonc'), json);
      assert.equal(formatFor('.env.local'), dotenv);
    });

    it('rejects a file it has no parser for', () => {
      assert.throws(() => formatFor('config/app.yaml'), /no parser for config\/app\.yaml/);
    });
  });
});
