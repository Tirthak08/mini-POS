import mongoose from 'mongoose';
import { Business, Category, Product, Order, Counter, ProductImage, toSlug } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { round2 } from '../utils/validators.js';
import { isTransactionUnsupported } from '../utils/txnSupport.js';

const asBool = (v) => String(v).toLowerCase() === 'true';

/**
 * Splits a collection's rows into live vs archived in ONE server-side group,
 * instead of shipping every row to Node just to count it.
 */
const statsLookup = (collectionName, as, extra = {}) => ({
  $lookup: {
    from: collectionName,
    localField: 'businessId',
    foreignField: 'businessId',
    pipeline: [
      {
        $group: {
          _id: { $cond: [{ $eq: ['$deletedAt', null] }, 'live', 'archived'] },
          count: { $sum: 1 },
          ...extra,
        },
      },
    ],
    as,
  },
});

/** Turns [{_id:'live',count:3},{_id:'archived',count:1}] into {live:{...},archived:{...}}. */
const split = (rows = []) => ({
  live: rows.find((r) => r._id === 'live') ?? { count: 0 },
  archived: rows.find((r) => r._id === 'archived') ?? { count: 0 },
});

/**
 * GET /api/admin/businesses?includeDeleted=true
 * PRD 4: the admin dashboard bypasses the POS UI and lists every tenant.
 * Archived counts are reported too, so the decision to restore or purge is
 * informed rather than blind.
 */
export async function listBusinesses(req, res) {
  const includeDeleted = asBool(req.query.includeDeleted);

  const rows = await Business.aggregate(
    [
      ...(includeDeleted ? [] : [{ $match: { deletedAt: null } }]),
      { $sort: { createdAt: -1 } },
      statsLookup(Category.collection.name, 'catStats'),
      statsLookup(Product.collection.name, 'prodStats', { stock: { $sum: '$stock' } }),
      statsLookup(Order.collection.name, 'orderStats', {
        revenue: { $sum: '$grandTotal' },
        last: { $max: '$timestamp' },
      }),
      {
        $project: {
          _id: 0,
          businessId: 1, name: 1, createdAt: 1, deletedAt: 1, deletedBy: 1,
          catStats: 1, prodStats: 1, orderStats: 1,
          // `pin` and `slug` are simply not listed -- an inclusion projection omits them
        },
      },
    ],
    { withDeleted: true } // the $match above decides; the plugin must not also filter
  );

  const businesses = rows.map((b) => {
    const cats = split(b.catStats);
    const prods = split(b.prodStats);
    const orders = split(b.orderStats);
    return {
      businessId: b.businessId,
      name: b.name,
      createdAt: b.createdAt,
      deletedAt: b.deletedAt ?? null,
      deletedBy: b.deletedBy ?? null,
      isDeleted: b.deletedAt != null,
      categories: cats.live.count,
      products: prods.live.count,
      stockUnits: prods.live.stock ?? 0,
      orders: orders.live.count,
      revenue: round2(orders.live.revenue ?? 0),
      lastActivity: orders.live.last ?? null,
      archived: {
        categories: cats.archived.count,
        products: prods.archived.count,
        orders: orders.archived.count,
        revenue: round2(orders.archived.revenue ?? 0),
      },
    };
  });

  res.json({ ok: true, count: businesses.length, includeDeleted, businesses });
}

/** GET /api/admin/businesses/:businessId -- drill-down before deleting. */
export async function getBusiness(req, res) {
  const { businessId } = req.params;
  const business = await Business.findOne({ businessId }).withDeleted().lean();
  if (!business) throw ApiError.notFound('Business not found');

  const scope = { businessId };
  const [categories, products, orders, archivedOrders, recent] = await Promise.all([
    Category.countDocuments(scope),
    Product.countDocuments(scope),
    Order.countDocuments(scope),
    Order.countDocuments(scope).onlyDeleted(),
    Order.find(scope).sort({ timestamp: -1 }).limit(5).lean(),
  ]);

  res.json({
    ok: true,
    business: {
      businessId: business.businessId,
      name: business.name,
      createdAt: business.createdAt,
      deletedAt: business.deletedAt ?? null,
      isDeleted: business.deletedAt != null,
    },
    counts: { categories, products, orders, archivedOrders },
    recentOrders: recent.map((o) => ({
      _id: o._id,
      orderNumber: o.orderNumber,
      receiptNo: `INV-${String(o.orderNumber ?? 0).padStart(6, '0')}`,
      customerName: o.customerName,
      grandTotal: o.grandTotal,
      timestamp: o.timestamp,
    })),
  });
}

/** Runs `work` inside a transaction where the deployment supports one. */
async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    return work(null); // standalone mongod
  } finally {
    await session.endSession();
  }
}

/**
 * DELETE /api/admin/businesses/:businessId
 * PRD 4: cascading delete of every associated item, category and order --
 * now a cascading SOFT delete, so it is fully reversible.
 */
export async function deleteBusiness(req, res) {
  const { businessId } = req.params;
  const business = await Business.findOne({ businessId });
  if (!business) throw ApiError.notFound('Business not found (or already deleted)');

  const by = `admin:${req.adminUser}`;
  const deleted = await inTransaction(async (session) => {
    // Sequential, NOT Promise.all: a MongoDB session allows only one operation
    // in flight at a time, so parallel writes inside a transaction fail.
    const orders = await Order.softDeleteMany({ businessId }, { by, session });
    const products = await Product.softDeleteMany({ businessId }, { by, session });
    const categories = await Category.softDeleteMany({ businessId }, { by, session });
    const images = await ProductImage.softDeleteMany({ businessId }, { by, session });
    await Business.softDeleteMany({ businessId }, { by, session });
    return {
      orders: orders.modifiedCount || 0,
      products: products.modifiedCount || 0,
      categories: categories.modifiedCount || 0,
      images: images.modifiedCount || 0,
      business: 1,
    };
  });

  console.warn(`[admin:${req.adminUser}] soft-deleted business ${businessId}`, deleted);
  res.json({
    ok: true,
    message: `Archived "${business.name}" and all its data. It can be restored.`,
    deleted,
    restorable: true,
  });
}

