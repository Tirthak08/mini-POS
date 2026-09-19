import mongoose from 'mongoose';
import { Order, Product, Counter, Customer } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { assertObjectId, toAmount, toCount, toQty, round2, parseDateRange } from '../utils/validators.js';
import { allowsFraction, round3, DEFAULT_UNIT } from '../models/units.js';
import { PAYMENT_METHODS } from '../models/Order.js';
import { returnedSoFar } from './returnController.js';

/**
 * A quantity cannot be fully judged until the product is known -- whether a
 * fraction is legal depends on how that product is measured. So parsing happens
 * in two steps: shape and range as the cart is read, unit-legality once the
 * products have been loaded.
 */
function assertQtyFitsUnit(qty, product, field) {
  const unit = product?.unit ?? DEFAULT_UNIT;
  if (allowsFraction(unit) || Number.isInteger(qty)) return qty;
  throw ApiError.badRequest(
    `"${product.name}" is sold in ${unit}, so the quantity must be a whole number`,
    { [field]: 'must be a whole number for this unit' }
  );
}

/**
 * The client's id for this sale, if it sent one. Validated here rather than
 * left to the schema so a malformed ref fails before any stock moves.
 */
function toClientRef(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const ref = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{8,64}$/.test(ref)) {
    throw ApiError.badRequest('clientRef must be 8-64 characters of A-Z a-z 0-9 . _ : -', {
      clientRef: 'malformed',
    });
  }
  return ref;
}

/** An order already written for this ref, deleted ones included. */
async function findByClientRef(businessId, clientRef) {
  if (!clientRef) return null;
  return Order.findOne({ businessId, clientRef }).withDeleted();
}

/**
 * Resolves the customer a sale is for, and how much of it was actually paid.
 *
 * Credit without a named customer is refused. A walk-in who underpays is not a
 * debt -- there is nobody to collect from -- so accepting it would create a
 * receivable that can never be settled and would sit in the shop's totals
 * forever.
 */
async function resolveCustomer(businessId, body, grandTotal) {
  let customer = null;
  if (body?.customerId) {
    const id = assertObjectId(body.customerId, 'customerId');
    customer = await Customer.findOne({ _id: id, businessId }).lean();
    if (!customer) {
      throw ApiError.badRequest('That customer does not belong to this business', {
        customerId: 'not found',
      });
    }
  }

  if (body?.amountPaid === undefined || body?.amountPaid === null || body?.amountPaid === '') {
    return { customer, amountPaid: undefined };
  }

  const amountPaid = toAmount(body.amountPaid, 'amountPaid');
  if (amountPaid > grandTotal) {
    throw ApiError.badRequest('Paid more than the bill. Use extra charges or a discount instead.', {
      amountPaid: `must be <= ${grandTotal}`,
    });
  }
  if (amountPaid < grandTotal && !customer) {
    throw ApiError.badRequest(
      'A part-paid sale has to name a customer, or there is nobody to collect from.',
      { customerId: 'required when amountPaid is less than the total' }
    );
  }
  return { customer, amountPaid };
}

function toPaymentMethod(value) {
  if (value === undefined || value === null || value === '') return 'cash';
  const m = String(value).trim().toLowerCase();
  if (!PAYMENT_METHODS.includes(m)) {
    throw ApiError.badRequest(`"${value}" is not a payment method`, {
      paymentMethod: `must be one of: ${PAYMENT_METHODS.join(', ')}`,
    });
  }
  return m;
}
import { isTransactionUnsupported } from '../utils/txnSupport.js';

/**
 * Atlas (even the free M0) is a replica set, so transactions work there.
 * A plain local `mongod` is standalone and rejects them. We try the correct
 * path first and remember the answer, falling back to compensating writes.
 */
let txnSupported = null;

