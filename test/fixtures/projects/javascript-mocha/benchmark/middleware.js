'use strict';

/**
 * A server with $MW no-op middleware in front of one route, for `autocannon` or `wrk` to load:
 *
 *   MW=50 node benchmark/middleware.js & autocannon -c 50 -d 5 http://localhost:3333/
 */
const switchyard = require('..');

const app = switchyard();
const count = parseInt(process.env.MW || '1', 10);
console.log('  %s middleware', count);

for (let n = count; n > 0; n--) {
  app.use(function (req, res, next) {
    next();
  });
}

app.get('/', function (req, res) {
  res.reply.send('Hello World');
});

app.listen(3333);
