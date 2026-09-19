import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';
import { PAYMENT_METHODS } from './Order.js';
import { UNITS, DEFAULT_UNIT } from './units.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * A credit note: goods that came back after the sale went through.
 *
 * Deliberately NOT an edit of the original receipt. Editing the sale would say
 * that fewer items were sold on the day of the sale, which is false -- they
 * were sold, and then some of them came back, possibly weeks later. The two
 * events belong to different days, and a shop that cannot see its returns
 * cannot see that one customer returns half of what they buy.
 *
 * It is also not a void. A void says the sale never should have existed and
 * unwinds all of it; a return says part of a real sale was reversed, and the
 * rest of it stands.
 *
 * Lines snapshot everything the way order lines do, so a renamed or deleted
 * product does not rewrite what came back.
 */
const returnLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: [0.001, 'Quantity must be more than zero'] },
    unit: { type: String, default: DEFAULT_UNIT, enum: { values: UNITS, message: '"{VALUE}" is not a unit' } },
    /**
     * What was actually charged for ONE of these on the original receipt --
     * the line's own total divided by its quantity, so a line that carried a
     * discount refunds at the discounted rate. Refunding at the shelf price
     * would hand back money that was never taken.
     */
    price: { type: Number, required: true, min: 0 },
    /** Unit COGS, carried through so the profit report can un-count it. */
    cost: { type: Number, default: 0, min: 0 },
    refund: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

returnLineSchema.pre('validate', function computeRefund() {
  this.refund = round2(Math.max(0, (this.qty || 0) * (this.price || 0)));
});

/**
 * How the money went back. The payment methods, plus one that is not a payment
 * at all: `credit` knocks the refund off what the customer still owes, which is
 * what actually happens when somebody with a running khata returns something.
 * Handing them cash and then collecting it again the same afternoon is not how
 * anybody does it.
 */
export const REFUND_METHODS = Object.freeze([...PAYMENT_METHODS, 'credit']);

const returnSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    /** Its own sequence, so credit notes read CN-000001 and never collide with receipts. */
    returnNumber: { type: Number, required: true, immutable: true },

    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      immutable: true,
      index: true,
    },
    /** Snapshot: which receipt this came off, readable after anything is renamed. */
    orderNumber: { type: Number, required: true, immutable: true },

    /**
     * Carried from the order rather than looked up later, so the customer's
     * balance can be worked out without joining back through the sale -- and so
     * that moving a sale onto a different customer afterwards cannot silently
     * re-point a refund that has already been given.
     */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerName: { type: String, trim: true, maxlength: 60, default: '' },

    lines: {
      type: [returnLineSchema],
      validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'A return needs at least one line' },
    },

    refundTotal: { type: Number, required: true, min: 0 },
    refundMethod: {
      type: String,
      default: 'cash',
      enum: { values: REFUND_METHODS, message: '"{VALUE}" is not a refund method' },
    },
    reason: { type: String, trim: true, maxlength: 140, default: '' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

returnSchema.plugin(softDeletePlugin);

returnSchema.index({ businessId: 1, returnNumber: 1 }, { unique: true });
returnSchema.index({ businessId: 1, at: -1, deletedAt: 1 });
returnSchema.index({ businessId: 1, orderId: 1, deletedAt: 1 });

returnSchema.pre('validate', function totalRefund() {
  // Lines are validated before the parent, so their own refunds are already set.
  const sum = (this.lines ?? []).reduce((s, l) => s + (l.refund || 0), 0);
  this.refundTotal = round2(sum);
});

returnSchema.virtual('creditNoteNo').get(function creditNoteNo() {
  return `CN-${String(this.returnNumber ?? 0).padStart(6, '0')}`;
});
returnSchema.set('toJSON', { virtuals: true });
returnSchema.set('toObject', { virtuals: true });

export default mongoose.models.Return || mongoose.model('Return', returnSchema);
