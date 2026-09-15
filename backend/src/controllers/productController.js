import mongoose from 'mongoose';
import { Category, Product, ProductImage, Order, StockMovement } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import {
  requireFields, assertObjectId, toAmount, toCount, toQty, toUnit, round2,
} from '../utils/validators.js';
import { allowsFraction, DEFAULT_UNIT } from '../models/units.js';
import { recordMovement, toReason, toNote } from '../utils/stockLog.js';

/**
 * Guarantees an uploaded image belongs to THIS tenant before it is linked, and
 * back-fills the image's own productId so the two rows agree.
 */
async function claimImage(businessId, imageId, productId) {
  if (imageId === null || imageId === undefined || imageId === '') return null;
  assertObjectId(imageId, 'imageId');
  const image = await ProductImage.findOne({ _id: imageId, businessId });
  if (!image) throw ApiError.badRequest('That image does not belong to this business', { imageId: 'not found' });

  if (productId && String(image.productId ?? '') !== String(productId)) {
    image.productId = productId;
    await image.save();
  }
  return image._id;
}

/**
 * Replacing or clearing a photo REMOVES the old one, bytes and all.
 *
 * This used to soft-delete, which was wrong in a way that only showed up as a
 * slowly filling database. Soft delete exists so a row can come back -- but
 * nothing can ever reference this one again: the product's imageId has already
 * moved on, and the admin restore is scoped to `deletedBy`, so a row retired
 * here would never be resurrected by anything. It was pure dead weight, and
 * unlike a product or an order that weight is ~60KB of binary each time.
 *
 * A shopkeeper retaking a photo four times left five copies in the database and
 * showed one. That is the whole storage problem, not the size of any single
 * photo.
 */
async function retireImage(businessId, imageId) {
  if (!imageId) return;
  await ProductImage.hardDeleteMany({ _id: imageId, businessId });
}

/**
 * Turns the driver's E11000 into something a shopkeeper can act on.
 *
 * The unique index is the only place duplicates are actually prevented --
 * checking with a findOne first would still race two phones adding the same
 * product at the same moment. So the check IS the insert, and this translates
 * the failure.
 */
function asDuplicateNameError(err, name) {
  if (err?.code !== 11000) return err;
  return ApiError.conflict(
    `This category already has a product called "${name}"`,
    { name: 'already used in this category' }
  );
}

/** Guarantees the categoryId belongs to THIS tenant before it is stored. */
async function assertOwnCategory(businessId, categoryId) {
  assertObjectId(categoryId, 'categoryId');
  const exists = await Category.exists({ _id: categoryId, businessId });
  if (!exists) throw ApiError.badRequest('That category does not belong to this business', { categoryId: 'not found' });
  return categoryId;
}

/** GET /api/products?categoryId=&search=&lowStock=5 */
export async function listProducts(req, res) {
  const filter = { businessId: req.businessId };

  if (req.query.categoryId) filter.categoryId = assertObjectId(req.query.categoryId, 'categoryId');
  if (req.query.search) {
    // Escaped so a customer name like "50% off (x)" cannot break the regex.
    const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = new RegExp(safe, 'i');
  }
  if (req.query.lowStock !== undefined) {
    filter.stock = { $lte: toCount(req.query.lowStock || 5, 'lowStock') };
  }

  const products = await Product.find(filter)
    .populate('categoryId', 'name color')
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: 1 })
    .lean();

  res.json({
    ok: true,
    products: products.map(({ categoryId, ...p }) => ({
      ...p,
      categoryId: categoryId?._id ?? categoryId ?? null,
      category: categoryId?.name ?? null,
      categoryColor: categoryId?.color ?? null,
      margin: (p.price ?? 0) - (p.cost ?? 0),
      // .lean() skips virtuals, so the path is built here instead.
      imageUrl: p.imageId ? `/images/${p.imageId}` : null,
    })),
  });
}

