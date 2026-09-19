import mongoose from 'mongoose';
import { Order, Product, Counter, Return } from '../models/index.js';
import { REFUND_METHODS } from '../models/Return.js';
import { ApiError } from '../utils/ApiError.js';
import { assertObjectId, toQty, round2, parseDateRange } from '../utils/validators.js';
import { allowsFraction, round3 } from '../models/units.js';
import { recordMovement } from '../utils/stockLog.js';

const creditNoteNo = (n) => `CN-${String(n ?? 0).padStart(6, '0')}`;
const receiptNo = (n) => `INV-${String(n ?? 0).padStart(6, '0')}`;

/**
 * Whether a quantity is expressible in the unit it is measured in.
 *
 * Same rule the till applies, and for the same reason: 1.5 kg of rice is a
 * sentence, 1.5 packets is not. It has to be re-checked here rather than
 * trusted from the sale, because a return is a NEW quantity somebody typed.
 */
function assertQtyFitsUnit(qty, unit, name) {
  if (!allowsFraction(unit) && !Number.isInteger(qty)) {
    throw ApiError.badRequest(`"${name}" is counted in whole ${unit}`, {
      qty: `must be a whole number of ${unit}`,
    });
  }
  return allowsFraction(unit) ? round3(qty) : qty;
}

function toRefundMethod(value, fallback = 'cash') {
  if (value === undefined || value === null || value === '') return fallback;
  const m = String(value).trim().toLowerCase();
  if (!REFUND_METHODS.includes(m)) {
    throw ApiError.badRequest(`"${value}" is not a refund method`, {
      refundMethod: `must be one of: ${REFUND_METHODS.join(', ')}`,
    });
  }
  return m;
}

/**
 * How much of each product has already come back off this receipt.
 *
 * Keyed by product, because that is how an order's lines are keyed -- the till
 * merges repeat scans of the same item into one line, so a product appears at
 * most once on a receipt.
 */
export async function returnedSoFar(businessId, orderId) {
  const rows = await Return.find({ businessId, orderId }).lean();
  const byProduct = new Map();
  for (const r of rows) {
    for (const l of r.lines) {
      const key = String(l.productId);
      byProduct.set(key, round3((byProduct.get(key) ?? 0) + l.qty));
    }
  }
  return { byProduct, returns: rows };
}

/**
 * Reads the requested lines against the receipt they came off.
 *
 * Everything is checked before a single unit of stock moves: what is not on the
 * receipt, what is asked for twice, and -- the one that matters -- what would
 * take the total returned past what was actually sold. A shop that can return
 * four of three has a hole in its stock figures and its takings.
 */
function buildReturnLines(order, requested, already) {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw ApiError.badRequest('Choose at least one item to return', { items: 'required' });
  }

  const soldBy = new Map(order.items.map((l) => [String(l.productId), l]));
  const seen = new Set();
  const lines = [];

  for (const [i, raw] of requested.entries()) {
    const id = String(assertObjectId(raw?.productId, `items[${i}].productId`));
    const sold = soldBy.get(id);
    if (!sold) {
      throw ApiError.badRequest('That item is not on this receipt', {
        [`items[${i}].productId`]: 'not on the original sale',
      });
    }
    if (seen.has(id)) {
      throw ApiError.badRequest(`"${sold.name}" is listed twice`, {
        [`items[${i}].productId`]: 'listed more than once',
      });
    }
    seen.add(id);

    let qty = toQty(raw?.qty, `items[${i}].qty`);
    qty = assertQtyFitsUnit(qty, sold.unit, sold.name);

    const left = round3(sold.qty - (already.get(id) ?? 0));
    if (left <= 0) {
      throw ApiError.badRequest(`All of the "${sold.name}" has already been returned`, {
        [`items[${i}].qty`]: `0 ${sold.unit} left to return`,
      });
    }
    if (qty > left) {
      throw ApiError.badRequest(
        `Only ${left} ${sold.unit} of "${sold.name}" can still be returned`,
        { [`items[${i}].qty`]: `at most ${left}`, available: left }
      );
    }

    /**
     * The refund rate is what was CHARGED per unit on that line, which is the
     * line's own total over its quantity -- not the price field, which is
     * before the line's discount. Refunding at the undiscounted price hands
     * back money that never came in.
     */
    const chargedEach = round2((sold.lineTotal ?? 0) / sold.qty);

    lines.push({
      productId: sold.productId,
      name: sold.name,
      qty,
      unit: sold.unit,
      price: chargedEach,
      cost: sold.cost ?? 0,
      refund: round2(qty * chargedEach),
    });
  }

  return lines;
}

