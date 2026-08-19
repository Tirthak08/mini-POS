export function notFound(req, res) {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
}

/**
 * Single funnel for every error. Express 5 forwards rejected async handlers
 * here automatically, so route code needs no try/catch boilerplate.
 */
export function errorHandler(err, _req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  if (err.name === 'ValidationError' && err.errors) {
    status = 400;
    message = 'Validation failed';
    details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    message = `That ${Object.keys(err.keyValue || { value: 1 }).join(', ')} is already taken`;
  } else if (err.name === 'MongooseServerSelectionError') {
    status = 503;
    message = 'Cannot reach the database. Check your Atlas IP allow-list and connection string.';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  }

  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    ok: false,
    error: message,
    ...(details && { details }),
    ...(process.env.NODE_ENV !== 'production' && status >= 500 && { stack: err.stack }),
  });
}
