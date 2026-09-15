import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';

/**
 * Every stock change that is NOT a sale.
 *
 * Sales are deliberately absent. The orders collection already records, line by
 * line, exactly how much of what left the shelf; writing a second row for each
 * would duplicate the busiest thing the app does -- roughly 240 rows a day at
 * 80 sales -- to say something already written down. On a 512MB free tier that
 * is the difference between a database that lasts a decade and one that does
 * not.
 *
 * So this collection answers the narrower and much more useful question: of the
 * stock that moved WITHOUT a customer, where did it go? Corrections, damage,
 * restocks, counts. Those are rare, and they are the ones nobody can remember
 * three weeks later. A merged timeline (see getMovements) puts sales back
 * alongside them at read time, derived from the orders themselves.
 */
export const REASONS = Object.freeze([
  'opening',    // stock entered when the product was first created
  'restock',    // new goods in
  'correction', // a manual fix with no better label
  'stocktake',  // a physical count overrode the recorded figure
  'damage',     // broken, spoiled, expired
  'loss',       // missing, stolen
  'return',     // a customer brought something back outside a void
]);

const stockMovementSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      immutable: true,
    },
    /**
     * Snapshot, exactly like an order line's.
     *
     * A movement's whole job is to explain a past discrepancy, which means it
     * has to stay readable after the product has been renamed into something
     * else or deleted outright. Joining to the live product at read time would
     * quietly rewrite history -- the same trap $lookup already sprang on the
     * category report.
     */
    productName: { type: String, required: true, trim: true, maxlength: 80 },

    /**
     * Signed. Negative removes stock. Never zero: a movement that changed
     * nothing is noise, and the writers all skip it.
     *
     * Fractional, because the stock it explains can be -- 0.75 kg of rice
     * spoiled is a real thing to record. Whether a fraction is legal for the
     * product is settled by the controller from the product's unit; refusing
     * one here would make the ledger unable to describe a change the rest of
     * the app had already allowed.
     */
    delta: {
      type: Number,
      required: true,
      validate: [(v) => Number.isFinite(v) && v !== 0, 'delta must be a non-zero number'],
    },
    before: { type: Number, required: true, min: 0 },
    after: { type: Number, required: true, min: 0 },

    reason: {
      type: String,
      required: true,
      enum: { values: REASONS, message: '"{VALUE}" is not a stock movement reason' },
    },
    note: { type: String, trim: true, maxlength: 120, default: '' },

    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

stockMovementSchema.plugin(softDeletePlugin);

// The two reads that exist: one product's history, and the whole shop's.
stockMovementSchema.index({ businessId: 1, productId: 1, at: -1, deletedAt: 1 });
stockMovementSchema.index({ businessId: 1, at: -1, deletedAt: 1 });

export default mongoose.models.StockMovement
  || mongoose.model('StockMovement', stockMovementSchema);
