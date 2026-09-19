import mongoose from 'mongoose';
import {
  Business, Category, Product, Order, Counter, ProductImage, StockMovement, Expense,
  Customer, Payment, Return,
} from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * A backup you can actually restore from.
 *
 * Atlas's free tier takes no automated backups, so until this existed the shop's
 * entire history had exactly one copy. The report export was not a substitute:
 * it is a flattened summary for reading, and nothing can be rebuilt from it.
 *
 * WHAT MAKES THIS A BACKUP RATHER THAN A DUMP
 * -------------------------------------------
 * The reference graph survives. Order lines point at products by ObjectId,
 * movements point at products, images point at products, products point at
 * categories and at an image -- a restore that got any of that wrong would put
 * back a shop whose receipts resolve to nothing, and it would look like it had
 * worked.
 *
 * Ids are REGENERATED on the way in and every reference re-pointed to match.
 * Keeping the originals was the obvious first instinct and it is wrong: `_id`
 * is unique per collection, not per shop, so a backup could then only be
 * restored into a database that did not already contain it. That rules out the
 * two things people actually do -- restoring a copy alongside the original to
 * check it, and restoring the same file into a second shop -- and it fails with
 * a duplicate-key error rather than anything a shopkeeper could act on.
 *
 * `businessId` is rewritten the same way, to whichever shop is restoring. That
 * is what lets a backup come back into a fresh account after the old one is
 * lost, and it means a backup can never smuggle rows into a tenant that did not
 * ask for them.
 *
 * The order counter travels too. Without it the first sale after a restore
 * would be handed receipt number 1 again and collide with the unique index on
 * (businessId, orderNumber) -- a restore that looks fine until the shop tries
 * to sell something.
 *
 * Deleted rows travel as well, flags intact. A backup that silently dropped
 * them would turn a reversible deletion into a permanent one.
 */
export const BACKUP_VERSION = 1;

const COLLECTIONS = ['categories', 'products', 'orders', 'expenses', 'movements', 'customers', 'payments'];

/**
 * Plain JSON.stringify would quietly destroy this backup.
 *
 * An ObjectId becomes a 24-character string, and inserting that string back
 * makes every reference dangle -- order lines pointing at products, movements
 * pointing at products, images pointing at products. A Date becomes an ISO
 * string, and a date-range report comparing a string against a Date silently
 * matches nothing, so a restored shop would show no sales in any period.
 *
 * MongoDB's Extended JSON is still ordinary JSON -- it survives a file, a chat
 * app, a text editor -- but it tags those values ({"$oid":...}, {"$date":...})
 * so they come back as what they were.
 */
const { EJSON } = mongoose.mongo.BSON;

/**
 * Image bytes are handled by hand rather than left to EJSON.
 *
 * `.lean()` hands back a Node Buffer, which Extended JSON does not recognise as
 * binary -- it serialises as {"0":255,"1":216,...}, one JSON key per byte. A
 * 60KB photo becomes roughly 600KB of digits and comes back as an object rather
 * than a Buffer, so the photo is both enormous and broken. Base64 is smaller
 * than the original hex-per-byte form and unambiguous on the way back.
 */
/**
 * `.lean()` does not always hand back a Node Buffer.
 *
 * Mongoose skips its own casting on a lean read, so what arrives is whatever
 * the driver produced -- a BSON Binary, whose bytes live on `.buffer`. Calling
 * Buffer.from() on that object does not throw and does not warn: it returns an
 * EMPTY buffer. The backup then contains a photo-shaped row whose data is the
 * empty string, the export looks fine, and the failure only shows up much later
 * as an image that will not render. imageController has the same helper for the
 * same reason.
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value.buffer)) return value.buffer;          // BSON Binary
  if (typeof value.value === 'function') return Buffer.from(value.value(true));
  return Buffer.from(value);
}

const packImages = (rows) => (rows ?? []).map(({ data, ...rest }) => ({
  ...rest,
  data: data ? toBuffer(data).toString('base64') : null,
  dataEncoding: 'base64',
}));

const unpackImages = (rows) => (rows ?? []).map(({ dataEncoding, data, ...rest }) => ({
  ...rest,
  data: typeof data === 'string' ? Buffer.from(data, 'base64') : data,
}));

/**
 * GET /api/backup/export?images=1
 *
 * Photos are opt-in. They are ~60KB each and dwarf everything else -- a shop
 * with 500 of them turns a 400KB backup into a 30MB one, which on a phone is
 * the difference between a file that shares over WhatsApp and one that does
 * not. The catalogue, the sales and the money are what cannot be reconstructed
 * by hand; a photo can be retaken.
 */
