/**
 * Finds -- and optionally renames -- products that share a name inside one
 * category.
 *
 * Why this exists: the unique index added to Product is built by Mongoose at
 * startup, and a unique index CANNOT be built over data that already violates
 * it. When that happens the build fails, the error goes to the connection's
 * error handler, and the app carries on happily still accepting duplicates.
 * Nothing crashes and nothing warns -- so an existing database has to be
 * cleaned before the constraint means anything.
 *
 *   npm run db:dupes         list them, change nothing
 *   npm run db:dupes -- --fix   rename the extras to "name (2)", "name (3)"
 *
 * --fix renames rather than deletes. A duplicate may well have real sales
 * against it, and merging two products' history is a judgement call no script
 * should make on a shopkeeper's behalf.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { Product } from '../models/index.js';

const FIX = process.argv.includes('--fix');

async function main() {
  await connectDB();

  // Group on the same terms the index uses: live rows only, case-insensitive.
  const groups = await Product.aggregate([
    { $match: { deletedAt: null } },
    {
      $group: {
        _id: {
          businessId: '$businessId',
          categoryId: '$categoryId',
          name: { $toLower: '$name' },
        },
        ids: { $push: '$_id' },
        names: { $push: '$name' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]).collation({ locale: 'en', strength: 2 });

  if (!groups.length) {
    console.log('No duplicate product names within a category. The unique index can build.');
    return;
  }

  console.log(`${groups.length} duplicated name(s) found:\n`);
  for (const g of groups) {
    console.log(`  shop ${g._id.businessId}  category ${g._id.categoryId}`);
    console.log(`    "${g.names[0]}" x${g.count}   ids: ${g.ids.join(', ')}`);
  }

  if (!FIX) {
    console.log('\nNothing changed. Re-run with --fix to rename the extras,');
    console.log('or edit them in the app, then restart the API so the index builds.');
    return;
  }

  console.log('\nRenaming...');
  let renamed = 0;
  for (const g of groups) {
    // The oldest row keeps the name; every later one gets a suffix. Ordering
    // by _id is ordering by creation time, so the product the shop has been
    // using longest is the one left untouched.
    const ordered = [...g.ids].sort((a, b) => String(a).localeCompare(String(b)));
    for (const [i, id] of ordered.entries()) {
      if (i === 0) continue;
      const suffix = ` (${i + 1})`;
      const current = await Product.findById(id).lean();
      if (!current) continue;
      // maxlength is 80; make room for the suffix rather than failing validation.
      const base = current.name.slice(0, 80 - suffix.length);
      await Product.updateOne({ _id: id }, { name: `${base}${suffix}` });
      console.log(`  ${id}  ->  "${base}${suffix}"`);
      renamed += 1;
    }
  }
  console.log(`\n${renamed} renamed. Restart the API so the unique index builds.`);
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
    await mongoose.connection.close().catch(() => {});
  });