/** POST /api/products  { name, categoryId, price, cost?, stock? } */
export async function createProduct(req, res) {
  requireFields(req.body, ['name', 'categoryId', 'price']);
  await assertOwnCategory(req.businessId, req.body.categoryId);

  const price = toAmount(req.body.price, 'price', { required: true });
  const cost = toAmount(req.body.cost, 'cost');
  if (cost > price) {
    // Not fatal -- loss leaders are real -- but the app should warn.
    res.set('X-Warning', 'cost exceeds price: this product sells at a loss');
  }

  // Validated before the product exists so a bad imageId cannot leave a
  // half-created product behind.
  const imageId = await claimImage(req.businessId, req.body.imageId, null);

  const name = String(req.body.name).trim();
  const unit = toUnit(req.body.unit);

  let product;
  try {
    product = await Product.create({
      businessId: req.businessId,
      categoryId: req.body.categoryId,
      name,
      price,
      cost,
      unit,
      stock: toQty(req.body.stock, 'stock', { fractional: allowsFraction(unit), unit }),
      imageId,
    });
  } catch (err) {
    throw asDuplicateNameError(err, name);
  }

  if (imageId) await claimImage(req.businessId, imageId, product._id);

  // Opening stock is a stock movement like any other. Without this row the
  // ledger starts mid-story and every later reconciliation is off by exactly
  // the amount the product was created with.
  if (product.stock > 0) {
    await recordMovement({
      businessId: req.businessId,
      productId: product._id,
      productName: product.name,
      before: 0,
      after: product.stock,
      reason: 'opening',
      note: toNote(req.body.note),
    });
  }

  res.status(201).json({ ok: true, product });
}

/** PATCH /api/products/:id */
export async function updateProduct(req, res) {
  assertObjectId(req.params.id);
  // Validated BEFORE the write, not at the moment the movement is recorded.
  // Doing it later meant a bad reason rejected the request with a 400 after the
  // stock had already moved -- the one outcome the ledger exists to prevent.
  const reason = toReason(req.body.reason, 'correction');
  const note = toNote(req.body.note);
  const update = {};

  if (req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body.categoryId !== undefined) {
    update.categoryId = await assertOwnCategory(req.businessId, req.body.categoryId);
  }
  if (req.body.price !== undefined) update.price = toAmount(req.body.price, 'price', { required: true });
  if (req.body.cost !== undefined) update.cost = toAmount(req.body.cost, 'cost');
  if (req.body.unit !== undefined) update.unit = toUnit(req.body.unit);

  // `imageId: null` clears the photo; a new id replaces it.
  // The same read also supplies the stock the product had BEFORE this edit,
  // which the movement log needs and findOneAndUpdate has already thrown away
  // by the time it returns.
  let previousImageId;
  let previousStock;
  let existing;
  if (req.body.imageId !== undefined || req.body.stock !== undefined || req.body.unit !== undefined) {
    existing = await Product.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!existing) throw ApiError.notFound('Product not found');
    previousImageId = existing.imageId;
    previousStock = existing.stock;
  }

  /**
   * Stock is parsed against the unit this edit LEAVES the product in, not the
   * one it started in. Switching soap from kg to pcs and correcting the count
   * in the same save is one action to the operator, and splitting it into two
   * requests that each fail on their own would be indefensible.
   */
  if (req.body.stock !== undefined) {
    const unit = update.unit ?? existing?.unit ?? DEFAULT_UNIT;
    update.stock = toQty(req.body.stock, 'stock', { fractional: allowsFraction(unit), unit });
  }
  /**
   * Moving a product to a countable unit while it holds a fraction would leave
   * it in a state the rest of the app has just been told is impossible -- 2.5
   * pcs on the shelf. Caught here, with the fix named, rather than allowed in
   * and rejected by every later operation.
   */
  if (update.unit !== undefined && !allowsFraction(update.unit)) {
    const resulting = update.stock ?? existing?.stock ?? 0;
    if (!Number.isInteger(resulting)) {
      throw ApiError.badRequest(
        `This product holds ${resulting}, which cannot be measured in ${update.unit}. Set a whole-number stock in the same save.`,
        { unit: 'conflicts with the current stock' }
      );
    }
  }

  if (req.body.imageId !== undefined) {
    update.imageId = await claimImage(req.businessId, req.body.imageId, req.params.id);
  }

  if (!Object.keys(update).length) throw ApiError.badRequest('Nothing to update');

  let product;
  try {
    product = await Product.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      update,
      { new: true, runValidators: true }
    );
  } catch (err) {
    /**
     * Renaming into a taken name, or MOVING a product into a category that
     * already has one by this name -- both land here.
     *
     * On a move there is no `name` in the patch, and saying 'that name' told
     * the operator nothing at the exact moment they needed to know WHICH name
     * clashed. Reorganising a catalogue means hitting this repeatedly, so the
     * message has to name the product; one extra read on a path that has
     * already failed is worth it.
     */
    let clashing = update.name;
    if (!clashing) {
      const existing = await Product.findOne({ _id: req.params.id, businessId: req.businessId })
        .select('name').lean().catch(() => null);
      clashing = existing?.name;
    }
    throw asDuplicateNameError(err, clashing ?? 'that name');
  }
  if (!product) throw ApiError.notFound('Product not found');

  // Retire the old photo only after the swap succeeded.
  if (previousImageId && String(previousImageId) !== String(product.imageId ?? '')) {
    await retireImage(req.businessId, previousImageId);
  }

  // Editing the stock field is a correction by default -- it is the form a
  // shopkeeper reaches for when the number on screen is simply wrong. Pass an
  // explicit reason to say something more useful ("damage", "restock").
  if (previousStock !== undefined && product.stock !== previousStock) {
    await recordMovement({
      businessId: req.businessId,
      productId: product._id,
      productName: product.name,
      before: previousStock,
      after: product.stock,
      reason,
      note,
    });
  }

  res.json({ ok: true, product });
}