/**
 * Turns the client cart into trusted line items.
 *
 * Names and COSTS always come from the database. Cost decides reported profit
 * and must never be settable by a request body, or margins become fiction.
 *
 * PRICE is different, and deliberately so. A shop sells the same item above or
 * below the shelf price all the time -- a haggled rate, a damaged tin, a
 * regular getting a discount, or the shopkeeper simply collecting more than
 * the catalogue says. Refusing that forced the operator to go and edit the
 * product, sell, then edit it back, which is worse in every way: it rewrites
 * the catalogue for a one-off and leaves the wrong price live in between.
 *
 * So an explicit per-line `price` is honoured, and this is not the security
 * hole it first looks like. The token already authenticates the SHOP owner,
 * who can set any price they like through PATCH /products; the override adds
 * no capability they did not have. What it must not do is destroy the record,
 * so every line keeps `listPrice` -- the catalogue price at that moment --
 * alongside what was actually charged. A sale above or below list is then
 * visible rather than indistinguishable from a repricing.
 */
async function buildLines(businessId, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw ApiError.badRequest('The cart is empty', { items: 'must be a non-empty array' });
  }
  if (rawItems.length > 200) throw ApiError.badRequest('Too many line items in one order');

  // The same product tapped twice becomes one line, so stock maths stays right.
  //
  // Merging on productId ALONE is deliberate even now that lines carry a price.
  // Keeping two lines for one product would need the stock guard to reason
  // across them -- each `stock: {$gte: qty}` check would pass on its own while
  // the pair oversold. The cart never produces two lines for one product
  // anyway (adding an existing item bumps its quantity), so the last price
  // given wins and the guard stays sound.
  const merged = new Map();
  for (const [i, raw] of rawItems.entries()) {
    const productId = assertObjectId(raw?.productId, `items[${i}].productId`);
    const qty = toQty(raw?.qty ?? 1, `items[${i}].qty`, { required: true, min: 0.001, max: 100_000 });
    const discount = toAmount(raw?.discount, `items[${i}].discount`);
    // undefined means "charge the catalogue price"; 0 is a legitimate giveaway
    // and must not be confused with it.
    const price = raw?.price === undefined || raw?.price === null || raw?.price === ''
      ? undefined
      : toAmount(raw.price, `items[${i}].price`);
    const prev = merged.get(productId);
    merged.set(productId, prev
      ? {
        productId,
        // round3 on the way in: 0.1 + 0.2 is 0.30000000000000004, and a
        // quantity that cannot be printed is a quantity nobody trusts.
        qty: round3(prev.qty + qty),
        discount: round2(prev.discount + discount),
        price: price ?? prev.price,
      }
      : { productId, qty, discount, price });
  }

  const ids = [...merged.keys()];
  const products = await Product.find({ businessId, _id: { $in: ids } }).lean();

  if (products.length !== ids.length) {
    const found = new Set(products.map((p) => String(p._id)));
    throw ApiError.badRequest('Some items are no longer available', {
      missing: ids.filter((id) => !found.has(id)),
    });
  }

  const byId = new Map(products.map((p) => [String(p._id), p]));
  const lines = [];
  const outOfStock = [];

  for (const cart of merged.values()) {
    const p = byId.get(cart.productId);
    assertQtyFitsUnit(cart.qty, p, 'qty');
    if (p.stock < cart.qty) {
      outOfStock.push({ productId: cart.productId, name: p.name, requested: cart.qty, available: p.stock });
      continue;
    }
    const listPrice = p.price;
    const price = cart.price ?? listPrice;
    const gross = round2(price * cart.qty);
    // PRD 7, edge case 2: a discount can never exceed the line's own value,
    // so a line total -- and therefore the order total -- can never go negative.
    // Note it clamps against the OVERRIDDEN gross, so dropping the price also
    // shrinks the largest discount that line can carry.
    const discount = Math.min(cart.discount, gross);
    lines.push({
      productId: p._id,
      name: p.name,
      qty: cart.qty,
      unit: p.unit ?? DEFAULT_UNIT,
      price,
      listPrice,
      cost: p.cost ?? 0,
      discount,
      lineTotal: round2(gross - discount),
    });
  }

  if (outOfStock.length) {
    throw ApiError.conflict('Not enough stock for some items', { outOfStock });
  }
  return lines;
}

