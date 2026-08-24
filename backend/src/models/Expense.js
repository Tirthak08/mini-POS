import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Money the shop paid out that is NOT the cost of goods sold -- rent, wages,
 * electricity, a repair.
 *
 * It exists because profit was a half-truth without it. Reports could only say
 * revenue minus COGS, which a shopkeeper reads as "what I made" while their
 * rent and staff are missing from it. Recording outgoings is what turns that
 * into a number they can trust.
 *
 * Deliberately uncategorised (amount + note + date). Presets would give a
 * tidier report, but they are one more decision at the moment of entry, and a
 * free-text note carries the same information for a shop this size. Should a
 * breakdown be wanted later, notes can be grouped without a migration.
 */
const expenseSchema = new mongoose.Schema(
  {
    businessId: {
      type: String,
      required: [true, 'businessId is required'],
      immutable: true,
      index: true,
      match: [/^biz_[0-9a-f]{24}$/, 'businessId must be an opaque biz_ key'],
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      // No zero: a zero-rupee expense is a mis-tap, not a record worth keeping.
      min: [0.01, 'Amount must be more than zero'],
    },
    note: {
      type: String,
      required: [true, 'Say what the expense was for'],
      trim: true,
      maxlength: 140,
    },
    /**
     * When the money actually went out, which is not always when it was typed
     * in -- a shopkeeper catches up on yesterday's bills this morning, and that
     * expense belongs to yesterday's profit.
     */
    spentAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

expenseSchema.plugin(softDeletePlugin);

// Date-range reads are the only query shape this model has.
expenseSchema.index({ businessId: 1, spentAt: -1, deletedAt: 1 });

expenseSchema.pre('validate', function roundAmount() {
  if (this.amount != null) this.amount = round2(this.amount);
});

export const Expense = mongoose.model('Expense', expenseSchema);
