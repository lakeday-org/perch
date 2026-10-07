'use strict';

const switchyard = require('../..');

const app = module.exports = switchyard();

const users = [
  { name: 'tj' },
  { name: 'tobi' },
  { name: 'loki' },
  { name: 'jane' },
  { name: 'bandit' },
];

// Load the user once for every route that names :user.
app.param('user', function (req, res, next, id) {
  const user = users[id];
  if (!user) return next(Object.assign(new Error('failed to find user'), { status: 404 }));
  req.user = user;
  next();
});

app.get('/', function (req, res) {
  res.reply.send('Visit /user/0 or /users/0-2');
});

app.get('/user/:user', function (req, res) {
  res.reply.send('user ' + req.user.name);
});

app.get('/users/:from-:to', function (req, res) {
  const from = Number(req.params.from);
  const to = Number(req.params.to);
  const names = users.map(user => user.name);
  res.reply.send('users ' + names.slice(from, to + 1).join(', '));
});

/* istanbul ignore next */
if (!module.parent) {
  app.listen(3000);
  console.log('Switchyard started on port 3000');
}