async function persistInTransaction(businessId, lines, payload) {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      // Reserved inside the transaction so a rolled-back sale does not burn a
      // receipt number.
      const orderNumber = await Counter.next(`${businessId}:order`, { session });
      for (const line of lines) {
        // The stock: {$gte: qty} filter is the real concurrency guard -- if two
        // phones check out the last unit, exactly one update matches.
        const r = await Product.updateOne(
          { _id: line.productId, businessId, stock: { $gte: line.qty } },
          { $inc: { stock: -line.qty } },
          { session }
        );
        if (r.modifiedCount !== 1) {
          throw ApiError.conflict(`"${line.name}" just sold out while you were checking out`, {
            outOfStock: [{ productId: String(line.productId), name: line.name, requested: line.qty }],
          });
        }
      }
      [order] = await Order.create([{ ...payload, orderNumber }], { session });
    });
    return order;
  } finally {
    await session.endSession();
  }
}

/** Standalone-mongod path: same guarded decrements, manual rollback on failure. */
async function persistWithCompensation(businessId, lines, payload) {
  const applied = [];
  try {
    const orderNumber = await Counter.next(`${businessId}:order`);
    for (const line of lines) {
      const r = await Product.updateOne(
        { _id: line.productId, businessId, stock: { $gte: line.qty } },
        { $inc: { stock: -line.qty } }
      );
      if (r.modifiedCount !== 1) {
        throw ApiError.conflict(`"${line.name}" just sold out while you were checking out`, {
          outOfStock: [{ productId: String(line.productId), name: line.name, requested: line.qty }],
        });
      }
      applied.push(line);
    }
    return await Order.create({ ...payload, orderNumber });
  } catch (err) {
    await Promise.allSettled(
      applied.map((l) => Product.updateOne({ _id: l.productId, businessId }, { $inc: { stock: l.qty } }))
    );
    throw err;
  }
}

/** POST /api/orders  { customerName?, extraCharges?, items:[{productId, qty, discount?}] } */
export async function checkout(req, res) {
  const businessId = req.businessId;
  const clientRef = toClientRef(req.body?.clientRef);

  /**
   * Checked BEFORE the cart is priced or any stock moves. A replayed sale must
   * cost nothing and change nothing -- it is the same sale arriving twice, not
   * a second one.
   */
  const already = await findByClientRef(businessId, clientRef);
  if (already) {
    return res.status(200).json({ ok: true, order: already, duplicate: true });
  }

  const lines = await buildLines(businessId, req.body?.items);

  // Gross, then the discount shown as its own deduction -- the schema's
  // pre-validate hook recomputes all three from the lines anyway.
  const subtotal = round2(lines.reduce((s, l) => s + round2(l.qty * l.price), 0));
  const discountTotal = round2(lines.reduce((s, l) => s + (l.discount || 0), 0));
  const extraCharges = toAmount(req.body?.extraCharges, 'extraCharges');
  // Settled before the customer is resolved, because what counts as a PARTIAL
  // payment cannot be judged without knowing the whole bill.
  const grandTotal = round2(Math.max(0, subtotal - discountTotal + extraCharges));

  const { customer, amountPaid } = await resolveCustomer(businessId, req.body, grandTotal);

  const payload = {
    businessId,
    customerId: customer?._id ?? null,
    // The customer's own name wins over anything typed: a sale filed under a
    // ledger has to read the same as the ledger it is filed under.
    customerName: customer?.name
      || String(req.body?.customerName || '').trim()
      || 'Walk-in',
    ...(amountPaid !== undefined && { amountPaid }),
    paymentMethod: toPaymentMethod(req.body?.paymentMethod),
    ...(clientRef && { clientRef }),
    items: lines,
    subtotal,
    discountTotal,
    extraCharges,
    grandTotal,
    timestamp: new Date(),
  };

  let order;
  try {
    if (txnSupported === false) {
      order = await persistWithCompensation(businessId, lines, payload);
    } else {
      try {
        order = await persistInTransaction(businessId, lines, payload);
        txnSupported = true;
      } catch (err) {
        if (err instanceof ApiError || !isTransactionUnsupported(err)) throw err;
        console.warn('Transactions unavailable on this MongoDB; using compensating writes.');
        txnSupported = false;
        order = await persistWithCompensation(businessId, lines, payload);
      }
    }
  } catch (err) {
    /**
     * Two replays of the same queued sale can arrive close enough together
     * that both pass the check above. The unique index settles it, and the
     * loser returns the winner's receipt rather than an error the operator
     * cannot act on -- the sale IS recorded, just not by this request.
     *
     * Stock is safe either way: the loser's transaction rolled back, and on the
     * compensating path its decrements are put back by the same handler that
     * covers any other failed write.
     */
    if (err?.code === 11000 && clientRef) {
      const winner = await findByClientRef(businessId, clientRef);
      if (winner) return res.status(200).json({ ok: true, order: winner, duplicate: true });
    }
    throw err;
  }

  res.status(201).json({ ok: true, order });
}