/**
 * PATCH /api/products/:id/stock  { delta } or { set }
 * Atomic restock -- $inc avoids the read-modify-write race two staff phones
 * would otherwise hit.
 */
export async function adjustStock(req, res) {
  assertObjectId(req.params.id);
  const filter = { _id: req.params.id, businessId: req.businessId };
  // Same rule as updateProduct: reject a bad reason before the stock moves,
  // never after. The default differs per branch, so only validity is settled
  // here -- `toReason` is called again below with the right fallback.
  if (req.body.reason !== undefined) toReason(req.body.reason);
  const note = toNote(req.body.note);

  if (req.body.set !== undefined) {
    const before = await Product.findOne(filter).select('stock unit name').lean();
    if (!before) throw ApiError.notFound('Product not found');
    const product = await Product.findOneAndUpdate(
      filter,
      { stock: toQty(req.body.set, 'set', { fractional: allowsFraction(before.unit), unit: before.unit }) },
      { new: true, runValidators: true }
    );
    if (!product) throw ApiError.notFound('Product not found');
    await recordMovement({
      businessId: req.businessId,
      productId: product._id,
      productName: product.name,
      before: before.stock,
      after: product.stock,
      reason: toReason(req.body.reason, 'correction'),
      note,
    });
    return res.json({ ok: true, product });
  }

  /**
   * The unit has to be known before the delta can be judged, so this read is
   * not avoidable -- and it is the same read the 404 below would have needed.
   */
  const current = await Product.findOne(filter).select('stock unit name').lean();
  if (!current) throw ApiError.notFound('Product not found');

  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw ApiError.badRequest('Send a non-zero "delta", or "set" for an absolute value');
  }
  if (!allowsFraction(current.unit) && !Number.isInteger(delta)) {
    throw ApiError.badRequest(
      `"${current.name}" is sold in ${current.unit ?? DEFAULT_UNIT}, so the change must be a whole number`,
      { delta: 'must be a whole number for this unit' }
    );
  }

  // For a decrease, require enough stock in the same atomic operation.
  const guarded = delta < 0 ? { ...filter, stock: { $gte: -delta } } : filter;
  const product = await Product.findOneAndUpdate(guarded, { $inc: { stock: delta } }, { new: true });

  if (!product) {
    const exists = await Product.findOne(filter).lean();
    if (!exists) throw ApiError.notFound('Product not found');
    throw ApiError.conflict(`Only ${exists.stock} left in stock`, { available: exists.stock });
  }

  await recordMovement({
    businessId: req.businessId,
    productId: product._id,
    productName: product.name,
    before: product.stock - delta,
    after: product.stock,
    // Goods arriving is the overwhelmingly common reason to add stock by delta;
    // taking some away by delta is not restocking, so it falls back further.
    reason: toReason(req.body.reason, delta > 0 ? 'restock' : 'correction'),
    note,
  });

  res.json({ ok: true, product });
}

