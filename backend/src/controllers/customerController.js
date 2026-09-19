import mongoose from 'mongoose';
import { Customer, Order, Payment, Return } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { requireFields, assertObjectId, toAmount, round2 } from '../utils/validators.js';
import { PAYMENT_METHODS } from '../models/Order.js';

/**
 * Udhaar: who owes the shop money, and what they have paid back.
 *
 * Every balance in this file is computed from receipts and repayments at the
 * moment it is asked for. There is no stored total anywhere. See the comment on
 * the Customer model for why -- briefly, a stored balance that disagrees with
 * the receipts behind it is a number nobody can explain, and once that happens
 * the shopkeeper stops trusting the whole feature.
 */

/** What a shop is owed, per customer, from the receipts themselves. */
function outstandingPipeline(businessId, customerIds = null) {
  const match = { businessId, customerId: { $ne: null } };
  if (customerIds) match.customerId = { $in: customerIds };

  return [
    { $match: match },
    {
      $group: {
        _id: '$customerId',
        // `amountPaid` is absent on every sale written before udhaar existed,
        // and on every sale that was simply paid for. Both mean "paid in full".
        billed: { $sum: '$grandTotal' },
        paidAtCounter: { $sum: { $ifNull: ['$amountPaid', '$grandTotal'] } },
        orders: { $sum: 1 },
        lastOrderAt: { $max: '$timestamp' },
      },
    },
  ];
}

function repaidPipeline(businessId, customerIds = null) {
  const match = { businessId };
  if (customerIds) match.customerId = { $in: customerIds };
  return [
    { $match: match },
    { $group: { _id: '$customerId', repaid: { $sum: '$amount' }, payments: { $sum: 1 }, lastPaidAt: { $max: '$at' } } },
  ];
}

/**
  * Refunds knocked off a khata rather than handed back in cash.
  *
  * A customer who returns goods bought on credit does not get money; their debt
  * shrinks. Recording that as a Payment would be the easy shortcut and would be
  * wrong -- Payment feeds the takings report, and the shop never took this in.
  */
function creditedPipeline(businessId, customerIds = null) {
  const match = { businessId, refundMethod: 'credit', customerId: { $ne: null } };
  if (customerIds) match.customerId = { $in: customerIds };
  return [
    { $match: match },
    { $group: { _id: '$customerId', credited: { $sum: '$refundTotal' }, notes: { $sum: 1 } } },
  ];
}

/** Merges the aggregates into one balance per customer id. */
async function balancesFor(businessId, customerIds = null) {
  const [owed, repaid, refunded] = await Promise.all([
    Order.aggregate(outstandingPipeline(businessId, customerIds)),
    Payment.aggregate(repaidPipeline(businessId, customerIds)),
    Return.aggregate(creditedPipeline(businessId, customerIds)),
  ]);

  const byId = new Map();
  for (const row of owed) {
    byId.set(String(row._id), {
      billed: round2(row.billed),
      paidAtCounter: round2(row.paidAtCounter),
      credited: round2(row.billed - row.paidAtCounter),
      repaid: 0,
      orders: row.orders,
      payments: 0,
      lastOrderAt: row.lastOrderAt ?? null,
      lastPaidAt: null,
    });
  }
  for (const row of repaid) {
    const key = String(row._id);
    const existing = byId.get(key) ?? {
      billed: 0, paidAtCounter: 0, credited: 0, repaid: 0,
      orders: 0, payments: 0, lastOrderAt: null, lastPaidAt: null,
    };
    existing.repaid = round2(row.repaid);
    existing.payments = row.payments;
    existing.lastPaidAt = row.lastPaidAt ?? null;
    byId.set(key, existing);
  }

  for (const row of refunded) {
    const key = String(row._id);
    const existing = byId.get(key) ?? {
      billed: 0, paidAtCounter: 0, credited: 0, repaid: 0, refunded: 0,
      orders: 0, payments: 0, lastOrderAt: null, lastPaidAt: null,
    };
    existing.refunded = round2(row.credited);
    existing.creditNotes = row.notes;
    byId.set(key, existing);
  }

  /* `credited` is what went ON the account, `repaid` is what came back in cash,
     `refunded` is what came off it because goods did. */
  for (const [, v] of byId) {
    v.refunded = round2(v.refunded ?? 0);
    v.creditNotes = v.creditNotes ?? 0;
    v.balance = round2(v.credited - v.repaid - v.refunded);
  }
  return byId;
}

const EMPTY = {
  billed: 0, paidAtCounter: 0, credited: 0, repaid: 0, refunded: 0, balance: 0,
  orders: 0, payments: 0, creditNotes: 0, lastOrderAt: null, lastPaidAt: null,
};

