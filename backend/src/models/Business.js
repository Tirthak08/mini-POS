import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { softDeletePlugin } from './plugins/softDelete.js';

const SALT_ROUNDS = 10;

/** Opaque, unguessable, and permanent: biz_ + 24 hex chars. */
export const mintBusinessId = () => `biz_${crypto.randomBytes(12).toString('hex')}`;

/** "  Sharma   Kirana " -> "sharma kirana". Used for login and duplicate checks. */
export const toSlug = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * PRD 3A -- Business (Tenant).
 *
 * `businessId` is the tenant key every other collection is scoped by, and it is
 * deliberately NOT derived from the name:
 *
 *   - the name can be corrected later without re-keying every other row;
 *   - it cannot be guessed or enumerated from a shop's public name;
 *   - and, critically for soft delete: when a shop is deleted and someone
 *     registers the same name, they get a NEW businessId, so they can never
 *     inherit the previous owner's hidden records.
 *
 * `slug` carries the name-uniqueness rule instead, enforced among live shops
 * only, so a deleted shop's name becomes available again.
 */
const businessSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: true,
      unique: true,
      immutable: true, // re-keying a tenant would orphan all of its data
      default: mintBusinessId,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: [2, 'Business name must be at least 2 characters'],
      maxlength: [60, 'Business name must be 60 characters or fewer'],
    },
    name: {
      type: String,
      required: [true, 'Business name is required'],
      trim: true,
      maxlength: 60,
    },
    // bcrypt hash of the 4-6 digit PIN. `select: false` keeps it out of every
    // query result unless a route explicitly asks for it.
    pin: {
      type: String,
      required: [true, 'PIN is required'],
      select: false,
    },
  },
  { timestamps: true } // gives us createdAt (PRD 3A) + updatedAt
);

businessSchema.plugin(softDeletePlugin);

/**
 * One LIVE shop per name. A partial index is required rather than a compound
 * {slug, deletedAt} one: with the compound form, two rows deleted in the same
 * millisecond collide (verified against a real MongoDB).
 */
businessSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

businessSchema.statics.toSlug = toSlug;
businessSchema.statics.mintBusinessId = mintBusinessId;

// Mongoose 9: async middleware receives NO `next` -- it awaits the promise.
businessSchema.pre('save', async function hashPin() {
  if (!this.isModified('pin')) return;
  this.pin = await bcrypt.hash(this.pin, SALT_ROUNDS);
});

/** Requires the document to have been loaded with .select('+pin'). */
businessSchema.methods.verifyPin = function verifyPin(candidatePin) {
  if (!this.pin) throw new Error('PIN not loaded -- query with .select("+pin")');
  return bcrypt.compare(String(candidatePin), this.pin);
};

businessSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.pin;
    return ret;
  },
});

export default mongoose.models.Business || mongoose.model('Business', businessSchema);
