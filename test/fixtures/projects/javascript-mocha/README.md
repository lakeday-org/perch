# switchyard

Small, fast HTTP routing for Node, in the shape of the Express 4 router.

```js
const switchyard = require('switchyard');
const app = switchyard();

app.get('/users/:id', (req, res) => {
  res.reply.json({ id: req.params.id });
});

app.listen(3000);
```

`npm test` runs the suite; `npm run test-cov` runs it under c8.
