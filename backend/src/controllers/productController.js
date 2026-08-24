import { Category, Product, ProductImage } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { requireFields, assertObjectId, toAmount, toCount } from '../utils/validators.js';

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

/** Replacing or clearing a photo retires the old row rather than orphaning it. */
async function retireImage(businessId, imageId) {
  if (!imageId) return;
  await ProductImage.softDeleteOne({ _id: imageId, businessId });
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

  const product = await Product.create({
    businessId: req.businessId,
    categoryId: req.body.categoryId,
    name: String(req.body.name).trim(),
    price,
    cost,
    stock: toCount(req.body.stock, 'stock'),
    imageId,
  });

  if (imageId) await claimImage(req.businessId, imageId, product._id);

  res.status(201).json({ ok: true, product });
}

/** PATCH /api/products/:id */
export async function updateProduct(req, res) {
  assertObjectId(req.params.id);
  const update = {};

  if (req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body.categoryId !== undefined) {
    update.categoryId = await assertOwnCategory(req.businessId, req.body.categoryId);
  }
  if (req.body.price !== undefined) update.price = toAmount(req.body.price, 'price', { required: true });
  if (req.body.cost !== undefined) update.cost = toAmount(req.body.cost, 'cost');
  if (req.body.stock !== undefined) update.stock = toCount(req.body.stock, 'stock');

  // `imageId: null` clears the photo; a new id replaces it.
  let previousImageId;
  if (req.body.imageId !== undefined) {
    const existing = await Product.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!existing) throw ApiError.notFound('Product not found');
    previousImageId = existing.imageId;
    update.imageId = await claimImage(req.businessId, req.body.imageId, req.params.id);
  }

  if (!Object.keys(update).length) throw ApiError.badRequest('Nothing to update');

  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, businessId: req.businessId },
    update,
    { new: true, runValidators: true }
  );
  if (!product) throw ApiError.notFound('Product not found');

  // Retire the old photo only after the swap succeeded.
  if (previousImageId && String(previousImageId) !== String(product.imageId ?? '')) {
    await retireImage(req.businessId, previousImageId);
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

  if (req.body.set !== undefined) {
    const product = await Product.findOneAndUpdate(
      filter,
      { stock: toCount(req.body.set, 'set') },
      { new: true, runValidators: true }
    );
    if (!product) throw ApiError.notFound('Product not found');
    return res.json({ ok: true, product });
  }

  const delta = Number(req.body.delta);
  if (!Number.isInteger(delta) || delta === 0) {
    throw ApiError.badRequest('Send a non-zero whole-number "delta", or "set" for an absolute value');
  }

  // For a decrease, require enough stock in the same atomic operation.
  const guarded = delta < 0 ? { ...filter, stock: { $gte: -delta } } : filter;
  const product = await Product.findOneAndUpdate(guarded, { $inc: { stock: delta } }, { new: true });

  if (!product) {
    const exists = await Product.findOne(filter).lean();
    if (!exists) throw ApiError.notFound('Product not found');
    throw ApiError.conflict(`Only ${exists.stock} left in stock`, { available: exists.stock });
  }
  res.json({ ok: true, product });
}

/**
 * DELETE /api/products/:id -- soft delete.
 * The row survives so historical order lines still resolve to a real product
 * (for grouping in reports), and a super admin can restore it.
 */
export async function deleteProduct(req, res) {
  assertObjectId(req.params.id);
  const product = await Product.softDeleteOne({ _id: req.params.id, businessId: req.businessId });
  if (!product) throw ApiError.notFound('Product not found');
  res.json({ ok: true, deleted: { _id: product._id, name: product.name } });
}
