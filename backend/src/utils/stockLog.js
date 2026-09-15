import { Product, StockMovement } from '../models/index.js';
import { ApiError } from './ApiError.js';
import { REASONS } from '../models/StockMovement.js';

/** Validates a reason coming from the client, with a sensible default. */
export function toReason(value, fallback = 'correction') {
  if (value === undefined || value === null || value === '') return fallback;
  const r = String(value).trim().toLowerCase();
  if (!REASONS.includes(r)) {
    throw ApiError.badRequest(`"${value}" is not a stock reason`, {
      reason: `must be one of: ${REASONS.join(', ')}`,
    });
  }
  return r;
}

export function toNote(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, 120);
}

/**
 * Write one movement row for a stock change that has ALREADY been applied.
 *
 * If the log write fails, the stock change is put back. That ordering looks
 * backwards -- normally you would log first -- but the stock update is the one
 * that has to be atomic against concurrent sales, so it goes first and this
 * compensates. The invariant it buys is the only reason the feature is worth
 * having: stock never moves without a row saying why. A log with silent holes
 * in it is worse than no log, because it is still believed.
 *
 * Pass a session and the whole thing rides the caller's transaction instead,
 * and no compensation is needed.
 */
export async function recordMovement({
  businessId, productId, productName, before, after, reason, note = '', at, session,
}) {
  const delta = after - before;
  if (delta === 0) return null;

  const doc = {
    businessId,
    productId,
    productName,
    delta,
    before,
    after,
    reason,
    note: toNote(note),
    ...(at ? { at } : {}),
  };

  if (session) {
    const [movement] = await StockMovement.create([doc], { session });
    return movement;
  }

  try {
    return await StockMovement.create(doc);
  } catch (err) {
    // $inc rather than setting `before` back: a sale may have landed in
    // between, and clobbering it would turn a logging failure into lost stock.
    await Product.updateOne({ _id: productId, businessId }, { $inc: { stock: -delta } })
      .catch(() => {});
    throw err;
  }
}