export async function exportBackup(req, res) {
  const businessId = req.businessId;
  const withImages = req.query.images === '1' || req.query.images === 'true';

  const business = await Business.findOne({ businessId }).lean();
  if (!business) throw ApiError.notFound('Business not found');

  const scope = { businessId };
  const all = (Model) => Model.find(scope).withDeleted().lean();

  const [categories, products, orders, expenses, movements, customers, payments, returns,
    counter, returnCounter] = await Promise.all([
    all(Category), all(Product), all(Order), all(Expense), all(StockMovement),
    all(Customer), all(Payment), all(Return),
    Counter.findById(`${businessId}:order`).lean(),
    Counter.findById(`${businessId}:return`).lean(),
  ]);

  const images = withImages ? await ProductImage.find(scope).withDeleted().lean() : [];

  // Never in a backup: the PIN hash. A backup file gets emailed to itself,
  // dropped in a shared folder, left on a laptop -- it is the least protected
  // copy of the shop that exists, and a bcrypt hash sitting in it is an offline
  // cracking target for no benefit. Restoring asks for a PIN instead.
  const payload = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    business: { name: business.name, createdAt: business.createdAt },
    counters: { order: counter?.seq ?? 0, return: returnCounter?.seq ?? 0 },
    includesImages: withImages,
    counts: {
      categories: categories.length,
      products: products.length,
      orders: orders.length,
      expenses: expenses.length,
      movements: movements.length,
      customers: customers.length,
      payments: payments.length,
      returns: returns.length,
      images: images.length,
    },
    data: {
      categories, products, orders, expenses, movements, customers, payments, returns,
      images: packImages(images),
    },
  };

  const stamp = payload.exportedAt.slice(0, 10);
  const safeName = String(business.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'shop';
  res.set('Content-Disposition', `attachment; filename="vyapaar-${safeName}-${stamp}.json"`);
  res.json({ ok: true, backup: EJSON.serialize(payload, { relaxed: true }) });
}

/**
 * Gives every row a fresh _id, remembering the old one so references can be
 * re-pointed. Also rewrites the tenant key and drops Mongo's bookkeeping field.
 */
function reseat(rows, businessId, idMap) {
  return (rows ?? []).map((row) => {
    const { __v, _id, ...rest } = row;
    const fresh = new mongoose.Types.ObjectId();
    if (_id != null) idMap.set(String(_id), fresh);
    return { ...rest, _id: fresh, businessId };
  });
}

/** Follows a reference through the remap, leaving danglers exactly as dangling. */
const remap = (idMap, value) => (value == null ? value : idMap.get(String(value)) ?? value);

function assertShape(backup) {
  if (!backup || typeof backup !== 'object') {
    throw ApiError.badRequest('Send the backup file contents as "backup"');
  }
  if (backup.version !== BACKUP_VERSION) {
    throw ApiError.badRequest(
      `This backup was written by a different version of the app (file: ${backup.version ?? 'unknown'}, expected: ${BACKUP_VERSION})`,
      { version: 'unsupported' }
    );
  }
  if (!backup.data || typeof backup.data !== 'object') {
    throw ApiError.badRequest('That file has no data in it', { data: 'missing' });
  }
  for (const key of COLLECTIONS) {
    const rows = backup.data[key === 'movements' ? 'movements' : key];
    if (rows !== undefined && !Array.isArray(rows)) {
      throw ApiError.badRequest(`"${key}" in that file is not a list`, { [key]: 'malformed' });
    }
  }
  /**
   * The counts block is a checksum, and it is checked rather than displayed.
   * A JSON file that has been truncated by a failed download or clipped by a
   * chat app still parses -- it just has fewer rows. Restoring it would look
   * like a success and quietly lose the tail of the shop's history.
   */
  const { counts, data } = backup;
  if (counts && typeof counts === 'object') {
    const actual = {
      categories: data.categories?.length ?? 0,
      products: data.products?.length ?? 0,
      orders: data.orders?.length ?? 0,
      expenses: data.expenses?.length ?? 0,
      movements: data.movements?.length ?? 0,
      customers: data.customers?.length ?? 0,
      payments: data.payments?.length ?? 0,
    };
    for (const [key, expected] of Object.entries(counts)) {
      if (key === 'images') continue; // images are optional in the file
      if (typeof expected === 'number' && actual[key] !== undefined && actual[key] !== expected) {
        throw ApiError.badRequest(
          `That file looks incomplete: it says it holds ${expected} ${key} but contains ${actual[key]}`,
          { [key]: 'count mismatch' }
        );
      }
    }
  }
}

