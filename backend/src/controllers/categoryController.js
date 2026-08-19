import { Category, Product } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { requireFields, assertObjectId } from '../utils/validators.js';

/** GET /api/categories */
export async function listCategories(req, res) {
  const categories = await Category.find({ businessId: req.businessId })
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: 1 })
    .lean();

  // Product count per category, for the inventory screen badges.
  const counts = await Product.aggregate([
    { $match: { businessId: req.businessId } },
    { $group: { _id: '$categoryId', count: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((c) => [String(c._id), c.count]));

  res.json({
    ok: true,
    categories: categories.map((c) => ({ ...c, productCount: map.get(String(c._id)) || 0 })),
  });
}

/** POST /api/categories  { name, color? } */
export async function createCategory(req, res) {
  requireFields(req.body, ['name']);
  try {
    const category = await Category.create({
      businessId: req.businessId, // from the token, never the body
      name: String(req.body.name).trim(),
      ...(req.body.color && { color: String(req.body.color).trim().toUpperCase() }),
    });
    res.status(201).json({ ok: true, category });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(`You already have a category called "${req.body.name}"`);
    throw err;
  }
}

/** PATCH /api/categories/:id  { name?, color? } */
export async function updateCategory(req, res) {
  assertObjectId(req.params.id);
  const update = {};
  if (req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body.color !== undefined) update.color = String(req.body.color).trim().toUpperCase();
  if (!Object.keys(update).length) throw ApiError.badRequest('Nothing to update -- send name and/or color');

  try {
    // businessId in the filter is what stops tenant A editing tenant B's row.
    const category = await Category.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      update,
      { new: true, runValidators: true }
    );
    if (!category) throw ApiError.notFound('Category not found');
    res.json({ ok: true, category });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(`You already have a category called "${update.name}"`);
    throw err;
  }
}

/**
 * DELETE /api/categories/:id[?force=true]
 * Refuses by default if products still reference it, so a mis-tap cannot
 * silently orphan the catalogue. ?force=true deletes those products too.
 */
export async function deleteCategory(req, res) {
  assertObjectId(req.params.id);
  const filter = { _id: req.params.id, businessId: req.businessId };

  const category = await Category.findOne(filter);
  if (!category) throw ApiError.notFound('Category not found');

  // Only LIVE products block the delete; already-deleted ones are irrelevant.
  const productCount = await Product.countDocuments({
    businessId: req.businessId,
    categoryId: category._id,
  });

  const force = String(req.query.force).toLowerCase() === 'true';
  if (productCount > 0 && !force) {
    throw ApiError.conflict(
      `"${category.name}" still has ${productCount} product${productCount > 1 ? 's' : ''}. Move or delete them first, or confirm deleting them too.`,
      { productCount, hint: 'retry with ?force=true' }
    );
  }

  let deletedProducts = 0;
  if (force && productCount > 0) {
    const r = await Product.softDeleteMany({ businessId: req.businessId, categoryId: category._id });
    deletedProducts = r.modifiedCount || 0;
  }
  await Category.softDeleteOne(filter);

  // Soft delete: the row keeps its deletedAt stamp, so past orders stay
  // referentially intact and a super admin can restore the whole shop.
  res.json({ ok: true, deleted: { category: category.name, products: deletedProducts } });
}
