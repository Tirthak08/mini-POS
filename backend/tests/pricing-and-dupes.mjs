/**
 * Two changes that both touch what a shopkeeper is allowed to record:
 *
 *   1. a category may not hold two products of the same name;
 *   2. a sale may be rung up at a price other than the catalogue's.
 *
 * They are tested together because they pull in opposite directions and the
 * interesting assertions are about where each one STOPS. Uniqueness must not
 * be so strict that a deleted name is lost forever or that two categories
 * cannot share a word. The price override must not be so loose that it can
 * rewrite cost -- which would let a shop report any profit it liked.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5178;
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

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'test',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'pricingtest',
    JWT_SECRET: 'pricing-test-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin',
    ADMIN_PASSWORD: 'pricing-test-admin',
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const shutdown = async (code) => {
  server.kill();
  await replSet.stop();
  process.exit(code);
};

for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`${API}/health`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
};

try {
  const shop = 'Price ' + crypto.randomBytes(3).toString('hex');
  const reg = await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } });
  const token = reg.body?.token;
  const grain = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;
  const offers = (await api('POST', '/categories', { token, body: { name: 'Offers' } })).body.category;

  const mk = (body) => api('POST', '/products', { token, body });

  /* ==================== 1. duplicate names ==================== */
  console.log('\n=== one category cannot hold the same name twice ===');

  const first = await mk({ name: 'Rice 5kg', categoryId: grain._id, price: 500, cost: 300, stock: 40 });
  check('the first product is created', first.status === 201, first.body);

  const dup = await mk({ name: 'Rice 5kg', categoryId: grain._id, price: 520, stock: 5 });
  check('an exact duplicate -> 409, not a second row', dup.status === 409, dup.body);
  check('and the message names the product, not the index',
    /Rice 5kg/.test(dup.body?.error ?? '') && !/E11000|index/i.test(dup.body?.error ?? ''), dup.body);

  // Case is the commonest way a duplicate slips in: nobody types it twice the
  // same way, and the list then shows two rows that look identical.
  const cased = await mk({ name: 'rice 5KG', categoryId: grain._id, price: 500, stock: 1 });
  check('a differently-cased duplicate is caught too', cased.status === 409, cased.body);

  // The other way: an accidental double space, which renders invisibly.
  const spaced = await mk({ name: 'Rice  5kg', categoryId: grain._id, price: 500, stock: 1 });
  check('extra internal whitespace is collapsed and caught', spaced.status === 409, spaced.body);

  const padded = await mk({ name: '  Rice 5kg  ', categoryId: grain._id, price: 500, stock: 1 });
  check('leading/trailing spaces are caught', padded.status === 409, padded.body);

  /* --- where uniqueness must STOP --- */
  console.log('\n=== ...but it must not be stricter than that ===');

  const other = await mk({ name: 'Rice 5kg', categoryId: offers._id, price: 450, stock: 10 });
  check('the same name in a DIFFERENT category is allowed', other.status === 201, other.body);

  const diff = await mk({ name: 'Rice 10kg', categoryId: grain._id, price: 900, stock: 10 });
  check('a genuinely different name is allowed', diff.status === 201, diff.body);

  // Another shop's catalogue is none of our business.
  const shopB = 'PriceB ' + crypto.randomBytes(3).toString('hex');
  const tokenB = (await api('POST', '/auth/register', { body: { businessName: shopB, pin: '4321' } })).body.token;
  const catB = (await api('POST', '/categories', { token: tokenB, body: { name: 'Grain' } })).body.category;
  const bDup = await api('POST', '/products', {
    token: tokenB, body: { name: 'Rice 5kg', categoryId: catB._id, price: 500, stock: 3 },
  });
  check('a DIFFERENT shop may use the same name', bDup.status === 201, bDup.body);

  // Deleting must free the name, or a typo is unfixable forever.
  const doomed = await mk({ name: 'Typoo Rice', categoryId: grain._id, price: 100, stock: 1 });
  await api('DELETE', `/products/${doomed.body.product._id}`, { token });
  const reused = await mk({ name: 'Typoo Rice', categoryId: grain._id, price: 100, stock: 1 });
  check('deleting a product frees its name for reuse', reused.status === 201, reused.body);

  /* --- renaming and moving --- */
  console.log('\n=== renaming and moving hit the same rule ===');

  const rename = await api('PATCH', `/products/${diff.body.product._id}`, {
    token, body: { name: 'Rice 5kg' },
  });
  check('renaming ONTO a taken name -> 409', rename.status === 409, rename.body);

  const stillThere = await api('GET', '/products', { token });
  const names = stillThere.body.products.filter((p) => String(p.categoryId) === String(grain._id)).map((p) => p.name);
  check('and the rename did not go through', names.includes('Rice 10kg'), names);

  const move = await api('PATCH', `/products/${other.body.product._id}`, {
    token, body: { categoryId: grain._id },
  });
  check('MOVING a product into a category that already has the name -> 409', move.status === 409, move.body);

  const okRename = await api('PATCH', `/products/${diff.body.product._id}`, {
    token, body: { name: 'Rice 20kg' },
  });
  check('an unclashing rename still works', okRename.status === 200, okRename.body);

  /* ==================== 2. price override ==================== */
  console.log('\n=== a sale can be rung up at a price other than the catalogue one ===');

  const rice = first.body.product;   // list 500, cost 300, stock 40

  const atList = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1 }] },
  });
  check('with no price given, the catalogue price is charged',
    atList.body?.order?.items?.[0]?.price === 500, atList.body?.order?.items?.[0]);
  check('and listPrice records the same figure',
    atList.body?.order?.items?.[0]?.listPrice === 500, atList.body?.order?.items?.[0]);

  // The reported case: the seller collects MORE than the shelf price.
  const over = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 2, price: 560 }] },
  });
  const overLine = over.body?.order?.items?.[0];
  check('an over-list price is honoured', overLine?.price === 560, overLine);
  check('the line total uses the charged price, not the list one',
    overLine?.lineTotal === 1120, overLine);
  check('the order total follows', over.body?.order?.grandTotal === 1120, over.body?.order);
  check('and what the catalogue said is still on the record',
    overLine?.listPrice === 500, overLine);

  const under = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, price: 450 }] },
  });
  check('selling BELOW list works too', under.body?.order?.items?.[0]?.price === 450, under.body?.order?.items?.[0]);

  // Zero is a giveaway, and must be distinguishable from "no override given".
  const free = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, price: 0 }] },
  });
  check('a price of zero is a giveaway, not a missing value',
    free.body?.order?.items?.[0]?.price === 0 && free.body?.order?.grandTotal === 0,
    free.body?.order?.items?.[0]);

  /* --- what the override must NOT be able to do --- */
  console.log('\n=== the override has limits ===');

  const negative = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, price: -50 }] },
  });
  check('a negative price -> 400', negative.status === 400, negative.body);

  const silly = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, price: 1e12 }] },
  });
  check('an absurd price -> 400, catching a missing decimal point', silly.status === 400, silly.body);

  // The important one. Cost decides reported profit; a client that could set
  // it could report any margin it wanted.
  const fakeCost = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, price: 500, cost: 1 }] },
  });
  check('cost is IGNORED from the request body -- it always comes from the product',
    fakeCost.body?.order?.items?.[0]?.cost === 300, fakeCost.body?.order?.items?.[0]);

  const fakeName = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, name: 'Free Gold Bar' }] },
  });
  check('name is ignored too', fakeName.body?.order?.items?.[0]?.name === 'Rice 5kg', fakeName.body?.order?.items?.[0]);

  /* --- discounts clamp against the OVERRIDDEN price --- */
  console.log('\n=== a discount clamps against what is actually charged ===');

  const discounted = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1, price: 100, discount: 400 }] },
  });
  const dLine = discounted.body?.order?.items?.[0];
  check('a discount larger than the reduced line is clamped to it', dLine?.discount === 100, dLine);
  check('so the line total is zero, never negative', dLine?.lineTotal === 0, dLine);
  check('and the order total is zero, never negative',
    discounted.body?.order?.grandTotal === 0, discounted.body?.order);

  /* --- profit uses the charged price --- */
  console.log('\n=== profit reflects what was collected, not what was listed ===');

  const profitShop = 'Profit ' + crypto.randomBytes(3).toString('hex');
  const pToken = (await api('POST', '/auth/register', { body: { businessName: profitShop, pin: '1111' } })).body.token;
  const pCat = (await api('POST', '/categories', { token: pToken, body: { name: 'Things' } })).body.category;
  const pProd = (await api('POST', '/products', {
    token: pToken, body: { name: 'Widget', categoryId: pCat._id, price: 100, cost: 60, stock: 10 },
  })).body.product;

  // One sold at list (profit 40), one sold at 150 (profit 90). Total 130.
  await api('POST', '/orders', { token: pToken, body: { items: [{ productId: pProd._id, qty: 1 }] } });
  await api('POST', '/orders', { token: pToken, body: { items: [{ productId: pProd._id, qty: 1, price: 150 }] } });

  const day = new Date().toISOString().slice(0, 10);
  const summary = await api('GET', `/reports/summary?from=${day}&to=${day}`, { token: pToken });
  const sales = summary.body?.sales;
  check('revenue counts the over-list rupees', sales?.revenue === 250, sales);
  check('COGS is unchanged by the override', sales?.cogs === 120, sales);
  check('so gross profit is 130, not the 80 the catalogue would predict',
    sales?.grossProfit === 130, sales);

  /* --- correcting a sale --- */
  console.log('\n=== correcting a sale can fix a mis-keyed price ===');

  const mistake = await api('POST', '/orders', {
    token: pToken, body: { items: [{ productId: pProd._id, qty: 1, price: 1500 }] },
  });
  check('the wrong price went through as typed', mistake.body?.order?.items?.[0]?.price === 1500);

  const fixed = await api('PATCH', `/orders/${mistake.body.order._id}`, {
    token: pToken, body: { items: [{ productId: pProd._id, qty: 1, price: 150 }] },
  });
  check('the correction applies the new price', fixed.body?.order?.items?.[0]?.price === 150, fixed.body?.order?.items?.[0]);
  check('the total is recomputed', fixed.body?.order?.grandTotal === 150, fixed.body?.order);
  check('listPrice still says what the catalogue said on the day of the sale',
    fixed.body?.order?.items?.[0]?.listPrice === 100, fixed.body?.order?.items?.[0]);

  // Editing a quantity must NOT quietly reprice a line back to the catalogue.
  const keeps = await api('PATCH', `/orders/${mistake.body.order._id}`, {
    token: pToken, body: { items: [{ productId: pProd._id, qty: 2 }] },
  });
  check('changing only the quantity keeps the overridden price',
    keeps.body?.order?.items?.[0]?.price === 150, keeps.body?.order?.items?.[0]);
  check('and charges it twice', keeps.body?.order?.grandTotal === 300, keeps.body?.order);

  /* --- stock is still guarded --- */
  console.log('\n=== none of this weakens the stock guard ===');

  const greedy = await api('POST', '/orders', {
    token: pToken, body: { items: [{ productId: pProd._id, qty: 9999, price: 1 }] },
  });
  check('a cheap price does not buy more stock than exists', greedy.status === 409, greedy.body);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
