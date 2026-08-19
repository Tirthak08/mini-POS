import mongoose from 'mongoose';
import { ApiError } from './ApiError.js';

/** Throws a single 400 listing every missing field, instead of failing one at a time. */
export function requireFields(body = {}, fields = []) {
  const missing = fields.filter((f) => {
    const v = body[f];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
  if (missing.length) {
    throw ApiError.badRequest(
      `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      Object.fromEntries(missing.map((f) => [f, 'required']))
    );
  }
}

/** PRD 4: 4-6 digit PIN. Digits only -- the mobile keypad sends strings. */
export function assertValidPin(pin, field = 'pin') {
  if (!/^\d{4,6}$/.test(String(pin ?? ''))) {
    throw ApiError.badRequest('PIN must be 4 to 6 digits', { [field]: 'must be 4-6 digits (0-9 only)' });
  }
  return String(pin);
}

/** Coerces to a finite number >= 0. React Native TextInputs always send strings. */
export function toAmount(value, field, { required = false, max = 1e9 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw ApiError.badRequest(`${field} is required`, { [field]: 'required' });
    return 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw ApiError.badRequest(`${field} must be a number`, { [field]: 'not a number' });
  if (n < 0) throw ApiError.badRequest(`${field} cannot be negative`, { [field]: 'must be >= 0' });
  if (n > max) throw ApiError.badRequest(`${field} is unrealistically large`, { [field]: `must be <= ${max}` });
  return round2(n);
}

/** Whole-number quantity/stock. */
export function toCount(value, field, { required = false, min = 0, max = 1_000_000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw ApiError.badRequest(`${field} is required`, { [field]: 'required' });
    return min;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw ApiError.badRequest(`${field} must be a whole number`, { [field]: 'must be an integer' });
  if (n < min) throw ApiError.badRequest(`${field} must be at least ${min}`, { [field]: `must be >= ${min}` });
  if (n > max) throw ApiError.badRequest(`${field} is too large`, { [field]: `must be <= ${max}` });
  return n;
}

export function assertObjectId(id, field = 'id') {
  if (!mongoose.Types.ObjectId.isValid(String(id ?? ''))) {
    throw ApiError.badRequest(`${field} is not a valid id`, { [field]: 'invalid ObjectId' });
  }
  return String(id);
}

/** Money is stored in rupees as a Number -- always round to paise to avoid float drift. */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Parses ?from=&to= into a Date range, defaulting to the last 30 days. */
export function parseDateRange(query = {}) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 29 * 864e5);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw ApiError.badRequest('from/to must be valid dates (YYYY-MM-DD or ISO)');
  }
  if (!query.to) to.setHours(23, 59, 59, 999);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to.setHours(23, 59, 59, 999);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.from ?? ''))) from.setHours(0, 0, 0, 0);
  if (from > to) throw ApiError.badRequest('"from" must be before "to"');
  return { from, to };
}
