import { verifyToken } from '../utils/token.js';
import { ApiError } from '../utils/ApiError.js';

function bearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme || '') || !token) {
    throw ApiError.unauthorized('Missing Authorization: Bearer <token> header');
  }
  return token.trim();
}

/**
 * Gate for every tenant route. Sets req.businessId from the SIGNED TOKEN.
 * Controllers must use req.businessId and never req.body.businessId --
 * that is what makes the multi-tenancy in PRD section 4 actually hold.
 */
export function requireBusiness(req, _res, next) {
  const payload = verifyToken(bearer(req));
  if (payload.role !== 'business' || !payload.sub) {
    throw ApiError.forbidden('This endpoint requires a business login');
  }
  req.businessId = payload.sub;
  req.businessName = payload.name;
  next();
}

/**
 * Same as requireBusiness, but also accepts `?token=` in the query string.
 *
 * Only <img>-style media routes use this. React Native's <Image source> can pass
 * headers on native, but not on web, and a plain URL is what makes browser and
 * OS-level image caching work. Scoped to GET so no state can be changed with a
 * token that may end up in a log or a Referer header.
 */
export function requireBusinessForMedia(req, _res, next) {
  const header = req.headers.authorization;
  const token = header ? bearer(req) : String(req.query.token || '').trim();
  if (!token) throw ApiError.unauthorized('Missing Authorization header or ?token=');

  const payload = verifyToken(token);
  if (payload.role !== 'business' || !payload.sub) {
    throw ApiError.forbidden('This endpoint requires a business login');
  }
  req.businessId = payload.sub;
  req.businessName = payload.name;
  next();
}

export function requireAdmin(req, _res, next) {
  const payload = verifyToken(bearer(req));
  if (payload.role !== 'admin') throw ApiError.forbidden('Super admin access required');
  req.adminUser = payload.sub;
  next();
}
