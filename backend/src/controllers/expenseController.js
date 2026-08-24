import { Expense } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import {
  requireFields, assertObjectId, toAmount, parseDateRange, round2,
} from '../utils/validators.js';

/**
 * Expenses -- money out that is not the cost of goods sold.
 *
 * Every query here is scoped by `req.businessId`, which comes only from the
 * signed token. Nothing reads a businessId from the body or the query string.
 */

/** A date that may be absent (defaults to now) but must be valid if given. */
function parseSpentAt(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw ApiError.badRequest('spentAt must be a valid date (YYYY-MM-DD or ISO)');
  }
  // A YYYY-MM-DD string parses as UTC midnight; keep it as the shop's own day
  // rather than letting it drift a day backwards in IST.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) d.setHours(12, 0, 0, 0);
  if (d.getTime() > Date.now() + 864e5) {
    throw ApiError.badRequest('An expense cannot be dated in the future');
  }
  return d;
}

const shape = (e) => ({
  _id: e._id,
  amount: e.amount,
  note: e.note,
  spentAt: e.spentAt,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

/** GET /api/expenses?from=&to=&limit= */
export async function listExpenses(req, res) {
  const { from, to } = parseDateRange(req.query);
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  const expenses = await Expense.find({
    businessId: req.businessId,
    spentAt: { $gte: from, $lte: to },
  })
    .sort({ spentAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  // The total is computed over the WHOLE range, not just the page returned, so
  // a shop with more than `limit` expenses still sees a truthful figure.
  const [agg] = await Expense.aggregate([
    { $match: { businessId: req.businessId, spentAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  res.json({
    ok: true,
    range: { from, to },
    expenses: expenses.map(shape),
    total: round2(agg?.total || 0),
    count: agg?.count || 0,
    truncated: (agg?.count || 0) > expenses.length,
  });
}

/** POST /api/expenses  { amount, note, spentAt? } */
export async function createExpense(req, res) {
  requireFields(req.body, ['amount', 'note']);
  const amount = toAmount(req.body.amount, 'amount', { required: true });
  if (amount <= 0) throw ApiError.badRequest('Amount must be more than zero');

  const note = String(req.body.note).trim();
  if (!note) throw ApiError.badRequest('Say what the expense was for');

  const expense = await Expense.create({
    businessId: req.businessId,
    amount,
    note,
    spentAt: parseSpentAt(req.body.spentAt),
  });
  res.status(201).json({ ok: true, expense: shape(expense) });
}

/** PATCH /api/expenses/:id  { amount?, note?, spentAt? } */
export async function updateExpense(req, res) {
  assertObjectId(req.params.id);
  const expense = await Expense.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!expense) throw ApiError.notFound('Expense not found');

  if (req.body.amount !== undefined) {
    const amount = toAmount(req.body.amount, 'amount', { required: true });
    if (amount <= 0) throw ApiError.badRequest('Amount must be more than zero');
    expense.amount = amount;
  }
  if (req.body.note !== undefined) {
    const note = String(req.body.note).trim();
    if (!note) throw ApiError.badRequest('Say what the expense was for');
    expense.note = note;
  }
  if (req.body.spentAt !== undefined) expense.spentAt = parseSpentAt(req.body.spentAt);

  await expense.save();
  res.json({ ok: true, expense: shape(expense) });
}

/** DELETE /api/expenses/:id -- soft, like everything else the shop can remove. */
export async function deleteExpense(req, res) {
  assertObjectId(req.params.id);
  // softDeleteOne returns the stamped document, or null when nothing matched --
  // which for a tenant-scoped filter also covers "belongs to another shop".
  const deleted = await Expense.softDeleteOne(
    { _id: req.params.id, businessId: req.businessId },
    { by: `business:${req.businessId}` }
  );
  if (!deleted) throw ApiError.notFound('Expense not found');
  res.json({ ok: true, deleted: true });
}
