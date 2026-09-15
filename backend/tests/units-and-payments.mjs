/**
 * Selling half a kilo, and knowing how the money came in.
 *
 * The rule the unit half turns on: a fraction is legal for a product MEASURED
 * in kg, g, l, ml or m, and refused for one COUNTED in pcs, pkt, box or dozen.
 * "2.5 pcs of soap" is a typo for 25; "2.5 kg of rice" is Tuesday. Getting that
 * backwards either makes the app useless for a kirana or turns a mis-tap into a
 * wrong bill and wrong stock.
 *
 * The payment half is smaller but answers the one question revenue cannot: how
 * much cash should be in the drawer tonight.
 *
 * Every existing product defaults to pcs, so nothing that worked before this
 * change behaves differently -- which is itself asserted, because a silent
 * loosening of the whole-number rule would be the worst outcome here.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5183;
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
    MONGODB_DB: 'unitstest', JWT_SECRET: 'units-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'units-admin',
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

try {
  const shop = 'Units ' + crypto.randomBytes(3).toString('hex');
  const token = (await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } })).body.token;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;

  const mk = async (name, extra = {}) =>
    (await api('POST', '/products', {
      token, body: { name, categoryId: cat._id, price: 100, cost: 60, stock: 10, ...extra },
    }));

  /* ==================== 1. the default is unchanged ==================== */
  console.log('\n=== a product with no unit behaves exactly as it always did ===');
  const soap = (await mk('Soap')).body.product;
  check('it defaults to pcs', soap.unit === 'pcs', soap.unit);
  check('  and is not fractional', soap.fractional === false, soap.fractional);

  const halfSoap = await api('POST', '/orders', {
    token, body: { items: [{ productId: soap._id, qty: 2.5 }] },
  });
  check('half a bar of soap -> 400', halfSoap.status === 400, halfSoap.body);
  check('  and the message names the unit',
    /sold in pcs/.test(halfSoap.body?.error ?? ''), halfSoap.body?.error);
  check('  and no stock moved',
    (await api('GET', '/products', { token })).body.products
      .find((p) => p.name === 'Soap').stock === 10);

  /* ==================== 2. a measured product ==================== */
  console.log('\n=== rice is sold by the kilo ===');
  const riceRes = await mk('Rice', { unit: 'kg', stock: 40.5, price: 60, cost: 45 });
  const rice = riceRes.body.product;
  check('a kg product is created', riceRes.status === 201, riceRes.body);
  check('  and reports itself as fractional', rice.fractional === true, rice.unit);
  check('  with a fractional opening stock', rice.stock === 40.5, rice.stock);

  const sale = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 2.5 }] },
  });
  check('selling 2.5 kg -> 201', sale.status === 201, sale.body);
  const line = sale.body.order.items[0];
  check('  the line keeps the fraction', line.qty === 2.5, line.qty);
  check('  and snapshots the unit', line.unit === 'kg', line.unit);
  check('  the money is right (2.5 x 60)', sale.body.order.grandTotal === 150, sale.body.order.grandTotal);
  const afterSale = (await api('GET', '/products', { token })).body.products.find((p) => p.name === 'Rice');
  check('  and the stock came down by the fraction', afterSale.stock === 38, afterSale.stock);

  /* ============ 3. floating point does not leak into quantities ============ */
  console.log('\n=== a quantity always prints ===');
  const twice = await api('POST', '/orders', {
    token,
    body: { items: [{ productId: rice._id, qty: 0.1 }, { productId: rice._id, qty: 0.2 }] },
  });
  check('0.1 kg + 0.2 kg merges to 0.3, not 0.30000000000000004',
    twice.body.order.items[0].qty === 0.3, twice.body.order.items[0].qty);

  const tiny = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 0.0004 }] },
  });
  check('a quantity below a gram rounds away to nothing -> 400',
    tiny.status === 400, { status: tiny.status, body: tiny.body });

  const zero = await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 0 }] },
  });
  check('a quantity of zero -> 400', zero.status === 400, zero.body);

  /* ==================== 4. stock moves in fractions too ==================== */
  console.log('\n=== every stock path accepts the fraction ===');
  const spoiled = await api('PATCH', `/products/${rice._id}/stock`, {
    token, body: { delta: -0.75, reason: 'damage', note: 'wet' },
  });
  check('0.75 kg spoiled -> 200', spoiled.status === 200, spoiled.body);
  check('  and lands in the ledger as a fraction',
    (await api('GET', `/products/${rice._id}/movements`, { token })).body.timeline
      .some((m) => m.delta === -0.75), 'no -0.75 row');

  const soapFraction = await api('PATCH', `/products/${soap._id}/stock`, { token, body: { delta: -0.5 } });
  check('the same on a pcs product -> 400', soapFraction.status === 400, soapFraction.body);

  const counted = await api('POST', '/products/stocktake', {
    token, body: { counts: [{ productId: rice._id, counted: 36.25 }] },
  });
  check('counting 36.25 kg -> 200', counted.status === 200, counted.body);
  check('  the variance is fractional', counted.body.applied[0].variance !== 0
    && !Number.isInteger(counted.body.applied[0].variance), counted.body.applied[0]);

  const countSoap = await api('POST', '/products/stocktake', {
    token, body: { counts: [{ productId: soap._id, counted: 9.5 }] },
  });
  check('counting half a bar of soap -> 400', countSoap.status === 400, countSoap.body);
  check('  and the whole count is refused, not just that row',
    (await api('GET', '/products', { token })).body.products.find((p) => p.name === 'Rice').stock === 36.25);

  /* ==================== 5. changing a product's unit ==================== */
  console.log('\n=== changing the unit ===');
  const toPcs = await api('PATCH', `/products/${rice._id}`, { token, body: { unit: 'pcs' } });
  check('moving a product holding 36.25 to pcs -> 400', toPcs.status === 400, toPcs.body);
  check('  and says how to fix it',
    /whole-number stock in the same save/i.test(toPcs.body?.error ?? ''), toPcs.body?.error);

  const both = await api('PATCH', `/products/${rice._id}`, { token, body: { unit: 'pcs', stock: 36 } });
  check('unit and stock together -> 200', both.status === 200, both.body);
  check('  and it is now countable', both.body.product.unit === 'pcs', both.body.product.unit);

  const backToKg = await api('PATCH', `/products/${rice._id}`, { token, body: { unit: 'kg', stock: 36.25 } });
  check('and back again, with a fraction in the same save', backToKg.status === 200, backToKg.body);

  const madeUp = await api('PATCH', `/products/${rice._id}`, { token, body: { unit: 'sackfuls' } });
  check('an invented unit -> 400', madeUp.status === 400, madeUp.body);
  check('  listing the ones that exist', /kg/.test(JSON.stringify(madeUp.body)), madeUp.body);

  /* ============ 6. a receipt keeps the unit it was sold in ============ */
  console.log('\n=== history is snapshotted, units included ===');
  const oldReceipt = (await api('GET', `/orders/${sale.body.order._id}`, { token })).body.order;
  check('the old receipt still says kg', oldReceipt.items[0].unit === 'kg', oldReceipt.items[0].unit);

  /* ==================== 7. how the money came in ==================== */
  console.log('\n=== payment methods ===');
  check('a sale with no method given is cash', sale.body.order.paymentMethod === 'cash',
    sale.body.order.paymentMethod);

  const upi = await api('POST', '/orders', {
    token, body: { items: [{ productId: soap._id, qty: 2 }], paymentMethod: 'upi' },
  });
  check('a UPI sale -> 201', upi.status === 201, upi.body);
  check('  and it is recorded', upi.body.order.paymentMethod === 'upi', upi.body.order.paymentMethod);

  const card = await api('POST', '/orders', {
    token, body: { items: [{ productId: soap._id, qty: 1 }], paymentMethod: 'CARD' },
  });
  check('the method is case-insensitive', card.body.order?.paymentMethod === 'card', card.body.order?.paymentMethod);

  const cheque = await api('POST', '/orders', {
    token, body: { items: [{ productId: soap._id, qty: 1 }], paymentMethod: 'cheque' },
  });
  check('an unknown method -> 400', cheque.status === 400, cheque.body);
  check('  and no sale was recorded for it',
    !(await api('GET', '/orders', { token })).body.orders.some((o) => o.paymentMethod === 'cheque'));

  const corrected = await api('PATCH', `/orders/${upi.body.order._id}`, {
    token, body: { paymentMethod: 'cash' },
  });
  check('"it was cash, not UPI" is a correction -> 200', corrected.status === 200, corrected.body);
  check('  and it stuck', corrected.body.order.paymentMethod === 'cash', corrected.body.order.paymentMethod);

  const badCorrection = await api('PATCH', `/orders/${upi.body.order._id}`, {
    token, body: { paymentMethod: 'barter' },
  });
  check('a bad correction -> 400', badCorrection.status === 400, badCorrection.body);
  check('  and did not count as an edit',
    (await api('GET', `/orders/${upi.body.order._id}`, { token })).body.order.editCount === 1,
    (await api('GET', `/orders/${upi.body.order._id}`, { token })).body.order.editCount);

  /* ==================== 8. the drawer question ==================== */
  console.log('\n=== how much cash should be in the drawer ===');
  const summary = (await api('GET', '/reports/summary', { token })).body;
  check('the summary breaks revenue down by method',
    Array.isArray(summary.payments) && summary.payments.length > 0, summary.payments);

  const byMethod = Object.fromEntries((summary.payments ?? []).map((p) => [p.method, p]));
  check('  cash is there', Boolean(byMethod.cash), Object.keys(byMethod));
  check('  and card', Boolean(byMethod.card), Object.keys(byMethod));
  check('  the amounts add up to revenue',
    Math.abs(summary.payments.reduce((s, p) => s + p.amount, 0) - summary.sales.revenue) < 0.01,
    { parts: summary.payments.map((p) => p.amount), revenue: summary.sales.revenue });
  check('  and the shares add up to 100%',
    Math.abs(summary.payments.reduce((s, p) => s + p.sharePercent, 0) - 100) < 0.1,
    summary.payments.map((p) => p.sharePercent));

  /* ============ 9. receipts from before this change still count ============ */
  console.log('\n=== a receipt written before payment methods existed ===');
  const legacy = await api('POST', '/orders', { token, body: { items: [{ productId: soap._id, qty: 1 }] } });
  // Strip the field the way a pre-upgrade row would have it: absent entirely.
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  await client.db('unitstest').collection('orders')
    .updateOne({ _id: new (await import('mongodb')).ObjectId(String(legacy.body.order._id)) },
      { $unset: { paymentMethod: '' } });
  await client.close();

  const after = (await api('GET', '/reports/summary', { token })).body;
  check('it is counted as cash rather than vanishing',
    Math.abs(after.payments.reduce((s, p) => s + p.amount, 0) - after.sales.revenue) < 0.01,
    { parts: after.payments, revenue: after.sales.revenue });
  check('  and does not create an "unknown" bucket',
    after.payments.every((p) => ['cash', 'upi', 'card', 'other'].includes(p.method)),
    after.payments.map((p) => p.method));

  /* ==================== 10. the export carries both ==================== */
  console.log('\n=== the export says how it was paid and in what unit ===');
  const exported = (await api('GET', '/reports/export', { token })).body;
  check('order rows name the payment method',
    exported.orders.every((o) => typeof o.paidBy === 'string'), exported.orders?.[0]);
  check('item rows name the unit',
    exported.items.every((i) => typeof i.unit === 'string'), exported.items?.[0]);
  check('  and a kg line says kg',
    exported.items.some((i) => i.unit === 'kg' && i.qty === 2.5),
    exported.items.filter((i) => i.unit === 'kg').slice(0, 3));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
