# stratum

Layered configuration for Node. Defaults, then each file in order, then the environment, then command-line flags; merged,
`${VAR:-default}` interpolated, and checked against a schema.

```js
import { loadConfig } from 'stratum';

const config = await loadConfig({
  files: ['config/default.json', { path: 'config/local.json', optional: true }],
  prefix: 'APP',
  argv: process.argv.slice(2),
  schema: {
    server: { port: { type: 'port', default: 8080 } },
    db: { url: { type: 'url', required: true } },
  },
});
```

`npm test` runs the suite with `node --test`.