/**
 * POST /api/backup/restore  { backup, mode }
 *
 *   mode "empty"   (default) refuses unless the shop holds nothing
 *   mode "replace"           wipes this shop first, then restores
 *
 * There is no merge mode, and that is deliberate. Merging two versions of the
 * same shop means deciding, per row, which of two edits wins -- a judgement no
 * script can make on a shopkeeper's behalf, and the failure mode is a catalogue
 * full of near-duplicates that is worse than either input. Restore means "make
 * this shop be the backup".
 */
export async function restoreBackup(req, res) {
  const businessId = req.businessId;
  const backup = req.body?.backup;
  const mode = String(req.body?.mode ?? 'empty').toLowerCase();

  if (!['empty', 'replace'].includes(mode)) {
    throw ApiError.badRequest('mode must be "empty" or "replace"', { mode: 'unsupported' });
  }
  assertShape(backup);
  // Revive the ObjectIds and Dates the file carries as tagged values, then the
  // photo bytes, which are base64 rather than Extended JSON binary.
  const revived = EJSON.deserialize(backup, { relaxed: true });
  revived.data.images = unpackImages(revived.data.images);

  const existing = {
    categories: await Category.countDocuments({ businessId }).withDeleted(),
    products: await Product.countDocuments({ businessId }).withDeleted(),
    orders: await Order.countDocuments({ businessId }).withDeleted(),
    expenses: await Expense.countDocuments({ businessId }).withDeleted(),
    customers: await Customer.countDocuments({ businessId }).withDeleted(),
  };
  const occupied = Object.values(existing).some((n) => n > 0);

  if (occupied && mode !== 'replace') {
    throw ApiError.conflict(
      'This shop already has data. Restoring would replace it — send mode "replace" to confirm.',
      { existing }
    );
  }

  const { data } = revived;

  // Wipe first, hard. A soft delete would leave the old rows colliding with the
  // restored ones on every unique index, and there is nothing to preserve: the
  // operator has just said this shop should become the backup.
  if (occupied) {
    await Order.hardDeleteMany({ businessId });
    await StockMovement.hardDeleteMany({ businessId });
    await Expense.hardDeleteMany({ businessId });
    await Product.hardDeleteMany({ businessId });
    await Category.hardDeleteMany({ businessId });
    await ProductImage.hardDeleteMany({ businessId });
    await Payment.hardDeleteMany({ businessId });
    await Customer.hardDeleteMany({ businessId });
  }

  const written = {};
  const ids = new Map();
  const insert = async (Model, rows, key, fixUp) => {
    const docs = reseat(rows, businessId, ids);
    if (fixUp) docs.forEach(fixUp);
    if (!docs.length) { written[key] = 0; return; }
    // Written through the driver, not the model: these rows have already been
    // validated once, on their way IN. Re-running setters would re-normalise
    // names and re-round money, and a backup that comes back subtly different
    // from what went in is not a backup.
    const result = await Model.collection.insertMany(docs, { ordered: false });
    written[key] = result.insertedCount ?? docs.length;
  };

  try {
    /**
     * Order matters: a row can only be re-pointed at something already remapped.
     * Categories first, then products (which reference them), then everything
     * that references a product.
     *
     * Images are the awkward one -- a product points at its image and the image
     * points back at its product -- so the images go in last with their
     * productId fixed, and the products' imageId is patched afterwards, once
     * both halves of the pair have ids.
     */
    await insert(Category, data.categories, 'categories');
    await insert(Product, data.products, 'products', (p) => {
      p.categoryId = remap(ids, p.categoryId);
    });
    // Customers before orders and payments, both of which point at them. A
    // restore that lost this link would put back a shop where the sales exist
    // and nobody owes anything -- the ledger silently zeroed.
    await insert(Customer, data.customers, 'customers');
    await insert(Order, data.orders, 'orders', (o) => {
      o.customerId = remap(ids, o.customerId);
      for (const line of o.items ?? []) line.productId = remap(ids, line.productId);
    });
    await insert(Payment, data.payments, 'payments', (p) => {
      p.customerId = remap(ids, p.customerId);
    });
    /* After orders and products, both of which a credit note points at. A
       return whose orderId still named the source shop's receipt would be a
       refund hanging off somebody else's sale. */
    await insert(Return, data.returns, 'returns', (r) => {
      r.orderId = remap(ids, r.orderId);
      r.customerId = remap(ids, r.customerId);
      for (const line of r.lines ?? []) line.productId = remap(ids, line.productId);
    });
    await insert(Expense, data.expenses, 'expenses');
    await insert(StockMovement, data.movements, 'movements', (m) => {
      m.productId = remap(ids, m.productId);
    });

    const imageIdByOld = new Map();
    await insert(ProductImage, data.images, 'images', (img) => {
      img.productId = remap(ids, img.productId);
    });
    for (const img of data.images ?? []) {
      if (img._id != null) imageIdByOld.set(String(img._id), ids.get(String(img._id)));
    }
    // The back-reference, now that both sides exist.
    for (const p of data.products ?? []) {
      if (p.imageId == null) continue;
      const productId = ids.get(String(p._id));
      const imageId = imageIdByOld.get(String(p.imageId));
      await Product.collection.updateOne(
        { _id: productId },
        imageId ? { $set: { imageId } } : { $set: { imageId: null } }
      );
    }
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict(
        'That backup contains rows this shop already has. Restore into an empty shop, or use mode "replace".',
        { hint: 'duplicate key' }
      );
    }
    throw err;
  }

  /**
   * The counter is set to the greater of the file's value and the highest
   * receipt number actually restored. They agree in a healthy backup; when they
   * do not, trusting the lower one would hand out a receipt number that already
   * exists and break the next sale.
   */
  const highest = (data.orders ?? []).reduce((max, o) => Math.max(max, Number(o.orderNumber) || 0), 0);
  const seq = Math.max(Number(revived.counters?.order) || 0, highest);
  await Counter.updateOne({ _id: `${businessId}:order` }, { $set: { seq } }, { upsert: true });

  // Credit notes have their own sequence, and the same trap: a duplicate
  // CN number would refuse the next return outright.
  const highestReturn = (data.returns ?? [])
    .reduce((max, r) => Math.max(max, Number(r.returnNumber) || 0), 0);
  const returnSeq = Math.max(Number(revived.counters?.return) || 0, highestReturn);
  await Counter.updateOne({ _id: `${businessId}:return` }, { $set: { seq: returnSeq } }, { upsert: true });

  res.json({
    ok: true,
    mode,
    replaced: occupied,
    restored: written,
    nextReceiptNumber: seq + 1,
    exportedAt: backup.exportedAt ?? null,
  });
}