function toMethod(value) {
  if (value === undefined || value === null || value === '') return 'cash';
  const m = String(value).trim().toLowerCase();
  if (!PAYMENT_METHODS.includes(m)) {
    throw ApiError.badRequest(`"${value}" is not a payment method`, {
      method: `must be one of: ${PAYMENT_METHODS.join(', ')}`,
    });
  }
  return m;
}

function asDuplicateNameError(err, name) {
  if (err?.code !== 11000) return err;
  return ApiError.conflict(`You already have a customer called "${name}"`, {
    name: 'already used',
  });
}

/** GET /api/customers?search=&owing=1 */
export async function listCustomers(req, res) {
  const businessId = req.businessId;
  const filter = { businessId };

  if (req.query.search) {
    const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ name: new RegExp(safe, 'i') }, { phone: new RegExp(safe, 'i') }];
  }

  const customers = await Customer.find(filter)
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: 1 })
    .lean();

  const balances = await balancesFor(businessId);
  let rows = customers.map((c) => ({ ...c, ...(balances.get(String(c._id)) ?? EMPTY) }));

  // The list a shopkeeper actually wants: only the people who owe, worst first.
  if (req.query.owing === '1' || req.query.owing === 'true') {
    rows = rows.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance);
  }

  const totals = rows.reduce((acc, r) => ({
    owed: round2(acc.owed + Math.max(0, r.balance)),
    // Somebody who has paid more than they owe is in credit, and lumping that
    // into "owed" as a negative would understate what is actually out there.
    inCredit: round2(acc.inCredit + Math.max(0, -r.balance)),
    owing: acc.owing + (r.balance > 0 ? 1 : 0),
  }), { owed: 0, inCredit: 0, owing: 0 });

  res.json({ ok: true, customers: rows, totals });
}

/** POST /api/customers  { name, phone?, note? } */
export async function createCustomer(req, res) {
  requireFields(req.body, ['name']);
  const name = String(req.body.name).trim();

  let customer;
  try {
    customer = await Customer.create({
      businessId: req.businessId,
      name,
      phone: String(req.body.phone ?? '').trim(),
      note: String(req.body.note ?? '').trim(),
    });
  } catch (err) {
    throw asDuplicateNameError(err, name);
  }

  res.status(201).json({ ok: true, customer: { ...customer.toJSON(), ...EMPTY } });
}

/** PATCH /api/customers/:id */
export async function updateCustomer(req, res) {
  assertObjectId(req.params.id);
  const update = {};
  if (req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body.phone !== undefined) update.phone = String(req.body.phone).trim();
  if (req.body.note !== undefined) update.note = String(req.body.note).trim();
  if (!Object.keys(update).length) throw ApiError.badRequest('Nothing to update');

  let customer;
  try {
    customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      update,
      { new: true, runValidators: true }
    );
  } catch (err) {
    throw asDuplicateNameError(err, update.name ?? 'that name');
  }
  if (!customer) throw ApiError.notFound('Customer not found');

  const balances = await balancesFor(req.businessId, [customer._id]);
  res.json({ ok: true, customer: { ...customer.toJSON(), ...(balances.get(String(customer._id)) ?? EMPTY) } });
}

/**
 * DELETE /api/customers/:id
 *
 * Refused while they still owe money. Deleting a debtor does not settle the
 * debt, it hides it -- and the row is what the shop would need to chase it.
 * `?force=true` is there because sometimes a debt really is written off, but it
 * has to be said out loud.
 */
export async function deleteCustomer(req, res) {
  assertObjectId(req.params.id);
  const businessId = req.businessId;

  const customer = await Customer.findOne({ _id: req.params.id, businessId }).lean();
  if (!customer) throw ApiError.notFound('Customer not found');

  const balances = await balancesFor(businessId, [customer._id]);
  const balance = balances.get(String(customer._id))?.balance ?? 0;
  const force = req.query.force === 'true' || req.query.force === '1';

  if (balance > 0 && !force) {
    throw ApiError.conflict(
      `"${customer.name}" still owes ${balance}. Settle it first, or delete with ?force=true to write it off.`,
      { balance }
    );
  }

  await Customer.softDeleteOne({ _id: customer._id, businessId });
  res.json({ ok: true, deleted: { _id: customer._id, name: customer.name, balance } });
}

/**
 * GET /api/customers/:id — the ledger.
 *
 * Sales and repayments merged into one list, newest first, the way a khata book
 * reads. Two separate lists would make the obvious question -- "how did this
 * balance get here?" -- something the reader has to do arithmetic to answer.
 */
