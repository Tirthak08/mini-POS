// Extension spelled out, unlike the rest of the app: this module is imported
// directly by a plain-Node test suite, and Node will not resolve what Metro
// resolves happily. Metro accepts both, so nothing is lost.
import { allowsFraction, round3 } from './units.js';

/**
 * The arithmetic behind the stock count, kept out of the screen so it can be
 * tested without a renderer.
 *
 * The distinction everything else rests on: a BLANK field means "not counted
 * yet", and zero means "I looked, there are none". Collapsing the two would
 * silently zero every product the operator had not reached yet -- on a count
 * that takes an hour and gets interrupted, that is the difference between a
 * useful tool and a catastrophe.
 */

/**
 * null when the field is blank or not a usable count.
 *
 * `unit` decides whether a fraction is one: 36.25 kg of rice is a perfectly
 * good count, 9.5 bars of soap is a typo. A mid-typing "36." is not a count
 * yet either -- collapsing it to 36 under the operator's fingers would make the
 * variance jump around as they type the decimal.
 */
export function parseCount(raw, unit = 'pcs') {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || text === '.' || text.endsWith('.')) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!allowsFraction(unit) && !Number.isInteger(n)) return null;
  return round3(n);
}

export function isCounted(raw, unit = 'pcs') {
  return parseCount(raw, unit) !== null;
}

/** One row's state, for rendering. */
export function rowState(product, raw) {
  const recorded = Number(product?.stock) || 0;
  const counted = parseCount(raw, product?.unit);
  if (counted === null) return { counted: null, recorded, variance: 0, status: 'pending', value: 0 };

  const variance = counted - recorded;
  return {
    counted,
    recorded,
    variance: round3(variance),
    // Valued at cost: stock that is missing cost what it cost to buy, not what
    // it might have sold for. Margin that was never earned was never money.
    value: round2(variance * (Number(product?.cost) || 0)),
    status: variance === 0 ? 'match' : variance > 0 ? 'over' : 'short',
  };
}

export function summarise(products = [], counts = {}) {
  let counted = 0, differences = 0, unitsGained = 0, unitsLost = 0, varianceValue = 0;

  for (const p of products) {
    const state = rowState(p, counts[String(p._id)]);
    if (state.status === 'pending') continue;
    counted += 1;
    if (state.variance === 0) continue;
    differences += 1;
    if (state.variance > 0) unitsGained = round3(unitsGained + state.variance);
    else unitsLost = round3(unitsLost - state.variance);
    varianceValue += state.value;
  }

  return {
    total: products.length,
    counted,
    pending: products.length - counted,
    differences,
    unitsGained,
    unitsLost,
    varianceValue: round2(varianceValue),
  };
}

/**
 * What actually goes to the server: only the products that were counted.
 *
 * Untouched rows are left out entirely rather than sent at their recorded
 * value. Sending them would be harmless to the stock figure but would claim the
 * shelf was verified when nobody looked at it, and the server skips matches
 * anyway -- so the only thing it could add is a false record of diligence.
 */
export function buildPayload(products = [], counts = {}, note = '') {
  const rows = [];
  for (const p of products) {
    const counted = parseCount(counts[String(p._id)], p?.unit);
    if (counted === null) continue;
    rows.push({ productId: String(p._id), counted });
  }
  const payload = { counts: rows };
  const trimmed = String(note ?? '').trim();
  if (trimmed) payload.note = trimmed.slice(0, 120);
  return payload;
}

/** Products whose count differs, for the confirmation step. */
export function changedRows(products = [], counts = {}) {
  return products
    .map((p) => ({ product: p, ...rowState(p, counts[String(p._id)]) }))
    .filter((r) => r.status !== 'pending' && r.variance !== 0)
    .sort((a, b) => a.variance - b.variance);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
