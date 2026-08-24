import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';

/** PRD 3B -- Category, scoped to one tenant by its opaque businessId. */
const categorySchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'], // no row may exist untenanted
      immutable: true, // moving a row between tenants is never legitimate
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      maxlength: 40,
    },
    color: {
      type: String,
      default: '#2A78D6',
      trim: true,
      match: [/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'color must be a hex code like #2A78D6'],
    },
  },
  { timestamps: true }
);

categorySchema.plugin(softDeletePlugin);

/**
 * Two businesses may both have "Beverages"; one business may not have it twice.
 * Partial so a deleted category frees its name for reuse, and case-insensitive
 * so "beverages" is not treated as a second category.
 */
categorySchema.index(
  { businessId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    collation: { locale: 'en', strength: 2 },
  }
);

export default mongoose.models.Category || mongoose.model('Category', categorySchema);