/** GET /api/backup/status — what a backup would contain, without building one. */
export async function backupStatus(req, res) {
  const businessId = req.businessId;
  const scope = { businessId };

  const [categories, products, orders, expenses, movements, images, customers, payments, returns] = await Promise.all([
    Category.countDocuments(scope).withDeleted(),
    Product.countDocuments(scope).withDeleted(),
    Order.countDocuments(scope).withDeleted(),
    Expense.countDocuments(scope).withDeleted(),
    StockMovement.countDocuments(scope).withDeleted(),
    ProductImage.countDocuments(scope).withDeleted(),
    Customer.countDocuments(scope).withDeleted(),
    Payment.countDocuments(scope).withDeleted(),
    Return.countDocuments(scope).withDeleted(),
  ]);

  // Rough, and honest about it: enough to warn that including photos turns a
  // small file into a large one, not a promise about the exact byte count.
  const imageBytes = await ProductImage.aggregate([
    { $match: { businessId } },
    { $group: { _id: null, bytes: { $sum: '$bytes' } } },
  ], { withDeleted: true });

  res.json({
    ok: true,
    counts: { categories, products, orders, expenses, movements, images, customers, payments, returns },
    approxImageBytes: imageBytes[0]?.bytes ?? 0,
    version: BACKUP_VERSION,
  });
}

export default { exportBackup, restoreBackup, backupStatus };
