/**
 * Gives every product that predates the stock ledger an opening balance.
 *
 * Without this, the reconciliation on every existing product reads as one large
 * "unexplained" number -- not because anything is wrong, but because the ledger
 * starts halfway through the story. That is the worst possible first impression
 * for a feature whose only job is to be trusted.
 *
 *   npm run db:backfill            report what would be written
 *   npm run db:backfill -- --fix   write the opening rows
 *
 * The opening quantity is worked backwards from what is actually known:
 *
 *   opening = stock on hand now + everything ever sold
 *
 * which is exactly the figure that makes the reconciliation come out at zero.
 * It is dated to the product's own createdAt, so it sorts before the sales it
 * has to precede.
 *
 * Products that already have any movement are skipped -- re-running this must
 * never double-count, and a product created after the ledger existed already
 * has a real opening row.
 */
import 'dotenv/config';
import { connectDB, disconnectDB } from '../config/db.js';
import { Product, Order, StockMovement } from '../models/index.js';

const FIX = process.argv.includes('--fix');

async function main() {
  await connectDB();

  const products = await Product.find({}).select('businessId name stock createdAt').lean();
  if (!products.length) {
    console.log('No products found.');
    return;
  }

  // One aggregate for the whole shop rather than a query per product.
  const soldRows = await Order.aggregate([
    { $match: { deletedAt: null } },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', qty: { $sum: '$items.qty' } } },
  ]);
  const soldById = new Map(soldRows.map((r) => [String(r._id), r.qty]));

  const existing = await StockMovement.distinct('productId', {});
  const hasLedger = new Set(existing.map(String));

  const planned = [];
  let skipped = 0;
  let nothingToRecord = 0;

  for (const p of products) {
    if (hasLedger.has(String(p._id))) { skipped += 1; continue; }
    const sold = soldById.get(String(p._id)) ?? 0;
    const opening = (p.stock ?? 0) + sold;
    if (opening <= 0) { nothingToRecord += 1; continue; }
    planned.push({
      businessId: p.businessId,
      productId: p._id,
      productName: p.name,
      delta: opening,
      before: 0,
      after: opening,
      reason: 'opening',
      note: 'backfilled from stock on hand + units sold',
      at: p.createdAt ?? new Date(),
    });
  }

  console.log(`products                     ${products.length}`);
  console.log(`already have a ledger        ${skipped}`);
  console.log(`nothing to record (0 units)  ${nothingToRecord}`);
  console.log(`opening rows to write        ${planned.length}`);

  if (!planned.length) return;

  if (!FIX) {
    for (const row of planned.slice(0, 20)) {
      console.log(`  ${row.productName.padEnd(28)} opening ${row.after}`);
    }
    if (planned.length > 20) console.log(`  ... and ${planned.length - 20} more`);
    console.log('\nRe-run with -- --fix to write them.');
    return;
  }

  await StockMovement.insertMany(planned, { ordered: false });
  console.log(`\nWrote ${planned.length} opening rows.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => disconnectDB());
