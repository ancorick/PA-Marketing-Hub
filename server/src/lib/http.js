// HTTP helpers: security headers, rate limiting (NFR-S6), error handling.
import { HttpError } from './util.js';
import { config } from '../config.js';

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (config.baseUrl.startsWith('https://')) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

const buckets = new Map();
export function rateLimit({ windowMs = 60_000, max = 60, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const k = `${req.path}:${key(req)}`;
    const t = Date.now();
    const b = buckets.get(k) || { start: t, n: 0 };
    if (t - b.start > windowMs) { b.start = t; b.n = 0; }
    b.n++;
    buckets.set(k, b);
    if (b.n > max) {
      res.set('Retry-After', String(Math.ceil((b.start + windowMs - t) / 1000)));
      return next(new HttpError(429, 'Too many requests, try again shortly'));
    }
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 600_000) buckets.delete(k); }, 600_000).unref();

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  if (err.type === 'entity.parse.failed') status = 400;
  if (err.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(err.message)) status = 409;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our side. The error was logged.' : err.message,
    details: err.details,
  });
}
