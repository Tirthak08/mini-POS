/**
 * The stock ledger and the physical count.
 *
 * Two properties are worth more than every individual assertion here:
 *
 *   1. Stock never moves without a row saying why. Every write path -- create,
 *      edit, adjust by delta, adjust by absolute, stocktake -- is checked, and
 *      so is the compensating rollback when the log write itself fails.
 *   2. currentStock == (sum of ledger deltas) - (units sold). If that holds
 *      after an arbitrary sequence of sales, voids, edits and counts, the
 *      reconciliation the app shows is arithmetic rather than opinion.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

const PORT = 5181;
const API = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`));
};

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ launchTimeout: 120_000 }],
});
const uri = replSet.getUri();

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test', MONGODB_URI: uri,
    MONGODB_DB: 'stocklog', JWT_SECRET: 'stock-ledger-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'stock-ledger-admin',
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const shutdown = async (code) => { server.kill(); await replSet.stop(); process.exit(code); };

for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 500));
}

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
};

const client = new MongoClient(uri);
await client.connect();
const db = client.db('stocklog');
const movements = db.collection('stockmovements');

try {
  const shop = 'Stock ' + crypto.randomBytes(3).toString('hex');
  const reg = await api('POST', '/auth/register', { body: { businessName: shop, pin: '4321' } });
  const token = reg.body.token;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;

  const ledgerOf = (productId) =>
    movements.find({ productId: { $exists: true } }).toArray()
      .then((rows) => rows.filter((r) => String(r.productId) === String(productId)));

  const newProduct = async (name, stock, extra = {}) =>
    (await api('POST', '/products', {
      token, body: { name, categoryId: cat._id, price: 100, cost: 60, stock, ...extra },
    })).body.product;

  /* ------------------------ 1. opening balance ------------------------ */
  console.log('\n=== a product that starts with stock says so in the ledger ===');
  const rice = await newProduct('Rice 5kg', 20);
  let rows = await ledgerOf(rice._id);
  check('creating with stock writes exactly one row', rows.length === 1, rows.length);
  check('  reason is "opening"', rows[0]?.reason === 'opening', rows[0]?.reason);
  check('  0 -> 20', rows[0]?.before === 0 && rows[0]?.after === 20 && rows[0]?.delta === 20, rows[0]);
  check('  and it snapshots the name', rows[0]?.productName === 'Rice 5kg', rows[0]?.productName);

  const dal = await newProduct('Dal 1kg', 0);
  check('creating with ZERO stock writes nothing', (await ledgerOf(dal._id)).length === 0);

  /* --------------------- 2. every write path logs --------------------- */
  console.log('\n=== every way to change stock leaves a row ===');

  await api('PATCH', `/products/${rice._id}/stock`, { token, body: { delta: 10 } });
  rows = await ledgerOf(rice._id);
  const byDelta = rows.at(-1);
  check('adjust by +delta logs', rows.length === 2 && byDelta.delta === 10, rows.length);
  check('  and defaults to "restock"', byDelta.reason === 'restock', byDelta.reason);
  check('  20 -> 30', byDelta.before === 20 && byDelta.after === 30, byDelta);

  await api('PATCH', `/products/${rice._id}/stock`, { token, body: { delta: -4, reason: 'damage', note: 'sack torn' } });
  const damaged = (await ledgerOf(rice._id)).at(-1);
  check('a negative delta with a reason keeps that reason', damaged.reason === 'damage', damaged.reason);
  check('  and the note', damaged.note === 'sack torn', damaged.note);
  check('  30 -> 26', damaged.before === 30 && damaged.after === 26, damaged);

  await api('PATCH', `/products/${rice._id}/stock`, { token, body: { set: 25 } });
  const absolute = (await ledgerOf(rice._id)).at(-1);
  check('adjust by absolute "set" logs', absolute.delta === -1 && absolute.after === 25, absolute);
  check('  and defaults to "correction"', absolute.reason === 'correction', absolute.reason);

  await api('PATCH', `/products/${rice._id}`, { token, body: { stock: 30 } });
  const edited = (await ledgerOf(rice._id)).at(-1);
  check('editing the product form logs', edited.delta === 5 && edited.after === 30, edited);
  check('  as a "correction"', edited.reason === 'correction', edited.reason);

  const before = (await ledgerOf(rice._id)).length;
  await api('PATCH', `/products/${rice._id}`, { token, body: { price: 120, name: 'Rice 5kg' } });
  check('an edit that does NOT touch stock logs nothing',
    (await ledgerOf(rice._id)).length === before);
  await api('PATCH', `/products/${rice._id}`, { token, body: { stock: 30 } });
  check('and setting stock to the value it already has logs nothing',
    (await ledgerOf(rice._id)).length === before);

  /* -------------- 3. sales are NOT duplicated into the ledger -------------- */
  console.log('\n=== sales stay in the orders collection, not the ledger ===');
  const rowsBeforeSale = (await ledgerOf(rice._id)).length;
  const sale = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 3 }] },
  });
  check('checkout succeeds', sale.status === 201, sale.body);
  check('checkout writes no movement row',
    (await ledgerOf(rice._id)).length === rowsBeforeSale);
  const afterSale = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(rice._id));
  check('but the stock did drop', afterSale.stock === 27, afterSale.stock);

  /* ----------------------- 4. the merged timeline ----------------------- */
  console.log('\n=== the timeline puts sales back alongside adjustments ===');
  const hist = await api('GET', `/products/${rice._id}/movements`, { token });
  check('GET /movements -> 200', hist.status === 200, hist.body);
  const tl = hist.body.timeline ?? [];
  check('  it contains the sale', tl.some((t) => t.type === 'sale' && t.delta === -3), tl.slice(0, 3));
  check('  and the adjustments', tl.some((t) => t.type === 'adjustment' && t.reason === 'damage'));
  check('  newest first',
    tl.every((t, i) => i === 0 || new Date(tl[i - 1].at) >= new Date(t.at)), tl.map((t) => t.at));
  check('  the sale carries a receipt number', tl.find((t) => t.type === 'sale')?.receiptNo?.startsWith('INV-'));

  const recon = hist.body.reconciliation;
  check('reconciliation: current stock is right', recon.currentStock === 27, recon);
  check('reconciliation: units sold is right', recon.totalSold === 3, recon);
  check('reconciliation: NOTHING is unexplained', recon.unexplained === 0, recon);

  /* ---------------- 5. voiding a sale heals the timeline ---------------- */
  console.log('\n=== a voided sale leaves the ledger consistent ===');
  await api('DELETE', `/orders/${sale.body.order._id}`, { token });
  const afterVoid = await api('GET', `/products/${rice._id}/movements`, { token });
  check('the void removed the sale from the timeline',
    !afterVoid.body.timeline.some((t) => t.type === 'sale'), afterVoid.body.timeline.slice(0, 2));
  check('  and without writing a compensating row',
    (await ledgerOf(rice._id)).length === rowsBeforeSale);
  check('  reconciliation still balances', afterVoid.body.reconciliation.unexplained === 0,
    afterVoid.body.reconciliation);

  /* --------------------------- 6. the count --------------------------- */
  console.log('\n=== the stocktake ===');
  const sugar = await newProduct('Sugar 1kg', 12, { cost: 40 });
  const salt = await newProduct('Salt 1kg', 8, { cost: 10 });

  const count = await api('POST', '/products/stocktake', {
    token,
    body: {
      note: 'Sunday count',
      counts: [
        { productId: rice._id, counted: 28 },   // one more than recorded (30)... actually -2
        { productId: sugar._id, counted: 10 },  // 2 short
        { productId: salt._id, counted: 8 },    // matches
      ],
    },
  });
  check('stocktake -> 200', count.status === 200, count.body);
  check('  it corrected two products', count.body.summary?.corrected === 2, count.body.summary);
  check('  and left one alone', count.body.summary?.unchanged === 1, count.body.summary);
  check('  units lost is counted', count.body.summary?.unitsLost === 4, count.body.summary);
  check('  variance is valued at COST, not selling price',
    count.body.summary?.varianceValue === -(2 * 60) - (2 * 40), count.body.summary);

  const sugarNow = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(sugar._id));
  check('  the counted figure actually won', sugarNow.stock === 10, sugarNow.stock);

  const sugarLedger = await ledgerOf(sugar._id);
  check('  it wrote a stocktake row', sugarLedger.at(-1).reason === 'stocktake', sugarLedger.at(-1));
  check('  carrying the note', sugarLedger.at(-1).note === 'Sunday count', sugarLedger.at(-1).note);
  check('  a product that matched got NO row',
    (await ledgerOf(salt._id)).filter((r) => r.reason === 'stocktake').length === 0);

  const reconAfterCount = (await api('GET', `/products/${rice._id}/movements`, { token }))
    .body.reconciliation;
  check('  and the ledger still balances after a count',
    reconAfterCount.unexplained === 0 && reconAfterCount.currentStock === 28, reconAfterCount);

  /* ------------------------ 7. counts are guarded ------------------------ */
  console.log('\n=== a count that cannot be trusted is refused whole ===');
  const empty = await api('POST', '/products/stocktake', { token, body: { counts: [] } });
  check('empty count -> 400', empty.status === 400, empty.body);

  const dup = await api('POST', '/products/stocktake', {
    token, body: { counts: [{ productId: rice._id, counted: 1 }, { productId: rice._id, counted: 2 }] },
  });
  check('the same product counted twice -> 400', dup.status === 400, dup.body);

  const negative = await api('POST', '/products/stocktake', {
    token, body: { counts: [{ productId: rice._id, counted: -1 }] },
  });
  check('a negative count -> 400', negative.status === 400, negative.body);

  const fractional = await api('POST', '/products/stocktake', {
    token, body: { counts: [{ productId: rice._id, counted: 2.5 }] },
  });
  check('a fractional count -> 400', fractional.status === 400, fractional.body);

  const stockBeforeBadCount = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(rice._id)).stock;
  const ghost = await api('POST', '/products/stocktake', {
    token,
    body: {
      counts: [
        { productId: rice._id, counted: 999 },
        { productId: '0123456789abcdef01234567', counted: 5 },
      ],
    },
  });
  check('a count naming an unknown product -> 400', ghost.status === 400, ghost.body);
  const stockAfterBadCount = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(rice._id)).stock;
  check('  and NOTHING in it was applied',
    stockAfterBadCount === stockBeforeBadCount, { stockBeforeBadCount, stockAfterBadCount });

  /* ------------------------- 8. tenant isolation ------------------------- */
  console.log('\n=== none of it crosses tenants ===');
  const other = 'Stock B ' + crypto.randomBytes(3).toString('hex');
  const tokenB = (await api('POST', '/auth/register', { body: { businessName: other, pin: '1111' } })).body.token;

  const peek = await api('GET', `/products/${rice._id}/movements`, { token: tokenB });
  check("another shop reading my product's history -> 404", peek.status === 404, peek.body);

  const steal = await api('POST', '/products/stocktake', {
    token: tokenB, body: { counts: [{ productId: rice._id, counted: 0 }] },
  });
  check('another shop counting my product -> 400', steal.status === 400, steal.body);
  const untouched = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(rice._id));
  check('  and my stock is untouched', untouched.stock === stockBeforeBadCount, untouched.stock);

  /* ------------- 9. the reason enum is not a free-text field ------------- */
  console.log('\n=== reasons are a closed set ===');
  const bogus = await api('PATCH', `/products/${rice._id}/stock`, {
    token, body: { delta: 1, reason: 'because i said so' },
  });
  check('an unknown reason -> 400', bogus.status === 400, bogus.body);
  check('  and the message lists the valid ones',
    /stocktake/.test(JSON.stringify(bogus.body)), bogus.body);
  check('  and the stock did NOT move',
    (await api('GET', '/products', { token })).body.products
      .find((p) => String(p._id) === String(rice._id)).stock === untouched.stock);

  /* ------------- 10. the invariant, over a messy sequence ------------- */
  console.log('\n=== the invariant survives an arbitrary sequence ===');
  const mixed = await newProduct('Atta 10kg', 50, { cost: 300 });
  await api('PATCH', `/products/${mixed._id}/stock`, { token, body: { delta: 25 } });
  const s1 = await api('POST', '/orders', { token, body: { items: [{ productId: mixed._id, qty: 7 }] } });
  await api('PATCH', `/products/${mixed._id}`, { token, body: { stock: 60, reason: 'loss' } });
  const s2 = await api('POST', '/orders', { token, body: { items: [{ productId: mixed._id, qty: 4 }] } });
  await api('DELETE', `/orders/${s1.body.order._id}`, { token });
  await api('POST', '/products/stocktake', { token, body: { counts: [{ productId: mixed._id, counted: 61 }] } });
  await api('PATCH', `/orders/${s2.body.order._id}`, {
    token, body: { items: [{ productId: mixed._id, qty: 6 }] },
  });

  const final = await api('GET', `/products/${mixed._id}/movements`, { token });
  const r = final.body.reconciliation;
  check('after 7 mixed operations the ledger still explains the stock',
    r.unexplained === 0, r);
  check('  and current stock is what the sequence implies',
    r.currentStock === r.netAdjusted - r.totalSold, r);

  /* -------- 11. a rename does not rewrite the history it explains -------- */
  console.log('\n=== history is snapshotted, like receipts ===');
  await api('PATCH', `/products/${mixed._id}`, { token, body: { name: 'Atta 10kg Premium' } });
  const renamed = await ledgerOf(mixed._id);
  check('the old rows still say the old name',
    renamed[0].productName === 'Atta 10kg', renamed[0].productName);

  /* ---- 12. a stock change whose LOG fails is put back, not kept ---- */
  console.log('\n=== if the ledger cannot be written, the stock does not move ===');
  const fragile = await newProduct('Poha 500g', 5);
  const fragileOid = new (await import('mongodb')).ObjectId(String(fragile._id));
  // Force the next movement insert to fail, the only way a log write realistically
  // can: the database refuses it. A unique index on (product, reason) means the
  // second 'restock' for this product is rejected by the server.
  await movements.createIndex({ productId: 1, reason: 1 }, {
    unique: true,
    name: 'test_force_log_failure',
    // Scoped to this one product: the other products in this suite already hold
    // several rows with the same reason, and a shop-wide unique index could not
    // be built over them at all.
    partialFilterExpression: { productId: fragileOid },
  });
  const okRestock = await api('PATCH', `/products/${fragile._id}/stock`, { token, body: { delta: 3 } });
  check('the first restock still works', okRestock.status === 200, okRestock.body);
  const stockBeforeFailure = okRestock.body.product.stock;

  const doomed = await api('PATCH', `/products/${fragile._id}/stock`, { token, body: { delta: 7 } });
  check('a restock whose log write fails does NOT return 200', doomed.status >= 400, doomed.status);
  const afterFailure = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(fragile._id));
  check('  and the stock was rolled back',
    afterFailure.stock === stockBeforeFailure, { stockBeforeFailure, now: afterFailure.stock });
  check('  so no stock exists that the ledger cannot explain',
    (await api('GET', `/products/${fragile._id}/movements`, { token })).body.reconciliation.unexplained === 0);
  await movements.dropIndex('test_force_log_failure');


  /* ------- 13. the backfill gives pre-ledger products an opening row ------- */
  console.log('\n=== products that predate the ledger get an opening balance ===');
  const legacy = await newProduct('Oil 1L', 40, { cost: 150 });
  await api('POST', '/orders', { token, body: { items: [{ productId: legacy._id, qty: 9 }] } });
  // Simulate a product created before the ledger existed: it has sales and
  // stock, and nothing at all explaining where the stock came from.
  await movements.deleteMany({ productId: new (await import('mongodb')).ObjectId(String(legacy._id)) });

  const orphaned = await api('GET', `/products/${legacy._id}/movements`, { token });
  check('before the backfill the gap shows up as unexplained',
    orphaned.body.reconciliation.unexplained === 40, orphaned.body.reconciliation);

  const runScript = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/utils/backfillMovements.js', ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'stocklog' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });

  const dry = await runScript([]);
  check('a dry run exits cleanly', dry.code === 0, dry.out.slice(-300));
  check('  and writes nothing',
    (await ledgerOf(legacy._id)).length === 0, dry.out.slice(-300));

  const fixed = await runScript(['--fix']);
  check('--fix exits cleanly', fixed.code === 0, fixed.out.slice(-300));
  const backfilled = await ledgerOf(legacy._id);
  check('  it wrote one opening row', backfilled.length === 1, backfilled.length);
  // 40 created, 9 sold -> 31 on the shelf. The opening row has to be 31 + 9.
  check('  for stock on hand PLUS everything sold', backfilled[0]?.after === 40, backfilled[0]);

  const healed = await api('GET', `/products/${legacy._id}/movements`, { token });
  check('  and the reconciliation now balances',
    healed.body.reconciliation.unexplained === 0, healed.body.reconciliation);

  const again = await runScript(['--fix']);
  check('running it twice does not double-count',
    again.code === 0 && (await ledgerOf(legacy._id)).length === 1,
    (await ledgerOf(legacy._id)).length);

} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
