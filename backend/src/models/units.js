/**
 * How a product is measured, and therefore whether half of one is a thing.
 *
 * The whole point of this list is the split between countable and measurable.
 * "2.5 pcs of soap" is a typo for 25 and should be refused; "2.5 kg of rice" is
 * Tuesday. Without the distinction the app must either reject half a kilo --
 * which makes it useless for a kirana -- or accept two and a half bars of soap,
 * which turns a mis-tap into a wrong bill and wrong stock.
 *
 * Existing products default to `pcs`, so nothing that works today changes
 * behaviour until a unit is deliberately set.
 */
export const UNITS = Object.freeze(['pcs', 'pkt', 'box', 'dozen', 'kg', 'g', 'l', 'ml', 'm']);

/** Units where a fraction is meaningful. */
const MEASURED = new Set(['kg', 'g', 'l', 'ml', 'm']);

export const DEFAULT_UNIT = 'pcs';

export const allowsFraction = (unit) => MEASURED.has(String(unit ?? DEFAULT_UNIT));

/** Quantities are rounded to 3 decimals: 5 grams of a kilo is the finest split worth keeping. */
export const QTY_DECIMALS = 3;

export function round3(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}