/**
 * POST /api/admin/businesses/:businessId/restore   { name? }
 * Undoes the cascade.
 *
 * The tricky part: while a shop was archived, someone else may have registered
 * its name -- the name is only reserved among LIVE shops, which is what makes
 * reuse possible in the first place. Restoring would then violate the unique
 * slug index, so the restored shop is renamed rather than refused. Its
 * businessId never changes, so none of its data has to move.
 */
export async function restoreBusiness(req, res) {
  const { businessId } = req.params;
  const business = await Business.findOne({ businessId }).withDeleted();
  if (!business) throw ApiError.notFound('Business not found');
  if (business.deletedAt == null) throw ApiError.conflict('That business is not deleted');

  const requestedName = req.body?.name ? String(req.body.name).trim() : null;
  let name = requestedName || business.name;
  let renamedFrom = null;

  const taken = async (candidate) => {
    const clash = await Business.findOne({ slug: toSlug(candidate) }); // live only
    return Boolean(clash) && clash.businessId !== businessId;
  };

  if (await taken(name)) {
    if (requestedName) {
      throw ApiError.conflict('Another live business already uses that name', { name: 'taken' });
    }
    // Pick the first free "(restored)" variant instead of failing the restore.
    let candidate = `${business.name} (restored)`;
    for (let n = 2; n <= 50 && (await taken(candidate)); n += 1) {
      candidate = `${business.name} (restored ${n})`;
    }
    if (await taken(candidate)) {
      throw ApiError.conflict('Could not find a free name for the restored business; pass { name } explicitly');
    }
    renamedFrom = business.name;
    name = candidate;
  }

  // Only rows the admin cascade archived come back. A category the OWNER deleted
  // earlier stays deleted -- restoring a shop must not resurrect their own
  // deliberate cleanup.
  const by = `admin:${req.adminUser}`;
  const restored = await inTransaction(async (session) => {
    const orders = await Order.restoreMany({ businessId, deletedBy: by }, { session });
    const products = await Product.restoreMany({ businessId, deletedBy: by }, { session });
    const categories = await Category.restoreMany({ businessId, deletedBy: by }, { session });
    await ProductImage.restoreMany({ businessId, deletedBy: by }, { session });
    await Business.updateOne(
      { businessId },
      { deletedAt: null, deletedBy: null, name, slug: toSlug(name) },
      { withDeleted: true, runValidators: true, ...(session && { session }) }
    );
    return {
      orders: orders.modifiedCount || 0,
      products: products.modifiedCount || 0,
      categories: categories.modifiedCount || 0,
      business: 1,
    };
  });

  console.warn(`[admin:${req.adminUser}] restored business ${businessId}`, restored);
  res.json({
    ok: true,
    message: renamedFrom
      ? `Restored as "${name}" — "${renamedFrom}" was taken by another business`
      : `Restored "${name}"`,
    business: { businessId, name },
    ...(renamedFrom && { renamedFrom }),
    restored,
  });
}

/**
 * DELETE /api/admin/businesses/:businessId/purge
 * Permanent removal, for a genuine erasure request. Requires the business to be
 * archived first, so a single mistaken tap can never destroy live data.
 */
export async function purgeBusiness(req, res) {
  const { businessId } = req.params;
  const business = await Business.findOne({ businessId }).withDeleted();
  if (!business) throw ApiError.notFound('Business not found');
  if (business.deletedAt == null) {
    throw ApiError.conflict('Archive the business first, then purge it', {
      hint: 'DELETE /api/admin/businesses/:businessId before purging',
    });
  }

  const purged = await inTransaction(async (session) => {
    const orders = await Order.hardDeleteMany({ businessId }, { session });
    const products = await Product.hardDeleteMany({ businessId }, { session });
    const categories = await Category.hardDeleteMany({ businessId }, { session });
    // Image bytes are the only rows with real storage cost -- always reclaim them.
    const images = await ProductImage.hardDeleteMany({ businessId }, { session });
    await Business.deleteMany({ businessId }, { withDeleted: true, ...(session && { session }) });
    await Counter.deleteMany({ _id: `${businessId}:order` }, { ...(session && { session }) });
    return {
      orders: orders.deletedCount || 0,
      products: products.deletedCount || 0,
      categories: categories.deletedCount || 0,
      images: images.deletedCount || 0,
      business: 1,
    };
  });

  console.warn(`[admin:${req.adminUser}] PURGED business ${businessId}`, purged);
  res.json({ ok: true, message: `Permanently deleted "${business.name}"`, purged, restorable: false });
}

/** GET /api/admin/stats -- platform-wide totals for the admin header. */
export async function platformStats(_req, res) {
  const [businesses, archivedBusinesses, products, orderAgg] = await Promise.all([
    Business.countDocuments({}),
    Business.countDocuments({}).onlyDeleted(),
    Product.countDocuments({}),
    Order.aggregate([{ $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } }]),
  ]);

  res.json({
    ok: true,
    stats: {
      businesses,
      archivedBusinesses,
      products,
      orders: orderAgg[0]?.orders || 0,
      grossRevenue: round2(orderAgg[0]?.revenue || 0),
    },
  });
}
