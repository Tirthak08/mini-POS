import { ProductImage, Product, MAX_IMAGE_BYTES, ALLOWED_TYPES } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { requireFields, assertObjectId, toCount } from '../utils/validators.js';

/**
 * Magic-byte signatures. The client's declared contentType is a hint, not a
 * fact: without this check a caller could store an executable and have it served
 * back with an image/jpeg header.
 */
const SIGNATURES = [
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    type: 'image/webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

function sniffType(buffer) {
  return SIGNATURES.find((s) => s.test(buffer))?.type ?? null;
}

/**
 * Normalises whatever the driver hands back for a Buffer field.
 *
 * With `.lean()` Mongoose skips casting, so a Buffer path arrives as a raw BSON
 * `Binary` -- which has no `.length`. Reading `.length` off it yielded
 * `undefined`, and setting that as Content-Length made Node reject the response
 * outright.
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value.buffer)) return value.buffer;          // BSON Binary
  if (typeof value.value === 'function') return Buffer.from(value.value(true));
  return Buffer.from(value);
}

/**
 * How long an unattached image is allowed to live.
 *
 * Uploading before the product exists is legitimate -- it is what lets a new
 * product be saved with its photo already in place -- so an image with no
 * productId is normal for the minute the form is open. Past a day it is not a
 * pending form, it is a form somebody abandoned, and nothing will ever claim it.
 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes this shop's abandoned uploads.
 *
 * Runs on upload rather than on a schedule: this app has no scheduler, and a
 * maintenance step a single operator has to remember is a maintenance step that
 * does not happen. Uploads are the only event that creates orphans, so they are
 * the natural moment to clear the last ones.
 */
async function sweepOrphans(businessId) {
  return ProductImage.hardDeleteMany({
    businessId,
    productId: null,
    createdAt: { $lt: new Date(Date.now() - ORPHAN_GRACE_MS) },
  });
}

/**
 * POST /api/images   { base64, contentType, width?, height?, productId? }
 *
 * JSON rather than multipart: the payload is already small (the app downscales
 * to roughly 40-80KB before sending), and it avoids adding a file-upload
 * middleware and its temp-file handling to the server.
 */
export async function uploadImage(req, res) {
  requireFields(req.body, ['base64', 'contentType']);
  const declaredType = String(req.body.contentType).toLowerCase();

  if (!ALLOWED_TYPES.includes(declaredType)) {
    throw ApiError.badRequest(`Unsupported image type "${declaredType}"`, {
      contentType: `must be one of ${ALLOWED_TYPES.join(', ')}`,
    });
  }

  const raw = String(req.body.base64).replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw ApiError.badRequest('base64 is not valid base64 data', { base64: 'malformed' });
  }

  let buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    throw ApiError.badRequest('Could not decode the image data');
  }

  if (!buffer.length) throw ApiError.badRequest('The image is empty');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw ApiError.badRequest(
      `Image is ${Math.round(buffer.length / 1024)}KB; the limit is ${Math.round(MAX_IMAGE_BYTES / 1024)}KB. Downscale it first.`,
      { bytes: buffer.length, maxBytes: MAX_IMAGE_BYTES }
    );
  }

  const actualType = sniffType(buffer);
  if (!actualType) {
    throw ApiError.badRequest('That data is not a JPEG, PNG or WebP image');
  }
  if (actualType !== declaredType) {
    throw ApiError.badRequest(`Data is ${actualType} but contentType says ${declaredType}`, {
      contentType: 'does not match the actual image data',
    });
  }

  // An image may be attached now or later, but only ever to your OWN product.
  let productId = null;
  if (req.body.productId) {
    productId = assertObjectId(req.body.productId, 'productId');
    const owns = await Product.exists({ _id: productId, businessId: req.businessId });
    if (!owns) throw ApiError.badRequest('That product does not belong to this business', { productId: 'not found' });
  }

  const image = await ProductImage.create({
    businessId: req.businessId,
    productId,
    contentType: actualType,
    data: buffer,
    bytes: buffer.length,
    ...(req.body.width && { width: toCount(req.body.width, 'width', { min: 1, max: 20000 }) }),
    ...(req.body.height && { height: toCount(req.body.height, 'height', { min: 1, max: 20000 }) }),
  });

  // Never let tidying up fail a photo the shopkeeper just took.
  try {
    await sweepOrphans(req.businessId);
  } catch (err) {
    console.warn('Orphan image sweep failed (upload unaffected):', err.message);
  }

  res.status(201).json({
    ok: true,
    image: {
      _id: image._id,
      url: `/images/${image._id}`,
      contentType: image.contentType,
      bytes: image.bytes,
      width: image.width ?? null,
      height: image.height ?? null,
    },
  });
}

/**
 * GET /api/images/:id
 * Returns the raw bytes. Cached for a year and marked immutable -- safe because
 * editing a photo creates a NEW image id rather than mutating this one.
 */
export async function getImage(req, res) {
  assertObjectId(req.params.id);

  const etag = `"${req.params.id}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  const image = await ProductImage.findOne({
    _id: req.params.id,
    businessId: req.businessId, // from the token, so one shop cannot read another's photos
  }).lean();

  if (!image) throw ApiError.notFound('Image not found');

  const buffer = toBuffer(image.data);
  if (!buffer.length) throw new ApiError(500, 'Stored image is empty');

  // Content-Length is left to Node, which derives it from the buffer -- one
  // less place for a bad value to break the response.
  res.set({
    'Content-Type': image.contentType,
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etag,
  });
  res.end(buffer);
}

/**
 * DELETE /api/images/:id -- and this one really deletes.
 *
 * Everything else the shop can remove is soft-deleted so it can come back. An
 * image is the exception: the bytes ARE the row, nothing in the app offers to
 * restore a single photo, and the admin restore only resurrects what the
 * ARCHIVE deleted. Keeping ~60KB per removed photo forever bought nothing.
 *
 * Read first, then delete: the row has to be inspected for its productId while
 * it still exists, so the product can be detached afterwards.
 */
export async function deleteImage(req, res) {
  assertObjectId(req.params.id);
  const image = await ProductImage.findOne({
    _id: req.params.id, businessId: req.businessId,
  }).lean();
  if (!image) throw ApiError.notFound('Image not found');

  await ProductImage.hardDeleteMany({ _id: image._id, businessId: req.businessId });

  if (image.productId) {
    await Product.updateOne(
      { _id: image.productId, businessId: req.businessId, imageId: image._id },
      { imageId: null }
    );
  }

  res.json({ ok: true, deleted: { _id: image._id, bytes: image.bytes } });
}

/** GET /api/images/usage -- how much of the storage budget this shop is using. */
export async function imageUsage(req, res) {
  const [agg] = await ProductImage.aggregate([
    { $match: { businessId: req.businessId } },
    { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$bytes' } } },
  ]);

  res.json({
    ok: true,
    usage: {
      images: agg?.count ?? 0,
      bytes: agg?.bytes ?? 0,
      megabytes: Math.round(((agg?.bytes ?? 0) / (1024 * 1024)) * 100) / 100,
      maxBytesPerImage: MAX_IMAGE_BYTES,
    },
  });
}