/**
 * DELETE /api/products/:id -- soft delete.
 * The row survives so historical order lines still resolve to a real product
 * (for grouping in reports), and a super admin can restore it.
 *
 * Its PHOTO does not survive, and that asymmetry is deliberate. The product row
 * is a few hundred bytes and earns its keep by making old receipts resolve; the
 * photo is ~60KB and earns nothing, because order lines snapshot the name and
 * price, never the picture. A business restore also would not bring it back:
 * restoreMany is scoped to rows the ARCHIVE deleted, so a product deleted
 * individually by the shop stays deleted and its image would sit there forever.
 *
 * Archiving a whole business still soft-deletes images, because that path is
 * built to be reversible -- see adminController.
 */
export async function deleteProduct(req, res) {
  assertObjectId(req.params.id);
  const product = await Product.softDeleteOne({ _id: req.params.id, businessId: req.businessId });
  if (!product) throw ApiError.notFound('Product not found');

  // After the product is gone, so a failure here cannot destroy a photo that
  // is still attached to a live product.
  await retireImage(req.businessId, product.imageId);

  res.json({ ok: true, deleted: { _id: product._id, name: product.name } });
}


/**
 * POST /api/products/stocktake  { counts: [{ productId, counted }], note? }
 *
 * A physical count, applied in one go.
 *
 * The counted figure always wins -- no `$gte` guard, no merge with what the
 * screen thought was there. That is the difference between a stocktake and an
 * adjustment: the shelf is the authority, and a count that refused to overwrite
 * the record because the record disagreed would be useless at the one moment it
 * is needed.
 *
 * Products whose count matches are skipped rather than written, so the ledger
 * holds discrepancies rather than a row per product per count.
 *
 * Applied one product at a time on purpose. A transaction would be tidier, but
 * a count of 200 products that fails atomically on the 199th throws away an
 * hour of walking the shelves; applying what succeeded and reporting the rest
 * is what the person holding the clipboard actually wants.
 */
export async function stocktake(req, res) {
  const counts = req.body?.counts;
  if (!Array.isArray(counts) || counts.length === 0) {
    throw ApiError.badRequest('Send a non-empty "counts" array of { productId, counted }');
  }
  if (counts.length > 1000) throw ApiError.badRequest('Count at most 1000 products at a time');

  const note = toNote(req.body?.note);
  const seen = new Set();
  const wanted = counts.map((row, i) => {
    const productId = assertObjectId(row?.productId, `counts[${i}].productId`);
    if (seen.has(productId)) {
      throw ApiError.badRequest(`counts[${i}] repeats a product already in this count`, {
        [`counts[${i}].productId`]: 'duplicated',
      });
    }
    seen.add(productId);
    return {
      productId,
      // Judged against the product's unit below, once the products are loaded.
      counted: toQty(row?.counted, `counts[${i}].counted`, { required: true }),
      field: `counts[${i}].counted`,
    };
  });

  const products = await Product.find({
    _id: { $in: wanted.map((w) => w.productId) },
    businessId: req.businessId,
  }).select('name stock cost unit').lean();

  const byId = new Map(products.map((p) => [String(p._id), p]));
  const missing = wanted.filter((w) => !byId.has(w.productId)).map((w) => w.productId);
  if (missing.length) {
    throw ApiError.badRequest('Some products in this count no longer exist', { missing });
  }

  // All-or-nothing, like every other check on a count: a fraction counted
  // against a countable unit rejects the whole request before anything moves.
  for (const w of wanted) {
    const p = byId.get(w.productId);
    if (!allowsFraction(p.unit) && !Number.isInteger(w.counted)) {
      throw ApiError.badRequest(
        `"${p.name}" is sold in ${p.unit ?? DEFAULT_UNIT}, so its count must be a whole number`,
        { [w.field]: 'must be a whole number for this unit' }
      );
    }
  }

  const applied = [];
  const unchanged = [];
  const failed = [];

  for (const { productId, counted } of wanted) {
    const p = byId.get(productId);
    if (p.stock === counted) {
      unchanged.push({ productId, name: p.name, stock: counted });
      continue;
    }
    try {
      const updated = await Product.findOneAndUpdate(
        { _id: productId, businessId: req.businessId },
        { stock: counted },
        { new: true, runValidators: true }
      );
      if (!updated) throw ApiError.notFound('Product not found');

      await recordMovement({
        businessId: req.businessId,
        productId: updated._id,
        productName: updated.name,
        before: p.stock,
        after: counted,
        reason: 'stocktake',
        note,
      });

      applied.push({
        productId,
        name: updated.name,
        recorded: p.stock,
        counted,
        variance: counted - p.stock,
        // Valued at COST, not selling price: a shelf that is three short has
        // lost what it cost to put them there, not what they might have sold
        // for. Margin that was never earned was never money.
        varianceValue: round2((counted - p.stock) * (p.cost ?? 0)),
      });
    } catch (err) {
      failed.push({ productId, name: p.name, error: err.message });
    }
  }

  const varianceValue = round2(applied.reduce((sum, a) => sum + a.varianceValue, 0));

  res.json({
    ok: true,
    counted: wanted.length,
    summary: {
      corrected: applied.length,
      unchanged: unchanged.length,
      failed: failed.length,
      unitsGained: applied.filter((a) => a.variance > 0).reduce((s, a) => s + a.variance, 0),
      unitsLost: applied.filter((a) => a.variance < 0).reduce((s, a) => s - a.variance, 0),
      varianceValue,
    },
    applied,
    unchanged,
    ...(failed.length ? { failed } : {}),
  });
}

