/**
 * How a product is measured — the app's copy of the server's rule.
 *
 * Duplicated deliberately rather than fetched: the POS has to decide whether to
 * offer a decimal keypad the instant an item enters the cart, and a screen that
 * had to ask the server what half a kilo means would be unusable. The server
 * still refuses anything this lets through, so the two disagreeing costs a 400,
 * not a wrong bill.
 */
export const UNITS = Object.freeze(['pcs', 'pkt', 'box', 'dozen', 'kg', 'g', 'l', 'ml', 'm']);

const MEASURED = new Set(['kg', 'g', 'l', 'ml', 'm']);

export const DEFAULT_UNIT = 'pcs';

export const allowsFraction = (unit) => MEASURED.has(String(unit ?? DEFAULT_UNIT));

export function round3(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

/**
 * A quantity as it should read on screen.
 *
 * `pcs` prints bare. It is the default and by far the most common, and "3 pcs"
 * on every row of every cart is noise that pushes the things that do matter off
 * the end of the line. Every other unit prints, because "2" and "2 pkt" are
 * different facts.
 */
export function formatQty(qty, unit = DEFAULT_UNIT) {
  const n = round3(Number(qty) || 0);
  // Trailing zeros dropped: 2.50 kg reads as a price, not a weight.
  const text = String(n);
  return unit && unit !== DEFAULT_UNIT ? `${text} ${unit}` : text;
}

/**
 * Text from a numeric field, as a quantity — or null when it is not one yet.
 *
 * Null rather than 0 for the empty case, for the same reason the stocktake
 * draws that distinction: a field nobody has finished typing into is not a
 * quantity of zero. "2." is mid-typing and must not collapse to 2 under the
 * operator's fingers.
 */
export function parseQty(text, unit = DEFAULT_UNIT) {
  if (text === null || text === undefined) return null;
  const raw = String(text).trim();
  if (raw === '' || raw === '.' || raw.endsWith('.')) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!allowsFraction(unit) && !Number.isInteger(n)) return null;
  return round3(n);
}

/**
 * Keeps a quantity field typeable: digits, and one dot when the unit allows it.
 *
 * For a countable unit the decimal point and everything after it is DROPPED,
 * not stripped out. Stripping "18.5" of its dot leaves "185" -- a tenfold
 * error, silently, in the field where the operator is least likely to look
 * twice. Truncating to "18" is the only reading of "18.5 pieces" that cannot
 * cost anybody money.
 */
export function sanitiseQty(text, unit = DEFAULT_UNIT) {
  const raw = String(text ?? '');
  if (!allowsFraction(unit)) return raw.replace(/[^0-9.]/g, '').split('.')[0];
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 3)}` : whole;
}