/**
 * Rebuilds an existing order's lines from the client's desired set.
 *
 * Prices for lines that were ALREADY on the receipt keep their original
 * snapshot: a correction to a quantity must not silently reprice a past sale
 * because the product's price changed since. Genuinely new lines are priced at
 * today's price, from the database.
 *
 * An explicit `price` on a line overrides both -- that is how a mis-keyed
 * amount gets corrected after the fact. `listPrice` is preserved from the
 * snapshot where there is one, because it records what the catalogue said on
 * the day of the SALE, not the day of the correction.
 */
async function rebuildLines(businessId, rawItems, order) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw ApiError.badRequest('An order must keep at least one item. Void it instead.', {
      items: 'must be a non-empty array',
    });
  }
  if (rawItems.length > 200) throw ApiError.badRequest('Too many line items in one order');

  const original = new Map(order.items.map((i) => [String(i.productId), i]));

  const merged = new Map();
  for (const [i, raw] of rawItems.entries()) {
    const productId = assertObjectId(raw?.productId, `items[${i}].productId`);
    const qty = toQty(raw?.qty ?? 1, `items[${i}].qty`, { required: true, min: 0.001, max: 100_000 });
    const discount = toAmount(raw?.discount, `items[${i}].discount`);
    const price = raw?.price === undefined || raw?.price === null || raw?.price === ''
      ? undefined
      : toAmount(raw.price, `items[${i}].price`);
    const prev = merged.get(productId);
    merged.set(productId, prev
      ? {
        productId,
        // round3 on the way in: 0.1 + 0.2 is 0.30000000000000004, and a
        // quantity that cannot be printed is a quantity nobody trusts.
        qty: round3(prev.qty + qty),
        discount: round2(prev.discount + discount),
        price: price ?? prev.price,
      }
      : { productId, qty, discount, price });
  }

  // Only products that were NOT already on the receipt need looking up.
  const newIds = [...merged.keys()].filter((id) => !original.has(id));
  const fetched = newIds.length
    ? await Product.find({ businessId, _id: { $in: newIds } }).lean()
    : [];
  if (fetched.length !== newIds.length) {
    const found = new Set(fetched.map((p) => String(p._id)));
    throw ApiError.badRequest('Some items are not available', {
      missing: newIds.filter((id) => !found.has(id)),
    });
  }
  const byId = new Map(fetched.map((p) => [String(p._id), p]));

  const lines = [];
  for (const cart of merged.values()) {
    const snapshot = original.get(cart.productId);
    const source = snapshot ?? byId.get(cart.productId);
    const snapshotPrice = snapshot ? snapshot.price : source.price;
    const price = cart.price ?? snapshotPrice;
    const cost = snapshot ? snapshot.cost : (source.cost ?? 0);
    const name = snapshot ? snapshot.name : source.name;
    // What the catalogue said when this line was first sold. For a line added
    // during the correction there is no such history, so today's price is it.
    const listPrice = snapshot ? (snapshot.listPrice ?? snapshot.price) : source.price;
    const unit = snapshot ? (snapshot.unit ?? DEFAULT_UNIT) : (source.unit ?? DEFAULT_UNIT);
    assertQtyFitsUnit(cart.qty, { name, unit }, 'qty');

    const gross = round2(price * cart.qty);
    const discount = Math.min(cart.discount, gross); // PRD 7, edge case 2
    lines.push({
      productId: snapshot ? snapshot.productId : source._id,
      name,
      qty: cart.qty,
      unit,
      price,
      listPrice,
      cost,
      discount,
      lineTotal: round2(gross - discount),
    });
  }
  return lines;
}