/**
 * GET /api/products/:id/movements?limit=50
 *
 * One product's stock history: adjustments from the ledger, merged at read time
 * with the sales derived from the orders themselves (see StockMovement's note
 * on why sales are not written twice).
 *
 * Also returns a reconciliation, which is the number the shopkeeper is really
 * after: everything the ledger and the receipts can account for, and whatever
 * is left over that they cannot.
 */
export async function getMovements(req, res) {
  const productId = assertObjectId(req.params.id);
  const businessId = req.businessId;
  const limit = Math.min(Math.max(toCount(req.query.limit ?? 50, 'limit', { min: 1 }), 1), 200);

  const product = await Product.findOne({ _id: productId, businessId }).select('name stock').lean();
  if (!product) throw ApiError.notFound('Product not found');

  const oid = new mongoose.Types.ObjectId(productId);

  const [movements, sales, ledger, sold] = await Promise.all([
    StockMovement.find({ businessId, productId }).sort({ at: -1 }).limit(limit).lean(),

    // Soft-deleted (voided) orders are excluded by the plugin's middleware, so
    // a void removes its own line from the history exactly as it returns the
    // stock -- no compensating row required.
    Order.aggregate([
      { $match: { businessId, deletedAt: null, 'items.productId': oid } },
      { $unwind: '$items' },
      { $match: { 'items.productId': oid } },
      { $sort: { timestamp: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0, at: '$timestamp', orderNumber: 1,
          qty: '$items.qty', price: '$items.price', name: '$items.name',
        },
      },
    ]),

    StockMovement.aggregate([
      { $match: { businessId, productId: oid, deletedAt: null } },
      { $group: { _id: null, net: { $sum: '$delta' }, rows: { $sum: 1 } } },
    ]),

    Order.aggregate([
      { $match: { businessId, deletedAt: null, 'items.productId': oid } },
      { $unwind: '$items' },
      { $match: { 'items.productId': oid } },
      { $group: { _id: null, qty: { $sum: '$items.qty' } } },
    ]),
  ]);

  const netAdjusted = ledger[0]?.net ?? 0;
  const totalSold = sold[0]?.qty ?? 0;
  const expected = netAdjusted - totalSold;

  const timeline = [
    ...movements.map((m) => ({
      type: 'adjustment',
      at: m.at,
      delta: m.delta,
      before: m.before,
      after: m.after,
      reason: m.reason,
      note: m.note || '',
    })),
    ...sales.map((s) => ({
      type: 'sale',
      at: s.at,
      delta: -s.qty,
      orderNumber: s.orderNumber,
      receiptNo: `INV-${String(s.orderNumber ?? 0).padStart(6, '0')}`,
      price: s.price,
    })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);

  res.json({
    ok: true,
    product: { _id: product._id, name: product.name, stock: product.stock },
    timeline,
    reconciliation: {
      currentStock: product.stock,
      netAdjusted,
      totalSold,
      expected,
      /**
       * What the ledger cannot account for.
       *
       * Non-zero is normal for any product that existed before the ledger did
       * -- there is no opening row for it. `npm run db:backfill` writes those.
       * Non-zero AFTER a backfill means stock moved without going through the
       * app at all, which is exactly the thing worth knowing.
       */
      unexplained: product.stock - expected,
      ledgerRows: ledger[0]?.rows ?? 0,
    },
  });
}
