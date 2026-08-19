import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';

/** Kept small on purpose -- the app downscales before uploading. */
export const MAX_IMAGE_BYTES = 400 * 1024;

export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Product photos, stored in their OWN collection rather than on the product.
 *
 * Products are listed on every POS refresh; carrying a binary blob on each row
 * would make that response tens of megabytes. Here the list returns only an
 * imageId, and the bytes are fetched once per image and then cached by the
 * client for a year (the id changes whenever the photo does).
 */
const productImageSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    // Set once the image is attached to a product. Uploads are allowed before
    // the product exists, so a new product can be saved with its photo already in place.
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
    contentType: {
      type: String,
      required: true,
      enum: { values: ALLOWED_TYPES, message: 'Unsupported image type' },
    },
    data: {
      type: Buffer,
      required: true,
      validate: [
        (buf) => buf && buf.length > 0 && buf.length <= MAX_IMAGE_BYTES,
        `Image must be between 1 byte and ${Math.round(MAX_IMAGE_BYTES / 1024)}KB`,
      ],
    },
    bytes: { type: Number, required: true, min: 1 },
    width: { type: Number, min: 1 },
    height: { type: Number, min: 1 },
  },
  { timestamps: true }
);

productImageSchema.plugin(softDeletePlugin);

productImageSchema.index({ businessId: 1, productId: 1, deletedAt: 1 });

// `data` is a large binary field; never let it into a JSON response by accident.
productImageSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.data;
    return ret;
  },
});

export default mongoose.models.ProductImage || mongoose.model('ProductImage', productImageSchema);
