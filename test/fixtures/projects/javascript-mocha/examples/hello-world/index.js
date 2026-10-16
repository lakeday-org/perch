'use strict';

const switchyard = require('../..');

const app = module.exports = switchyard();

app.get('/', function (req, res) {
  res.reply.send('Hello World');
});

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000);
  console.log('Switchyard started on port 3000');
}
