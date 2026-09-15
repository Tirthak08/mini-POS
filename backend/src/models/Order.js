import mongoose from 'mongoose';
import { round2 } from '../utils/validators.js';
import { softDeletePlugin } from './plugins/softDelete.js';
import { UNITS, DEFAULT_UNIT } from './units.js';

/**
 * How the money came in.
 *
 * Recorded on the receipt rather than derived later, because it is the one
 * thing about a sale that nothing else can reconstruct: at the end of the day
 * the question is how much cash should be in the drawer, and a shop that took
 * half its takings on UPI cannot answer that from revenue alone.
 */
export const PAYMENT_METHODS = Object.freeze(['cash', 'upi', 'card', 'other']);

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
    /**
     * May be fractional -- 1.5 kg of rice. Whether that is legal for THIS
     * product is decided at checkout from the product's unit; by the time a
     * line is written the answer is already settled, so the schema only has to
     * refuse a quantity of nothing.
     */
    qty: { type: Number, required: true, min: [0.001, 'Quantity must be more than zero'] },
    /**
     * Snapshotted like the name and price. A receipt that read "1.5" after the
     * product was switched from kg to pcs would be unreadable, and the unit is
     * part of what was sold, not part of what the product is today.
     */
    unit: { type: String, default: DEFAULT_UNIT, enum: { values: UNITS, message: '"{VALUE}" is not a unit' } },
    price: { type: Number, required: true, min: 0 },   // unit price ACTUALLY charged
    /**
     * What the catalogue said this cost at the moment of sale.
     *
     * Without it, a line sold above or below the shelf price is
     * indistinguishable from one sold at a price that has since changed --
     * and "did we collect more than we list?" becomes unanswerable after the
     * fact. Optional so receipts written before overrides existed still load;
     * readers fall back to `price`.
     */
    listPrice: { type: Number, min: 0 },
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
    /**
     * The client's own id for this sale, when it made one.
     *
     * This is what makes a checkout safe to send twice. A sale rung up with no
     * signal is queued on the phone and replayed later -- and a reply lost in
     * transit is indistinguishable, from the phone, from a request that never
     * arrived. Without a ref the only safe choice is never to retry, which is
     * why the app refused to; with one, the second attempt returns the SAME
     * receipt instead of charging the customer again.
     *
     * Unique per shop and NOT scoped to live rows: a voided sale's ref must
     * stay taken, or replaying its queue entry would resurrect it.
     */
    clientRef: {
      type: String,
      trim: true,
      maxlength: 64,
      match: [/^[A-Za-z0-9._:-]{8,64}$/, 'clientRef must be 8-64 safe characters'],
    },
    /**
     * Who the sale was to, when it was to somebody the shop keeps a ledger for.
     * Absent for a walk-in, which is most sales.
     */
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    // Snapshotted like everything else on a receipt: renaming a customer must
    // not rewrite what an old bill says.
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
    /**
     * What was actually handed over at the counter.
     *
     * Defaults to the whole bill, which keeps every sale that has ever existed
     * -- and every sale that is simply paid for -- exactly as it was. Less than
     * the total is udhaar: the difference is what the customer owes, and it is
     * NOT stored as a separate field, because two numbers that must agree are
     * two numbers that eventually will not.
     */
    amountPaid: { type: Number, min: [0, 'Amount paid cannot be negative'] },
    paymentMethod: {
      type: String,
      default: 'cash',
      enum: { values: PAYMENT_METHODS, message: '"{VALUE}" is not a payment method' },
      index: true,
    },
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

/**
 * Paying more than the bill is not a credit, it is a typo.
 *
 * Registered AFTER recomputeTotals on purpose: Mongoose runs pre-validate hooks
 * in registration order, and grandTotal is only settled by that hook. Clamping
 * first would compare against whatever the last save left behind -- which is
 * exactly the kind of "works until someone edits an order" bug this file keeps
 * having to defend against.
 */
orderSchema.pre('validate', function clampAmountPaid() {
  if (this.amountPaid == null) return;
  if (this.amountPaid < 0) this.amountPaid = 0;
  if (this.amountPaid > this.grandTotal) this.amountPaid = this.grandTotal;
});

orderSchema.index({ businessId: 1, timestamp: -1, deletedAt: 1 }); // history + date-range reports
// NOT partial: a voided receipt number must never be handed out again.
orderSchema.index({ businessId: 1, orderNumber: 1 }, { unique: true });

// Partial on EXISTENCE only, so orders without a ref (every sale rung up
// online) do not all collide on null.
orderSchema.index(
  { businessId: 1, clientRef: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $exists: true } } }
);

/** What is still owed on this receipt. Zero for every sale that was paid for. */
orderSchema.virtual('balanceDue').get(function balanceDue() {
  const paid = this.amountPaid == null ? this.grandTotal : this.amountPaid;
  return round2(Math.max(0, (this.grandTotal || 0) - paid));
});

/** "INV-000042" for receipts and exports. */
orderSchema.virtual('receiptNo').get(function receiptNo() {
  return `INV-${String(this.orderNumber ?? 0).padStart(6, '0')}`;
});

orderSchema.set('toJSON', { virtuals: true });

export default mongoose.models.Order || mongoose.model('Order', orderSchema);