/**
 * Applies the difference between what the receipt used to hold and what it holds
 * now. Only the DELTA moves, so editing 3 -> 4 takes one more unit rather than
 * returning three and taking four.
 */
async function reconcileStock(businessId, oldLines, newLines, session) {
  const oldQty = new Map(oldLines.map((i) => [String(i.productId), i.qty]));
  const newQty = new Map(newLines.map((i) => [String(i.productId), i.qty]));
  const ids = new Set([...oldQty.keys(), ...newQty.keys()]);

  const applied = [];
  const restoredToMissing = [];

  try {
    for (const id of ids) {
      const delta = (newQty.get(id) ?? 0) - (oldQty.get(id) ?? 0);
      if (delta === 0) continue;

      if (delta > 0) {
        // Selling more: the stock has to actually be there.
        const r = await Product.updateOne(
          { _id: id, businessId, stock: { $gte: delta } },
          { $inc: { stock: -delta } },
          { ...(session && { session }) }
        );
        if (r.modifiedCount !== 1) {
          const current = await Product.findOne({ _id: id, businessId }).lean();
          const name = newLines.find((l) => String(l.productId) === id)?.name ?? 'item';
          throw ApiError.conflict(
            current ? `Only ${current.stock} of "${name}" left in stock` : `"${name}" is no longer available`,
            { outOfStock: [{ productId: id, name, requested: delta, available: current?.stock ?? 0 }] }
          );
        }
      } else {
        // Selling fewer: give the units back.
        const r = await Product.updateOne(
          { _id: id, businessId },
          { $inc: { stock: -delta } },
          { ...(session && { session }) }
        );
        // The product may have been deleted since the sale. That is not a reason
        // to block the correction, but it is worth reporting.
        if (r.modifiedCount !== 1) restoredToMissing.push(id);
      }
      applied.push({ id, delta });
    }
    return { restoredToMissing };
  } catch (err) {
    // Without a transaction, undo whatever already landed.
    if (!session) {
      await Promise.allSettled(
        applied.map(({ id, delta }) =>
          Product.updateOne({ _id: id, businessId }, { $inc: { stock: delta } })
        )
      );
    }
    throw err;
  }
}

/**
 * PATCH /api/orders/:id   { customerName?, extraCharges?, items? }
 *
 * `items` is the COMPLETE desired set, not a diff -- the server works out what
 * changed. That keeps one code path for changing a quantity, removing a line and
 * adding a forgotten item.
 *
 * The receipt number never changes, and the edit is stamped so a corrected sale
 * is distinguishable from an original one.
 */
