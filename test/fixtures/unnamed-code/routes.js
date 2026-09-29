const app = require('express')();

app.get('/user', (req, res) => {
  res.send(req.query.name);
});
