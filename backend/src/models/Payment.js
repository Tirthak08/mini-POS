import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';
import { PAYMENT_METHODS } from './Order.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Money a customer has paid back against what they owe.
 *
 * Against the CUSTOMER, not against a particular receipt. That is how udhaar
 * actually works in a shop: somebody hands over 500 rupees toward a running
 * total, not toward invoice 42. Forcing a repayment to name a sale would make
 * the common case -- "here's what I can pay today" -- impossible to record, and
 * the arithmetic no simpler.
 */
const paymentSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      immutable: true,
    },
    // Snapshotted for the same reason order lines snapshot a product's name: a
    // renamed or deleted customer must not make a past receipt unreadable.
    customerName: { type: String, required: true, trim: true, maxlength: 60 },

    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      // A zero-rupee repayment is a mis-tap, not a record worth keeping.
      min: [0.01, 'Amount must be more than zero'],
    },
    method: {
      type: String,
      default: 'cash',
      enum: { values: PAYMENT_METHODS, message: '"{VALUE}" is not a payment method' },
    },
    note: { type: String, trim: true, maxlength: 140, default: '' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

paymentSchema.plugin(softDeletePlugin);

paymentSchema.index({ businessId: 1, customerId: 1, at: -1, deletedAt: 1 });
paymentSchema.index({ businessId: 1, at: -1, deletedAt: 1 });

paymentSchema.pre('validate', function roundAmount() {
  if (this.amount != null) this.amount = round2(this.amount);
});

export default mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
