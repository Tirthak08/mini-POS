import mongoose from 'mongoose';
import { round2 } from '../utils/validators.js';
import { softDeletePlugin } from './plugins/softDelete.js';

/**
 * A frozen SNAPSHOT of one cart line at the moment of sale.
 * Name/price/cost are copied in, not referenced, so renaming, repricing or
 * deleting a product later never rewrites history. `productId` is kept anyway
 * so reports can group by product and checkout knows whose stock to decrement.
 */
const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: [1, 'Quantity must be at least 1'] },
    price: { type: Number, required: true, min: 0 },   // unit price at sale time
    cost: { type: Number, default: 0, min: 0 },        // unit COGS at sale time -> profit reports
    discount: { type: Number, default: 0, min: [0, 'Discount cannot be negative'] }, // absolute INR off this line
    lineTotal: { type: Number, required: true, min: 0 }, // qty * price - discount, clamped at 0
  },
  { _id: false }
);

// PRD 7, edge case 2: a discount can never exceed the line's own value.
orderItemSchema.pre('validate', function clampDiscount() {
  const gross = round2((this.qty || 0) * (this.price || 0));
  if (this.discount > gross) this.discount = gross;
  this.lineTotal = round2(Math.max(0, gross - this.discount));
});

/** PRD 3D -- Order / Receipt. */
const orderSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    // Human-readable receipt number, sequential per business, assigned at
    // checkout from an atomic counter. Never reused, even if an order is voided.
    orderNumber: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    customerName: {
      type: String,
      default: 'Walk-in',
      trim: true,
      maxlength: 60,
    },
    items: {
      type: [orderItemSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'An order needs at least one item'],
    },
    /**
     * GROSS of the line items, BEFORE discounts.
     *
     * It used to hold the net figure, which made every receipt fail to add up:
     * "Subtotal 40, Discount -10, Total 40". A subtotal that already has the
     * discount taken out cannot then have it shown as a deduction.
     *
     *   subtotal - discountTotal + extraCharges = grandTotal
     */
    subtotal: { type: Number, required: true, min: 0 },
    discountTotal: { type: Number, default: 0, min: 0 },
    extraCharges: { type: Number, default: 0, min: [0, 'Extra charges cannot be negative'] },
    grandTotal: { type: Number, required: true, min: [0, 'Grand total cannot be negative'] },
    timestamp: { type: Date, default: Date.now, index: true },
    // Corrections are visible rather than silent: a receipt that has been
    // amended says so, and says how many times.
    editedAt: { type: Date, default: null },
    editCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

orderSchema.plugin(softDeletePlugin);

/**
 * Recompute totals server-side. The client's arithmetic is never trusted.
 *
 * The per-line clamp is repeated here rather than relying on the subdocument's
 * own pre('validate'): Mongoose fires the parent hook BEFORE its subdocuments,
 * so summing `it.discount` raw would total un-clamped values and report a
 * discountTotal larger than the receipt actually gave away. The HTTP path
 * clamps in the controller too, so this only bites a direct model write -- but
 * that is exactly the path a future script or migration would take.
 */
orderSchema.pre('validate', function recomputeTotals() {
  const items = this.items || [];
  let subtotal = 0;
  let discountTotal = 0;
  for (const it of items) {
    const gross = round2((it.qty || 0) * (it.price || 0));
    const discount = Math.min(Math.max(0, it.discount || 0), gross);
    subtotal += gross;
    discountTotal += discount;
  }
  this.subtotal = round2(subtotal);
  this.discountTotal = round2(discountTotal);
  this.grandTotal = round2(Math.max(0, this.subtotal - this.discountTotal + (this.extraCharges || 0)));
});

orderSchema.index({ businessId: 1, timestamp: -1, deletedAt: 1 }); // history + date-range reports
// NOT partial: a voided receipt number must never be handed out again.
orderSchema.index({ businessId: 1, orderNumber: 1 }, { unique: true });

/** "INV-000042" for receipts and exports. */
orderSchema.virtual('receiptNo').get(function receiptNo() {
  return `INV-${String(this.orderNumber ?? 0).padStart(6, '0')}`;
});

orderSchema.set('toJSON', { virtuals: true });

export default mongoose.models.Order || mongoose.model('Order', orderSchema);
