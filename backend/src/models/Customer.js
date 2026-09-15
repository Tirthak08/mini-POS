import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';

/**
 * Somebody the shop sells to on credit.
 *
 * WHY THERE IS NO `balance` FIELD
 * ------------------------------
 * The obvious design stores a running balance and adjusts it on every sale and
 * every repayment. It is also the design that eventually shows a number nobody
 * can explain: a write that half-applied, a voided sale that was not accounted
 * for, an edit that adjusted the order but not the customer. Once a stored
 * balance and the receipts behind it disagree, the shopkeeper has no way to
 * tell which is lying, and the whole feature stops being trusted.
 *
 * So the balance is DERIVED, every time, from the two things that are facts:
 * what was billed and not paid at the counter, and what has been repaid since.
 *
 *     balance = SUM(order.grandTotal - order.amountPaid) - SUM(payments)
 *
 * It cannot drift, because there is nothing to drift from. At the scale this
 * app is built for -- one shop, a few hundred customers -- the aggregate is
 * cheaper than the bugs the alternative buys.
 */
const customerSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
      maxlength: 60,
      // Same normalisation as products: "Ramesh  Bhai" and "Ramesh Bhai" are
      // one person, and a second row for the second spelling splits a ledger.
      set: (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v),
    },
    /**
     * Free text on purpose. Indian numbers get written with +91, with a space,
     * with a leading 0, or not at all; rejecting any of those spellings would
     * stop somebody recording a debt, which is worse than an untidy field.
     */
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    note: { type: String, trim: true, maxlength: 140, default: '' },
  },
  { timestamps: true }
);

customerSchema.plugin(softDeletePlugin);

customerSchema.index({ businessId: 1, name: 1, deletedAt: 1 });

/**
 * One shop may not hold two customers by the same name.
 *
 * Case-insensitive, and partial so a deleted name can be reused. Without it the
 * shop ends up with two "Ramesh" rows and a debt split across them -- which is
 * exactly the failure the whole feature exists to prevent.
 */
customerSchema.index(
  { businessId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    collation: { locale: 'en', strength: 2 },
  }
);

export default mongoose.models.Customer || mongoose.model('Customer', customerSchema);
