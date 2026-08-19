import { APP_CONFIG } from '../config';

/**
 * Indian digit grouping: 12,34,567.89 -- not 1,234,567.89.
 * Written by hand rather than via Intl, because Hermes ships without full
 * ICU data on some Android builds and would silently fall back to en-US.
 */
export function formatINR(value, { withSymbol = true, decimals = 'auto' } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return withSymbol ? `${APP_CONFIG.currencySymbol}0` : '0';

  const negative = n < 0;
  const abs = Math.abs(n);
  const showDecimals = decimals === 'auto' ? Math.round(abs * 100) % 100 !== 0 : decimals > 0;
  const fixed = abs.toFixed(showDecimals ? 2 : 0);
  const [whole, fraction] = fixed.split('.');

  let grouped;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const lastThree = whole.slice(-3);
    const rest = whole.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
  }

  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return `${negative ? '-' : ''}${withSymbol ? APP_CONFIG.currencySymbol : ''}${body}`;
}

/** Money maths in paise, so 0.1 + 0.2 never becomes 0.30000000000000004. */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Strips anything that is not a digit or a single dot -- for numeric TextInputs. */
export function sanitiseDecimal(text) {
  const cleaned = String(text).replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  return parts.length <= 2 ? cleaned : `${parts[0]}.${parts.slice(1).join('')}`;
}

export function sanitiseInteger(text) {
  return String(text).replace(/[^0-9]/g, '');
}

/** dd MMM yyyy, locale-independent so it never depends on ICU data. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(value, { withTime = false } = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  const base = `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (!withTime) return base;
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'am' : 'pm';
  return `${base}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

/** YYYY-MM-DD for the report ?from= / ?to= params. */
export function toApiDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * "3 min ago" for the offline staleness banner. Returns the i18n key and its
 * count so the caller can translate -- Hindi and Gujarati word these units
 * differently, so the string cannot be assembled here.
 */
export function relativeAge(timestamp, now = Date.now()) {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return { key: 'offline.justNow', n: 0 };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { key: 'offline.minutesAgo', n: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { key: 'offline.hoursAgo', n: hours };
  return { key: 'offline.daysAgo', n: Math.round(hours / 24) };
}
