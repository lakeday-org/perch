/*!
 * switchyard
 * MIT Licensed
 */

'use strict';

const createApplication = require('./lib/application');

exports = module.exports = createApplication;

exports.Application = createApplication.Application;
exports.Router = require('./lib/router');
exports.Route = require('./lib/router/route');
exports.Response = require('./lib/response');
exports.request = require('./lib/request');
exports.query = require('./lib/middleware/query');
