import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';

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
