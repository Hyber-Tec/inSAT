// Small HTTP helpers: consistent response envelope, async error handling,
// and zod body validation. Keeps route handlers free of try/catch boilerplate.

/** Wrap an async route so thrown errors hit the central error handler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** A thrown HttpError becomes a clean JSON error with the right status. */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const badRequest = (msg) => new HttpError(400, msg, 'bad_request');
export const unauthorized = (msg = 'Not authenticated') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
export const conflict = (msg) => new HttpError(409, msg, 'conflict');

/** Validate a body against a zod schema, returning typed data or throwing 400. */
export const parseBody = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(`${first.path.join('.') || 'body'}: ${first.message}`);
  }
  return result.data;
};

/** Express error handler - must be registered last. */
export const errorHandler = (err, _req, res, _next) => {
  // The AI client marks its own errors with a statusCode (a rejected key is the
  // admin's to fix, a 400; an unreachable service a 502).
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[api]', err);
  // A fault with no status of its own is ours (a database error, a bug): log
  // it, and tell the client no more than that.
  const ours = !err.status && !err.statusCode;
  res.status(status).json({
    error: typeof err.code === 'string' && !ours ? err.code : 'error',
    message: ours ? 'Something went wrong on our side. Please try again.' : (err.message || 'Internal server error'),
  });
};
