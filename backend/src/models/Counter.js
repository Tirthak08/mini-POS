import mongoose from 'mongoose';

/**
 * Per-business sequence for human-readable receipt numbers.
 *
 * A shop owner needs to be able to say "bill number 42", and an ObjectId is
 * useless for that. Counting existing orders would race between two phones, so
 * the number comes from an atomic $inc on a single document per business.
 */
const counterSchema = new mongoose.Schema(
  {
    // `${businessId}:order`
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

/** Atomically reserves and returns the next number. Never returns a duplicate. */
counterSchema.statics.next = async function next(key, { session } = {}) {
  const doc = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, ...(session && { session }) }
  );
  return doc.seq;
};

export default mongoose.models.Counter || mongoose.model('Counter', counterSchema);
