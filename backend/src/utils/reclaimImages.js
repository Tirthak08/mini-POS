/**
 * Finds -- and optionally removes -- product images that nothing can ever show
 * again.
 *
 * Four kinds accumulate, and until now none of them were ever freed:
 *
 *   soft-deleted   retired by an older build that stamped deletedAt and kept
 *                  the bytes. Nothing restores a single photo, so these are
 *                  pure dead weight.
 *   orphaned       uploaded from a "New product" form that was then abandoned.
 *                  Never attached to anything.
 *   dangling       attached to a product that has since been deleted.
 *   superseded     attached to a product that no longer points BACK at them --
 *                  the photo was replaced and the old row was left behind.
 *
 * Images belonging to an ARCHIVED business are deliberately left alone. That
 * path is built to be reversible, and the admin restore brings its photos back.
 *
 *   npm run db:images          report only, change nothing
 *   npm run db:images -- --fix reclaim the space
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { Business, Product, ProductImage } from '../models/index.js';

const FIX = process.argv.includes('--fix');
const GRACE_MS = 24 * 60 * 60 * 1000;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  await connectDB();

  // withDeleted, because most of the waste IS soft-deleted rows.
  const all = await ProductImage.find({}, null, { withDeleted: true }).select('+deletedAt').lean();
  if (!all.length) {
    console.log('No product images stored at all.');
    return;
  }

  const archived = new Set(
    (await Business.find({ deletedAt: { $ne: null } }, null, { withDeleted: true }).select('businessId').lean())
      .map((b) => b.businessId)
  );

  // One pass over products; a per-image lookup would be a query per photo.
  const products = await Product.find({}, null, { withDeleted: true }).select('imageId businessId').lean();
  const liveImageIds = new Set(products.filter((p) => p.deletedAt == null && p.imageId).map((p) => String(p.imageId)));
  const knownProducts = new Set(products.map((p) => String(p._id)));

  const cutoff = Date.now() - GRACE_MS;
  const buckets = { softDeleted: [], orphaned: [], dangling: [], superseded: [] };
  let keptBytes = 0;

  for (const img of all) {
    // Leave an archived business's photos alone -- restoring it should bring
    // them back, which is the entire difference between archive and purge.
    if (archived.has(img.businessId)) { keptBytes += img.bytes || 0; continue; }

    if (img.deletedAt != null) buckets.softDeleted.push(img);
    else if (img.productId == null) {
      if (new Date(img.createdAt).getTime() < cutoff) buckets.orphaned.push(img);
      else keptBytes += img.bytes || 0; // still inside the grace window
    } else if (!knownProducts.has(String(img.productId))) buckets.dangling.push(img);
    else if (!liveImageIds.has(String(img._id))) {
      // The product exists but points elsewhere (or was deleted): superseded.
      buckets.superseded.push(img);
    } else keptBytes += img.bytes || 0;
  }

  const reclaimable = Object.values(buckets).flat();
  const reclaimBytes = reclaimable.reduce((s, i) => s + (i.bytes || 0), 0);

  console.log(`${all.length} image rows, ${mb(all.reduce((s, i) => s + (i.bytes || 0), 0))} total\n`);
  for (const [name, rows] of Object.entries(buckets)) {
    const bytes = rows.reduce((s, i) => s + (i.bytes || 0), 0);
    console.log(`  ${name.padEnd(13)} ${String(rows.length).padStart(5)} rows   ${mb(bytes).padStart(10)}`);
  }
  console.log(`\n  ${'in use'.padEnd(13)} ${String(all.length - reclaimable.length).padStart(5)} rows   ${mb(keptBytes).padStart(10)}`);
  console.log(`  ${'reclaimable'.padEnd(13)} ${String(reclaimable.length).padStart(5)} rows   ${mb(reclaimBytes).padStart(10)}`);

  if (!reclaimable.length) {
    console.log('\nNothing to reclaim.');
    return;
  }
  if (!FIX) {
    console.log('\nNothing changed. Re-run with --fix to reclaim that space.');
    return;
  }

  const ids = reclaimable.map((i) => i._id);
  const res = await ProductImage.hardDeleteMany({ _id: { $in: ids } });
  console.log(`\nRemoved ${res.deletedCount ?? ids.length} rows, reclaiming ${mb(reclaimBytes)}.`);
  console.log('Atlas frees the space on its next compaction; the documents are gone immediately.');
}

main()
  .catch((err) => { console.error('Failed:', err.message); process.exitCode = 1; })
  .finally(async () => {
    await disconnectDB();
    await mongoose.connection.close().catch(() => {});
  });
