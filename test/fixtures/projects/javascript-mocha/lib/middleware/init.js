'use strict';

const Response = require('../response');

/**
 * The first middleware an application runs: it links the request and the response to each other and to the app, and gives
 * the response its helpers as `res.reply`.
 */
exports.init = function (app) {
  return function switchyardInit(req, res, next) {
    if (app.enabled('x-powered-by')) res.setHeader('X-Powered-By', 'Switchyard');
    req.res = res;
    res.req = req;
    req.app = app;
    res.locals = res.locals || Object.create(null);
    res.reply = new Response(res, req, app);
    next();
  };
};