export async function updateOrder(req, res) {
  assertObjectId(req.params.id);
  const businessId = req.businessId;

  const order = await Order.findOne({ _id: req.params.id, businessId });
  if (!order) throw ApiError.notFound('Order not found');

  const hasItems = req.body?.items !== undefined;
  const hasCustomer = req.body?.customerName !== undefined;
  const hasCharges = req.body?.extraCharges !== undefined;
  const hasPayment = req.body?.paymentMethod !== undefined;
  const hasPaid = req.body?.amountPaid !== undefined;
  const hasCustomerId = req.body?.customerId !== undefined;
  if (!hasItems && !hasCustomer && !hasCharges && !hasPayment && !hasPaid && !hasCustomerId) {
    throw ApiError.badRequest(
      'Nothing to update -- send customerName, customerId, amountPaid, paymentMethod, extraCharges and/or items'
    );
  }
  // Validated before anything is written: "it was UPI, not cash" is the most
  // ordinary correction there is, and getting it wrong must not cost the edit.
  const paymentMethod = hasPayment ? toPaymentMethod(req.body.paymentMethod) : null;

  const oldLines = order.items.map((i) => ({ productId: i.productId, qty: i.qty, name: i.name }));
  const newLines = hasItems ? await rebuildLines(businessId, req.body.items, order) : null;

  const apply = async (session) => {
    let notes = { restoredToMissing: [] };
    if (newLines) {
      notes = await reconcileStock(businessId, oldLines, newLines, session);
      order.items = newLines;
    }
    if (hasCustomer) order.customerName = String(req.body.customerName).trim() || 'Walk-in';
    if (hasCharges) order.extraCharges = toAmount(req.body.extraCharges, 'extraCharges');
    if (hasPayment) order.paymentMethod = paymentMethod;

    /**
     * "They paid the rest" and "that was actually for Ramesh" are both ordinary
     * corrections, so both are editable. Order matters: the customer has to be
     * attached before the amount is judged, or moving a walk-in sale onto a
     * ledger and part-paying it in one edit would be refused.
     */
    if (hasCustomerId) {
      if (req.body.customerId === null || req.body.customerId === '') {
        order.customerId = null;
      } else {
        const id = assertObjectId(req.body.customerId, 'customerId');
        const customer = await Customer.findOne({ _id: id, businessId }).lean();
        if (!customer) {
          throw ApiError.badRequest('That customer does not belong to this business', {
            customerId: 'not found',
          });
        }
        order.customerId = customer._id;
        order.customerName = customer.name;
      }
    }

    if (hasPaid) {
      const paid = req.body.amountPaid === null || req.body.amountPaid === ''
        ? undefined
        : toAmount(req.body.amountPaid, 'amountPaid');
      if (paid !== undefined && paid < order.grandTotal && !order.customerId) {
        throw ApiError.badRequest(
          'A part-paid sale has to name a customer, or there is nobody to collect from.',
          { customerId: 'required when amountPaid is less than the total' }
        );
      }
      order.amountPaid = paid;
    }

    order.editedAt = new Date();
    order.editCount = (order.editCount || 0) + 1;
    // The pre-validate hooks recompute subtotal and grandTotal from the lines.
    await order.save({ ...(session && { session }) });
    return notes;
  };

  let notes;
  if (txnSupported === false) {
    notes = await apply(null);
  } else {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => { notes = await apply(session); });
      txnSupported = true;
    } catch (err) {
      if (err instanceof ApiError || !isTransactionUnsupported(err)) throw err;
      txnSupported = false;
      notes = await apply(null);
    } finally {
      await session.endSession();
    }
  }

  res.json({
    ok: true,
    order,
    ...(notes.restoredToMissing.length && {
      warning: 'Some returned stock could not be credited because the product has been deleted',
      details: { deletedProducts: notes.restoredToMissing },
    }),
  });
}

/** "INV-000042". Built explicitly because .lean() skips schema virtuals. */
const receiptNo = (orderNumber) => `INV-${String(orderNumber ?? 0).padStart(6, '0')}`;

/** Escapes a user's text so it cannot smuggle regex syntax into the query. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turns what somebody typed into a filter over receipts.
 *
 * Three things are worth searching for and a shopkeeper does not announce which
 * one they mean, so all three are tried at once:
 *
 *   "42", "INV-42", "inv-000042"   -> receipt number 42
 *   "ramesh"                       -> the customer the sale was filed under
 *   "1250"                         -> a sale that came to exactly that
 *
 * The numeric forms are ORed with the name match rather than guessed between,
 * because "42" is a perfectly good receipt number AND a perfectly good total,
 * and a search that silently picked one would look broken from the other side.
 *
 * Returns null when the query is empty, which is the caller's signal to fall
 * back to the plain date-windowed listing.
 */
