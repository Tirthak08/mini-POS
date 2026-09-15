import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';
import { UNITS, DEFAULT_UNIT, allowsFraction } from './units.js';

/** PRD 3C -- Product / Item. Prices are INR. */
const productSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: [true, 'categoryId is required'],
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: 80,
      /**
       * Collapse runs of whitespace, not just the ends.
       *
       * The uniqueness index below compares strings, and a collation can fold
       * case and accents but not "Rice  5kg" against "Rice 5kg". Without this,
       * a double space typed by accident creates a second product that looks
       * identical in the list -- which is one of the ways duplicates got in.
       */
      set: (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v),
    },
    price: {
      type: Number,
      required: [true, 'Selling price is required'],
      min: [0, 'Price cannot be negative'],
    },
    cost: {
      type: Number,
      default: 0,
      min: [0, 'Cost cannot be negative'],
    },
    /**
     * How this product is measured, which decides whether half of one exists.
     *
     * Defaults to `pcs`, so every product that already exists keeps behaving
     * exactly as it did -- whole numbers only -- until somebody deliberately
     * says otherwise.
     */
    unit: {
      type: String,
      default: DEFAULT_UNIT,
      enum: { values: UNITS, message: '"{VALUE}" is not a unit this app knows' },
    },
    stock: {
      type: Number,
      default: 0,
      min: [0, 'Stock cannot be negative'], // blocks overselling at the DB layer
    },
    // Points at a row in the images collection, never at inline bytes.
    imageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductImage',
      default: null,
    },
  },
  { timestamps: true }
);

productSchema.plugin(softDeletePlugin);

productSchema.index({ businessId: 1, categoryId: 1, deletedAt: 1 }); // POS category filter
productSchema.index({ businessId: 1, name: 1, deletedAt: 1 });       // inventory search

/**
 * One shop may not stock two products of the same name in the same category.
 *
 * Scoped to the CATEGORY, not the whole shop: "Rice 5kg" under Grain and the
 * same name under a Festival Offers category is a legitimate thing to want,
 * and forbidding it would be a surprise. Two of them side by side in one
 * category is always a mistake -- the operator cannot tell which is which at
 * the till.
 *
 * Partial, so deleting a product frees its name for reuse; the soft-delete
 * plugin stamps deletedAt rather than removing the row, and without the filter
 * a deleted "Rice 5kg" would block ever creating that name again.
 *
 * Collation strength 2 makes it case- and accent-insensitive, so "rice 5kg"
 * is caught as the duplicate it is. Queries that need this index must use the
 * same collation -- listProducts already does.
 */
productSchema.index(
  { businessId: 1, categoryId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    collation: { locale: 'en', strength: 2 },
  }
);

/** True when this product can be sold in fractions -- rice by the kilo, oil by the litre. */
productSchema.virtual('fractional').get(function fractional() {
  return allowsFraction(this.unit);
});

/** Profit per unit -- for the Revenue vs Profit chart (PRD 6, screen 3). */
productSchema.virtual('margin').get(function margin() {
  return this.price - this.cost;
});

/** Relative path the app turns into a full URL; null when there is no photo. */
productSchema.virtual('imageUrl').get(function imageUrl() {
  return this.imageId ? `/images/${this.imageId}` : null;
});

productSchema.set('toJSON', { virtuals: true });

export default mongoose.models.Product || mongoose.model('Product', productSchema);