/** POST /api/orders/:id/returns  { items:[{productId, qty}], refundMethod?, reason? } */
export async function createReturn(req, res) {
  const orderId = assertObjectId(req.params.id);
  const businessId = req.businessId;

  const order = await Order.findOne({ _id: orderId, businessId }).lean();
  if (!order) {
    /* A voided sale is soft-deleted, so it does not come back from that query.
       Saying "no such sale" would be confusing when the operator is looking
       right at it in the list, so the voided case gets its own answer. */
    const voided = await Order.findOne({ _id: orderId, businessId }).withDeleted().lean();
    if (voided) {
      throw ApiError.badRequest(
        'That sale was cancelled, so there is nothing to return against. The stock already went back.'
      );
    }
    throw ApiError.notFound('Order not found');
  }

  const { byProduct } = await returnedSoFar(businessId, orderId);
  const lines = buildReturnLines(order, req.body?.items, byProduct);
  const refundMethod = toRefundMethod(req.body?.refundMethod);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 140);

  /**
   * Crediting a khata needs a khata. Without a customer on the sale there is no
   * account to reduce, and a refund recorded as "credit" to nobody would be
   * money that left the books without leaving the drawer.
   */
  if (refundMethod === 'credit' && !order.customerId) {
    throw ApiError.badRequest(
      'This sale was not on anybody\'s account, so there is no balance to credit. Refund it in cash, UPI or card.',
      { refundMethod: 'needs a customer on the original sale' }
    );
  }

  const payload = {
    businessId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    customerId: order.customerId ?? null,
    customerName: order.customerName ?? '',
    lines,
    refundMethod,
    reason,
  };

  const apply = async (session) => {
    const returnNumber = await Counter.next(`${businessId}:return`, session ? { session } : undefined);
    const note = creditNoteNo(returnNumber);

    for (const line of lines) {
      /**
       * Read-then-write only to learn the `before` figure for the ledger row;
       * the change itself is an atomic $inc, so a sale landing at the same
       * moment cannot be clobbered. A product deleted since the sale simply has
       * no stock to credit -- that is reported, not fatal, exactly as a void
       * treats it.
       */
      const updated = await Product.findOneAndUpdate(
        { _id: line.productId, businessId },
        { $inc: { stock: line.qty } },
        { new: true, ...(session && { session }) }
      );
      if (!updated) continue;

      await recordMovement({
        businessId,
        productId: line.productId,
        productName: line.name,
        before: round3(updated.stock - line.qty),
        after: updated.stock,
        reason: 'return',
        note: `${note} · ${receiptNo(order.orderNumber)}`,
        session,
      });
    }

    const [created] = await Return.create([{ ...payload, returnNumber }], { ...(session && { session }) });
    return created;
  };

  let created;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => { created = await apply(session); });
  } catch (err) {
    if (err instanceof ApiError || !isTransactionUnsupported(err)) {
      await session.endSession();
      throw err;
    }
    /* Standalone mongod: no transaction available. The stock increments are
       individually atomic and a return can only ever ADD stock, so a partial
       failure leaves the shelf over-counted rather than a sale unsellable --
       and the ledger rows say exactly which products got their units back. */
    created = await apply(null);
  } finally {
    await session.endSession();
  }

  res.status(201).json({
    ok: true,
    return: { ...created.toObject(), creditNoteNo: creditNoteNo(created.returnNumber) },
  });
}

/** Mongo's way of saying "this deployment has no transactions". */
function isTransactionUnsupported(err) {
  const msg = String(err?.message ?? '');
  return err?.code === 20
    || /Transaction numbers are only allowed/i.test(msg)
    || /replica set|mongos/i.test(msg);
}

/** GET /api/orders/:id/returns -- what has already come back off one receipt. */
export async function listOrderReturns(req, res) {
  const orderId = assertObjectId(req.params.id);
  const { byProduct, returns } = await returnedSoFar(req.businessId, orderId);
  res.json({
    ok: true,
    returns: returns
      .map((r) => ({ ...r, creditNoteNo: creditNoteNo(r.returnNumber) }))
      .sort((a, b) => new Date(b.at) - new Date(a.at)),
    returnedByProduct: Object.fromEntries(byProduct),
  });
}

/** GET /api/returns?from=&to= -- every credit note in a period. */
export async function listReturns(req, res) {
  const { from, to } = parseDateRange(req.query);
  const rows = await Return.find({ businessId: req.businessId, at: { $gte: from, $lte: to } })
    .sort({ at: -1 })
    .limit(200)
    .lean();
  res.json({
    ok: true,
    returns: rows.map((r) => ({
      ...r,
      creditNoteNo: creditNoteNo(r.returnNumber),
      receiptNo: receiptNo(r.orderNumber),
    })),
    range: { from, to },
  });
}

/**
 * DELETE /api/returns/:id -- undo a return entered by mistake.
 *
 * The stock has to come BACK OUT, and it may not be there: the units could have
 * been sold again in the meantime. That is a refusal, not a silent negative
 * stock figure, because a shop whose stock went negative stops trusting all of
 * it.
 */
export async function undoReturn(req, res) {
  const id = assertObjectId(req.params.id);
  const businessId = req.businessId;

  const doc = await Return.findOne({ _id: id, businessId }).lean();
  if (!doc) throw ApiError.notFound('Return not found');

  const taken = [];
  try {
    for (const line of doc.lines) {
      const updated = await Product.findOneAndUpdate(
        { _id: line.productId, businessId, stock: { $gte: line.qty } },
        { $inc: { stock: -line.qty } },
        { new: true }
      );
      if (!updated) {
        const current = await Product.findOne({ _id: line.productId, businessId }).lean();
        /* A product deleted since has nothing to take back; that is not a
           reason to refuse, the units are simply gone either way. */
        if (!current) continue;
        throw ApiError.conflict(
          `"${line.name}" has been sold again since -- only ${current.stock} ${line.unit} on the shelf, and undoing this needs ${line.qty}`,
          { productId: String(line.productId), available: current.stock, needed: line.qty }
        );
      }
      taken.push(line);
      await recordMovement({
        businessId,
        productId: line.productId,
        productName: line.name,
        before: round3(updated.stock + line.qty),
        after: updated.stock,
        reason: 'correction',
        note: `Undid ${creditNoteNo(doc.returnNumber)}`,
      });
    }
  } catch (err) {
    // Put back whatever was already taken, so a refused undo changes nothing.
    await Promise.allSettled(
      taken.map((l) => Product.updateOne({ _id: l.productId, businessId }, { $inc: { stock: l.qty } }))
    );
    throw err;
  }

  await Return.softDeleteOne({ _id: id, businessId });

  res.json({
    ok: true,
    undone: { _id: doc._id, creditNoteNo: creditNoteNo(doc.returnNumber), refundTotal: doc.refundTotal },
  });
}
