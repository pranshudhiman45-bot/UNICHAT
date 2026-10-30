// Express 4 does not catch promise rejections from async route handlers; on current Node versions an
// unhandled rejection terminates the process. This forwards them to the error-handling middleware instead,
// so a database hiccup in one request produces a 500 for that request rather than taking the API down.
const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const handler = this.handle;
  if (handler.length > 3) return next(); // error-handling middleware is invoked via handle_error
  try {
    const result = handler(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (error) {
    next(error);
  }
  return undefined;
};
module.exports = { original };