function searchFilter(raw) {
  const q = String(raw ?? '').trim();
  if (!q) return null;

  const or = [{ customerName: { $regex: escapeRegex(q), $options: 'i' } }];

  /* "INV-000042", "inv 42" and "42" all mean receipt 42. Leading zeros are
     dropped by Number(), which is exactly right here. */
  const digits = q.replace(/^inv[\s-]*/i, '').replace(/[^0-9.]/g, '');
  if (digits && Number.isFinite(Number(digits))) {
    const n = Number(digits);
    if (Number.isInteger(n) && n > 0) or.push({ orderNumber: n });
    /* Matched on the rounded total rather than a range: the figure a shop
       remembers is the one that was on the screen. */
    or.push({ grandTotal: round2(n) });
  }

  return { $or: or };
}

/**
 * GET /api/orders?from=&to=&page=1&limit=20&q=
 *
 * With `q`, the date window is deliberately IGNORED. Somebody hunting for a
 * receipt is hunting precisely because it is not in front of them, and a search
 * that only looked inside the month already on screen would answer "no such
 * sale" about a sale that exists. The response says which mode it answered in
 * so the screen can tell the operator.
 */
export async function listOrders(req, res) {
  const { from, to } = parseDateRange(req.query);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const search = searchFilter(req.query.q);
  const filter = search
    ? { businessId: req.businessId, ...search }
    : { businessId: req.businessId, timestamp: { $gte: from, $lte: to } };

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);

  res.json({
    ok: true,
    orders: orders.map((o) => ({ ...o, receiptNo: receiptNo(o.orderNumber) })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    ...(search
      ? { search: { q: String(req.query.q).trim(), allTime: true } }
      : { range: { from, to } }),
  });
}

/**
 * GET /api/orders/:id -- receipt reprint, and what is left of it.
 *
 * Each line carries `returned` and `returnable` so the return form can cap its
 * steppers without a second round trip, and so the receipt can say "2 of 3
 * returned" rather than looking untouched after half of it came back.
 */
export async function getOrder(req, res) {
  assertObjectId(req.params.id);
  const order = await Order.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
  if (!order) throw ApiError.notFound('Order not found');

  const { byProduct, returns } = await returnedSoFar(req.businessId, order._id);
  const items = order.items.map((l) => {
    const returned = byProduct.get(String(l.productId)) ?? 0;
    return { ...l, returned, returnable: round3(Math.max(0, l.qty - returned)) };
  });

  res.json({
    ok: true,
    order: {
      ...order,
      items,
      receiptNo: receiptNo(order.orderNumber),
      returnedTotal: round2(returns.reduce((sum, r) => sum + (r.refundTotal || 0), 0)),
      returnCount: returns.length,
    },
  });
}

/**
 * DELETE /api/orders/:id -- void a mistaken sale and put the stock back.
 * Soft delete: the receipt survives for audit, its number is never reused, and
 * every report excludes it automatically via the soft-delete middleware.
 */
export async function voidOrder(req, res) {
  assertObjectId(req.params.id);
  const order = await Order.softDeleteOne({ _id: req.params.id, businessId: req.businessId });
  if (!order) throw ApiError.notFound('Order not found');

  const restored = await Promise.allSettled(
    order.items.map((l) =>
      Product.updateOne({ _id: l.productId, businessId: req.businessId }, { $inc: { stock: l.qty } })
    )
  );

  res.json({
    ok: true,
    voided: { _id: order._id, orderNumber: order.orderNumber, receiptNo: order.receiptNo, grandTotal: order.grandTotal },
    // A product deleted since the sale simply cannot be restocked; say so.
    stockRestored: restored.filter((r) => r.status === 'fulfilled' && r.value.modifiedCount === 1).length,
    itemsInOrder: order.items.length,
  });
}
