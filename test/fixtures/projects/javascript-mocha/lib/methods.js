'use strict';

const http = require('node:http');

/** The HTTP methods Node's parser knows, lower-cased, as route and router methods are named. */
module.exports = http.METHODS.map(method => method.toLowerCase()).sort();
