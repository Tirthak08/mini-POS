import jwt from 'jsonwebtoken';
import { ApiError } from './ApiError.js';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16 || s.includes('replace_with')) {
    throw new Error('JWT_SECRET is missing or still a placeholder. Set a long random value in backend/.env');
  }
  return s;
}

const EXPIRES = process.env.JWT_EXPIRES_IN || '30d';

/**
 * The token is the ONLY source of businessId for protected routes.
 * A client cannot read another tenant's data by putting a different
 * businessId in the request body -- nothing reads it from there.
 */
export function signBusinessToken(business) {
  return jwt.sign(
    { sub: business.businessId, role: 'business', name: business.name },
    secret(),
    { expiresIn: EXPIRES }
  );
}

export function signAdminToken(username) {
  return jwt.sign({ sub: username, role: 'admin' }, secret(), { expiresIn: '12h' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, secret());
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw ApiError.unauthorized('Session expired, please sign in again');
    if (err.name === 'JsonWebTokenError') throw ApiError.unauthorized('Invalid session token');
    throw err;
  }
}