export async function getCustomer(req, res) {
  const customerId = assertObjectId(req.params.id);
  const businessId = req.businessId;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);

  const customer = await Customer.findOne({ _id: customerId, businessId }).lean();
  if (!customer) throw ApiError.notFound('Customer not found');

  const oid = new mongoose.Types.ObjectId(customerId);

  const [orders, payments, credits, balances] = await Promise.all([
    Order.find({ businessId, customerId: oid }).sort({ timestamp: -1 }).limit(limit).lean(),
    Payment.find({ businessId, customerId: oid }).sort({ at: -1 }).limit(limit).lean(),
    /* Only the ones that came off the account. A return refunded in cash is a
       drawer event, not a khata event, and putting it here would suggest the
       debt moved when it did not. */
    Return.find({ businessId, customerId: oid, refundMethod: 'credit' })
      .sort({ at: -1 }).limit(limit).lean(),
    balancesFor(businessId, [oid]),
  ]);

  const timeline = [
    ...orders.map((o) => {
      const paid = o.amountPaid == null ? o.grandTotal : o.amountPaid;
      return {
        type: 'sale',
        at: o.timestamp,
        orderId: String(o._id),
        receiptNo: `INV-${String(o.orderNumber ?? 0).padStart(6, '0')}`,
        total: round2(o.grandTotal),
        paid: round2(paid),
        // What this sale ADDED to the debt. Zero for one that was paid for.
        credited: round2(Math.max(0, o.grandTotal - paid)),
        items: o.items.length,
      };
    }),
    ...payments.map((p) => ({
      type: 'payment',
      at: p.at,
      paymentId: String(p._id),
      amount: round2(p.amount),
      method: p.method,
      note: p.note || '',
    })),
    ...credits.map((r) => ({
      type: 'refund',
      at: r.at,
      returnId: String(r._id),
      creditNoteNo: `CN-${String(r.returnNumber ?? 0).padStart(6, '0')}`,
      receiptNo: `INV-${String(r.orderNumber ?? 0).padStart(6, '0')}`,
      amount: round2(r.refundTotal),
      items: r.lines.length,
      note: r.reason || '',
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);

  res.json({
    ok: true,
    customer: { ...customer, ...(balances.get(customerId) ?? EMPTY) },
    timeline,
  });
}

/** POST /api/customers/:id/payments  { amount, method?, note?, at? } */
export async function recordPayment(req, res) {
  const customerId = assertObjectId(req.params.id);
  const businessId = req.businessId;
  requireFields(req.body, ['amount']);

  const customer = await Customer.findOne({ _id: customerId, businessId }).lean();
  if (!customer) throw ApiError.notFound('Customer not found');

  const amount = toAmount(req.body.amount, 'amount', { required: true });
  if (amount <= 0) throw ApiError.badRequest('Amount must be more than zero', { amount: 'must be > 0' });

  const method = toMethod(req.body.method);
  const at = req.body.at ? new Date(req.body.at) : new Date();
  if (Number.isNaN(at.getTime())) throw ApiError.badRequest('at must be a valid date', { at: 'invalid' });

  /**
   * Overpayment is allowed, and deliberately so. A customer settling a 940
   * rupee debt with a 1000 rupee note leaves 60 on account, and refusing to
   * record that would send the shopkeeper back to a paper book for the one case
   * the app most needs to handle. It shows as a negative balance -- money the
   * SHOP owes -- which is the truth.
   */
  const payment = await Payment.create({
    businessId,
    customerId,
    customerName: customer.name,
    amount,
    method,
    note: String(req.body.note ?? '').trim(),
    at,
  });

  const balances = await balancesFor(businessId, [payment.customerId]);
  res.status(201).json({
    ok: true,
    payment,
    balance: balances.get(customerId)?.balance ?? 0,
  });
}

/** DELETE /api/payments/:id — undo a repayment entered by mistake. */
export async function deletePayment(req, res) {
  assertObjectId(req.params.id);
  const payment = await Payment.softDeleteOne({ _id: req.params.id, businessId: req.businessId });
  if (!payment) throw ApiError.notFound('Payment not found');

  const balances = await balancesFor(req.businessId, [payment.customerId]);
  res.json({
    ok: true,
    deleted: { _id: payment._id, amount: payment.amount },
    balance: balances.get(String(payment.customerId))?.balance ?? 0,
  });
}

/** Used by the report summary; exported so the receivable total has one source. */
export async function receivablesTotal(businessId) {
  const balances = await balancesFor(businessId);
  let owed = 0;
  let inCredit = 0;
  let owing = 0;
  for (const [, v] of balances) {
    if (v.balance > 0) { owed = round2(owed + v.balance); owing += 1; }
    else if (v.balance < 0) inCredit = round2(inCredit - v.balance);
  }
  return { owed, inCredit, owing };
}
