/**
 * Backup and restore.
 *
 * The only assertion that really matters is the last section's: export a shop,
 * wipe it, restore it, and prove the shop that comes back is the same shop --
 * same receipts, same products, same reports, same photos, and a next receipt
 * number that does not collide. Everything before it is there to catch the ways
 * a backup can look fine and not be.
 *
 * The two silent killers this suite exists for:
 *   1. ObjectIds and Dates surviving JSON. A backup written with plain
 *      JSON.stringify restores a shop whose order lines point at nothing and
 *      whose sales fall outside every date range.
 *   2. A truncated file. It still parses; it just has fewer rows.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5182;
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
    MONGODB_DB: 'backuptest', JWT_SECRET: 'backup-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'backup-admin',
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
  return { status: res.status, body: parsed, headers: res.headers };
};

const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(4096),
]).toString('base64');

try {
  /* ---------------------------- a real shop ---------------------------- */
  const shop = 'Backup ' + crypto.randomBytes(3).toString('hex');
  const token = (await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } })).body.token;

  const grain = (await api('POST', '/categories', { token, body: { name: 'Grain', color: '#2563EB' } })).body.category;
  const snacks = (await api('POST', '/categories', { token, body: { name: 'Snacks' } })).body.category;

  const photo = (await api('POST', '/images', {
    token, body: { base64: jpeg, contentType: 'image/jpeg' },
  })).body.image;

  const mk = async (name, categoryId, price, cost, stock, imageId) =>
    (await api('POST', '/products', { token, body: { name, categoryId, price, cost, stock, imageId } })).body.product;

  const rice = await mk('Rice 5kg', grain._id, 500, 380, 40, photo._id);
  const dal = await mk('Dal 1kg', grain._id, 120, 90, 25);
  const chips = await mk('Chips', snacks._id, 20, 12, 60);

  const o1 = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 2 }, { productId: chips._id, qty: 5 }], customerName: 'Meena' },
  })).body.order;
  const o2 = (await api('POST', '/orders', { token, body: { items: [{ productId: dal._id, qty: 3 }] } })).body.order;
  const o3 = (await api('POST', '/orders', { token, body: { items: [{ productId: chips._id, qty: 4 }] } })).body.order;
  await api('DELETE', `/orders/${o3._id}`, { token });          // a void, to prove flags travel
  await api('DELETE', `/products/${dal._id}`, { token });       // a soft-deleted product

  await api('POST', '/expenses', { token, body: { amount: 2500, note: 'Shop rent' } });
  await api('POST', '/expenses', { token, body: { amount: 320.5, note: 'Electricity' } });
  await api('PATCH', `/products/${rice._id}/stock`, { token, body: { delta: -2, reason: 'damage', note: 'wet sack' } });

  const summaryBefore = (await api('GET', '/reports/summary', { token })).body;
  const productsBefore = (await api('GET', '/products', { token })).body.products;
  const ordersBefore = (await api('GET', '/orders', { token })).body.orders;

  /* ============================ 1. status ============================ */
  console.log('\n=== what a backup would hold, before making one ===');
  const status = await api('GET', '/backup/status', { token });
  check('GET /backup/status -> 200', status.status === 200, status.body);
  check('  it counts the live AND deleted rows',
    status.body.counts.products === 3 && status.body.counts.orders === 3, status.body.counts);
  check('  and the photos', status.body.counts.images === 1, status.body.counts);
  check('  reporting roughly how heavy they are',
    status.body.approxImageBytes > 4000, status.body.approxImageBytes);

  /* ============================ 2. export ============================ */
  console.log('\n=== the export ===');
  const exported = await api('GET', '/backup/export', { token });
  check('GET /backup/export -> 200', exported.status === 200, exported.status);
  check('  it offers itself as a dated file',
    /attachment; filename="vyapaar-.*\d{4}-\d{2}-\d{2}\.json"/.test(exported.headers.get('content-disposition') ?? ''),
    exported.headers.get('content-disposition'));

  const backup = exported.body.backup;
  check('  it is versioned', backup.version === 1, backup.version);
  check('  it carries the shop name', backup.business.name === shop, backup.business);
  check('  the order counter travels', backup.counters.order === 3, backup.counters);
  check('  every collection is present',
    ['categories', 'products', 'orders', 'expenses', 'movements'].every((k) => Array.isArray(backup.data[k])),
    Object.keys(backup.data));
  check('  deleted rows travel too, flags intact',
    backup.data.products.some((p) => p.deletedAt) && backup.data.orders.some((o) => o.deletedAt),
    { products: backup.data.products.length, orders: backup.data.orders.length });
  check('  photos are NOT included unless asked for',
    backup.data.images.length === 0 && backup.includesImages === false, backup.includesImages);

  // The whole point of Extended JSON.
  check('  ids are tagged so they come back as ids, not strings',
    typeof backup.data.products[0]._id === 'object' && '$oid' in backup.data.products[0]._id,
    backup.data.products[0]._id);
  check('  dates are tagged so they come back as dates',
    '$date' in (backup.data.orders[0].timestamp ?? {}), backup.data.orders[0].timestamp);

  // And the thing that must never be in it.
  const asText = JSON.stringify(backup);
  check('  the PIN hash is NOT in the file', !/\$2[aby]\$\d{2}\$/.test(asText));
  check('  nor any field called pin', !/"pin"\s*:/.test(asText));

  const withPhotos = (await api('GET', '/backup/export?images=1', { token })).body.backup;
  check('asking for photos includes them', withPhotos.data.images.length === 1, withPhotos.counts);
  /**
   * Length, not just type. `typeof x === 'string'` passed happily while the
   * exporter was writing the EMPTY string for every photo -- a backup that
   * looked complete and contained no images at all.
   */
  check('  base64, not one JSON key per byte',
    typeof withPhotos.data.images[0].data === 'string', typeof withPhotos.data.images[0].data);
  check('  and the bytes are actually in there',
    withPhotos.data.images[0].data === jpeg,
    { expected: jpeg.length, got: withPhotos.data.images[0].data?.length });

  /* ==================== 3. restoring into a used shop ==================== */
  console.log('\n=== a restore never overwrites by accident ===');
  const refused = await api('POST', '/backup/restore', { token, body: { backup } });
  check('restoring over a shop with data -> 409', refused.status === 409, refused.body);
  check('  and says what is in the way', refused.body.details?.existing?.products === 3, refused.body.details);
  check('  nothing was touched',
    (await api('GET', '/products', { token })).body.products.length === 2);

  /* ==================== 4. files that cannot be trusted ==================== */
  console.log('\n=== a file that cannot be trusted is refused ===');
  const noVersion = await api('POST', '/backup/restore', {
    token, body: { backup: { data: { products: [] } }, mode: 'replace' },
  });
  check('a file with no version -> 400', noVersion.status === 400, noVersion.body);

  const wrongVersion = await api('POST', '/backup/restore', {
    token, body: { backup: { ...backup, version: 99 }, mode: 'replace' },
  });
  check('a file from a different app version -> 400', wrongVersion.status === 400, wrongVersion.body);

  const truncated = JSON.parse(JSON.stringify(backup));
  truncated.data.orders = truncated.data.orders.slice(0, 1); // counts still say 3
  const clipped = await api('POST', '/backup/restore', { token, body: { backup: truncated, mode: 'replace' } });
  check('a TRUNCATED file is caught by its own counts -> 400', clipped.status === 400, clipped.body);
  check('  and the message says what is missing',
    /incomplete/i.test(clipped.body?.error ?? ''), clipped.body?.error);
  check('  and it did not wipe the shop on the way to failing',
    (await api('GET', '/products', { token })).body.products.length === 2);

  const badMode = await api('POST', '/backup/restore', { token, body: { backup, mode: 'merge' } });
  check('an unsupported mode -> 400', badMode.status === 400, badMode.body);

  /* ============ 5. restore into a FRESH shop: the real test ============ */
  console.log('\n=== restoring into a brand new shop ===');
  const newShop = 'Restored ' + crypto.randomBytes(3).toString('hex');
  const t2 = (await api('POST', '/auth/register', { body: { businessName: newShop, pin: '9999' } })).body.token;

  const restored = await api('POST', '/backup/restore', { token: t2, body: { backup: withPhotos } });
  check('restoring into an empty shop -> 200', restored.status === 200, restored.body);
  check('  every collection came back',
    restored.body.restored.products === 3 && restored.body.restored.orders === 3
      && restored.body.restored.expenses === 2 && restored.body.restored.categories === 2,
    restored.body.restored);
  check('  and it says which receipt number comes next',
    restored.body.nextReceiptNumber === 4, restored.body);

  const productsAfter = (await api('GET', '/products', { token: t2 })).body.products;
  check('the live products match', productsAfter.length === 2, productsAfter.map((p) => p.name));
  check('  by name, price and stock',
    productsAfter.every((p) => {
      const was = productsBefore.find((b) => b.name === p.name);
      return was && was.price === p.price && was.stock === p.stock && was.cost === p.cost;
    }), { before: productsBefore.map((p) => [p.name, p.stock]), after: productsAfter.map((p) => [p.name, p.stock]) });
  check('  the deleted product stayed deleted',
    !productsAfter.some((p) => p.name === 'Dal 1kg'), productsAfter.map((p) => p.name));
  /**
   * Not just "has a category name" -- that assertion passes even when the
   * reference is stale, because populate() resolves by _id alone and the shop
   * the backup CAME FROM still holds a category with that id. The only honest
   * check is that the product points at a category belonging to THIS shop.
   */
  const catsAfter = (await api('GET', '/categories', { token: t2 })).body.categories;
  const ownCatIds = new Set(catsAfter.map((c) => String(c._id)));
  check('  and its category came with it', productsAfter.every((p) => p.category), productsAfter.map((p) => p.category));
  check('  pointing at THIS shop\'s category, not the original\'s',
    productsAfter.every((p) => ownCatIds.has(String(p.categoryId))),
    { productCats: productsAfter.map((p) => String(p.categoryId)), own: [...ownCatIds] });

  const ordersAfter = (await api('GET', '/orders', { token: t2 })).body.orders;
  check('the receipts match, voids still voided', ordersAfter.length === ordersBefore.length, {
    before: ordersBefore.length, after: ordersAfter.length,
  });
  check('  same receipt numbers',
    JSON.stringify(ordersAfter.map((o) => o.orderNumber).sort())
      === JSON.stringify(ordersBefore.map((o) => o.orderNumber).sort()),
    { before: ordersBefore.map((o) => o.orderNumber), after: ordersAfter.map((o) => o.orderNumber) });
  check('  same totals', ordersAfter.every((o) => {
    const was = ordersBefore.find((b) => b.orderNumber === o.orderNumber);
    return was && was.grandTotal === o.grandTotal;
  }), ordersAfter.map((o) => [o.orderNumber, o.grandTotal]));
  check('  and the customer name on the line',
    ordersAfter.some((o) => o.customerName === 'Meena'), ordersAfter.map((o) => o.customerName));

  /**
   * The assertion that catches a JSON.stringify backup: reports read by DATE
   * RANGE. A restored order whose timestamp came back as a string matches no
   * range at all, so revenue reads zero while the receipts list looks perfect.
   */
  const summaryAfter = (await api('GET', '/reports/summary', { token: t2 })).body;
  check('the reports say the same thing', summaryAfter.revenue === summaryBefore.revenue,
    { before: summaryBefore.revenue, after: summaryAfter.revenue });
  check('  including profit and expenses',
    summaryAfter.grossProfit === summaryBefore.grossProfit
      && summaryAfter.expenses === summaryBefore.expenses,
    { before: summaryBefore, after: summaryAfter });
  check('  and orders are counted, not lost to a date range',
    summaryAfter.orders === summaryBefore.orders, { before: summaryBefore.orders, after: summaryAfter.orders });

  /** The assertion that catches ids-as-strings: a join that has to resolve. */
  const byCategory = (await api('GET', '/reports/by-category', { token: t2 })).body;
  check('sales still resolve to their category',
    byCategory.categories?.length === 2 && byCategory.categories.every((c) => c.name && c.revenue > 0),
    byCategory.categories);
  check('  and to the categories of THIS shop',
    byCategory.categories.every((c) => ownCatIds.has(String(c.categoryId))),
    { reported: byCategory.categories.map((c) => String(c.categoryId)), own: [...ownCatIds] });

  const restoredRice = productsAfter.find((p) => p.name === 'Rice 5kg');
  check('the photo came back attached to its product', Boolean(restoredRice?.imageId), restoredRice);
  const served = await fetch(`${API}/images/${restoredRice.imageId}`, { headers: { Authorization: `Bearer ${t2}` } });
  check('  and it actually serves', served.status === 200, served.status);
  check('  byte for byte',
    Buffer.from(await served.arrayBuffer()).toString('base64') === jpeg);

  console.log('\n=== a backup taken without photos does not fake them ===');
  const noPhotoShop = 'NoPic ' + crypto.randomBytes(3).toString('hex');
  const t4 = (await api('POST', '/auth/register', { body: { businessName: noPhotoShop, pin: '2222' } })).body.token;
  await api('POST', '/backup/restore', { token: t4, body: { backup } }); // `backup` has images: []
  const noPhotoProducts = (await api('GET', '/products', { token: t4 })).body.products;
  check('products come back with no photo rather than a broken link',
    noPhotoProducts.every((p) => p.imageId == null && p.imageUrl == null),
    noPhotoProducts.map((p) => [p.name, p.imageId]));

  const movements = (await api('GET', `/products/${restoredRice._id}/movements`, { token: t2 })).body;
  check('the stock ledger came back', movements.timeline.some((m) => m.reason === 'damage'), movements.timeline);
  check('  with the sales still alongside it', movements.timeline.some((m) => m.type === 'sale'));
  check('  and it still reconciles', movements.reconciliation.unexplained === 0, movements.reconciliation);

  /* ============ 6. the next sale does not collide ============ */
  console.log('\n=== the shop can trade again immediately ===');
  const nextSale = await api('POST', '/orders', {
    token: t2, body: { items: [{ productId: restoredRice._id, qty: 1 }] },
  });
  check('a sale right after a restore succeeds', nextSale.status === 201, nextSale.body);
  check('  and gets a receipt number that was not already used',
    nextSale.body.order.orderNumber === 4, nextSale.body.order?.orderNumber);

  /* ============ 7. replace mode, on a shop that has moved on ============ */
  console.log('\n=== replacing a shop that has drifted ===');
  const replaced = await api('POST', '/backup/restore', { token: t2, body: { backup: withPhotos, mode: 'replace' } });
  check('mode "replace" is accepted', replaced.status === 200, replaced.body);
  check('  and says it replaced rather than filled', replaced.body.replaced === true, replaced.body);
  const afterReplace = (await api('GET', '/orders', { token: t2 })).body.orders;
  check('  the extra sale is gone again', afterReplace.length === ordersBefore.length, afterReplace.length);
  check('  with no duplicates left behind',
    new Set(afterReplace.map((o) => o.orderNumber)).size === afterReplace.length,
    afterReplace.map((o) => o.orderNumber));

  /* ==================== 8. it cannot cross tenants ==================== */
  console.log('\n=== a backup cannot smuggle rows into another shop ===');
  const third = 'Third ' + crypto.randomBytes(3).toString('hex');
  const t3 = (await api('POST', '/auth/register', { body: { businessName: third, pin: '1111' } })).body.token;
  await api('POST', '/backup/restore', { token: t3, body: { backup } });

  const stolen = (await api('GET', '/products', { token: t3 })).body.products;
  check('the rows land in the RESTORING shop', stolen.length === 2, stolen.length);
  const original = (await api('GET', '/products', { token })).body.products;
  check('  and the shop the backup came from is untouched', original.length === 2, original.length);
  check('  and the copies are genuinely separate rows',
    String(stolen[0]._id) !== String(original.find((p) => p.name === stolen[0].name)?._id),
    { restored: stolen[0]._id, source: original.find((p) => p.name === stolen[0].name)?._id });

  const noAuth = await fetch(`${API}/backup/export`);
  check('exporting without a token -> 401', noAuth.status === 401, noAuth.status);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
