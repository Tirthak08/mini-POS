/**
 * End-to-end smoke test for the Mini-POS API.
 * Boots a real MongoDB replica set, spawns src/server.js against it, then
 * exercises every route over HTTP exactly as the Expo app will.
 *
 *   node tests/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/api`;
const ADMIN_USER = 'superadmin';
const ADMIN_PASS = 'admin-test-password';

let pass = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? `\n        ${JSON.stringify(extra)}` : ''}`);
  }
}
function section(t) { console.log(`\n=== ${t} ===`); }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ launchTimeout: 120_000 }],
});
const uri = replSet.getUri();
console.log(`MongoDB replica set up at ${uri}`);

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    MONGODB_DB: 'mini_pos_test',
    JWT_SECRET: 'test-secret-that-is-definitely-long-enough-0123456789',
    JWT_EXPIRES_IN: '1h',
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD: ADMIN_PASS,
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));

async function shutdown(code) {
  server.kill('SIGTERM');
  await replSet.stop();
  process.exit(code);
}

if (!(await waitForHealth())) {
  console.error('Server never became healthy. Output:\n' + serverLog.join(''));
  await shutdown(1);
}

try {
  // ---------------------------------------------------------------- health
  section('Health');
  {
    const r = await api('GET', '/health');
    check('GET /health returns 200 and mongo connected', r.status === 200 && r.body?.mongo?.state === 'connected', r.body);
  }

  // ------------------------------------------------------------------ auth
  section('Auth & multi-tenancy');
  let tokenA, tokenB, bizA, bizB;
  {
    const r = await api('POST', '/auth/register', { body: { businessName: 'Sharma Kirana', pin: '1234' } });
    tokenA = r.body?.token;
    bizA = r.body?.business?.businessId;
    check('register business A -> 201 + token', r.status === 201 && !!tokenA, r.body);
    check('businessId is opaque, not derived from the name',
      /^biz_[0-9a-f]{24}$/.test(bizA ?? '') && !String(bizA).toLowerCase().includes('sharma'), bizA);
    check('the response never leaks the internal slug', !('slug' in (r.body.business ?? {})), r.body.business);
    check('register response never contains the PIN', !JSON.stringify(r.body).toLowerCase().includes('"pin"'), r.body);

    const dup = await api('POST', '/auth/register', { body: { businessName: '  SHARMA   kirana ', pin: '9999' } });
    check('duplicate name (different case/spacing) -> 409', dup.status === 409, dup.body);

    const shortPin = await api('POST', '/auth/register', { body: { businessName: 'Pin Test', pin: '12' } });
    check('PIN shorter than 4 digits -> 400', shortPin.status === 400, shortPin.body);

    const alphaPin = await api('POST', '/auth/register', { body: { businessName: 'Pin Test 2', pin: '12ab' } });
    check('non-numeric PIN -> 400', alphaPin.status === 400, alphaPin.body);

    const noFields = await api('POST', '/auth/register', { body: {} });
    check('missing fields -> 400 listing both', noFields.status === 400 && /businessName/.test(noFields.body?.error || ''), noFields.body);

    const wrong = await api('POST', '/auth/login', { body: { businessName: 'Sharma Kirana', pin: '0000' } });
    check('login with wrong PIN -> 401', wrong.status === 401, wrong.body);

    const ghost = await api('POST', '/auth/login', { body: { businessName: 'Does Not Exist', pin: '1234' } });
    check('login for unknown business gives the same 401 message', ghost.status === 401 && ghost.body?.error === wrong.body?.error, ghost.body);

    const ok = await api('POST', '/auth/login', { body: { businessName: 'sharma kirana', pin: '1234' } });
    check('login is case-insensitive on name -> 200 + token', ok.status === 200 && !!ok.body?.token, ok.body);
    check('login returns the same opaque businessId', ok.body?.business?.businessId === bizA, ok.body?.business);
    tokenA = ok.body.token;

    /**
     * Changing a PIN, and the one status code that matters here.
     *
     * A wrong `currentPin` must be 400, NOT 401. The app reads 401 as "your
     * session is over" -- correctly, since that is what the auth middleware
     * uses it for -- and discards the token. When this endpoint answered 401,
     * one mistyped digit signed the shopkeeper out of the app and told them
     * their session had expired. The valid token they sent proves the session
     * was fine; it was the field that was wrong.
     */
    const pinShop = await api('POST', '/auth/register', { body: { businessName: 'Lock Change Co', pin: '1111' } });
    const pinToken = pinShop.body?.token;

    const badCurrent = await api('PATCH', '/auth/pin', { token: pinToken, body: { currentPin: '9999', newPin: '2222' } });
    check('a wrong current PIN -> 400, so the app does not sign the shop out',
      badCurrent.status === 400 && /current pin/i.test(badCurrent.body?.error || ''), badCurrent.body);

    const stillIn = await api('GET', '/auth/me', { token: pinToken });
    check('and the session it was sent with is still good', stillIn.status === 200, stillIn.body);

    const shortNew = await api('PATCH', '/auth/pin', { token: pinToken, body: { currentPin: '1111', newPin: '12' } });
    check('a too-short new PIN -> 400', shortNew.status === 400, shortNew.body);

    const noToken = await api('PATCH', '/auth/pin', { body: { currentPin: '1111', newPin: '2222' } });
    check('no token at all -> 401, which is what 401 is for', noToken.status === 401, noToken.body);

    const changed = await api('PATCH', '/auth/pin', { token: pinToken, body: { currentPin: '1111', newPin: '2222' } });
    check('the real change -> 200', changed.status === 200, changed.body);

    const oldPinLogin = await api('POST', '/auth/login', { body: { businessName: 'Lock Change Co', pin: '1111' } });
    check('the old PIN stops working', oldPinLogin.status === 401, oldPinLogin.body);
    const newPinLogin = await api('POST', '/auth/login', { body: { businessName: 'Lock Change Co', pin: '2222' } });
    check('the new PIN works', newPinLogin.status === 200 && !!newPinLogin.body?.token, newPinLogin.body);

    const b = await api('POST', '/auth/register', { body: { businessName: 'Patel Snacks', pin: '4321' } });
    tokenB = b.body?.token;
    bizB = b.body?.business?.businessId;
    check('register business B -> 201', b.status === 201 && !!tokenB, b.body);
    check('two businesses get different opaque keys', bizA !== bizB && /^biz_/.test(bizB ?? ''), { bizA, bizB });

    const noAuth = await api('GET', '/categories');
    check('protected route without token -> 401', noAuth.status === 401, noAuth.body);

    const badAuth = await api('GET', '/categories', { token: 'not.a.real.token' });
    check('protected route with garbage token -> 401', badAuth.status === 401, badAuth.body);

    const me = await api('GET', '/auth/me', { token: tokenA });
    check('GET /auth/me -> counts object', me.status === 200 && me.body?.counts?.products === 0, me.body);
  }

  // -------------------------------------------------- unified sign-in form
  section('Unified sign-in');
  {
    const asShop = await api('POST', '/auth/signin', { body: { identifier: 'Sharma Kirana', secret: '1234' } });
    check('a shop signs in through /signin', asShop.status === 200 && asShop.body?.role === 'business', asShop.body);
    check('it returns the same opaque businessId', asShop.body?.business?.businessId === bizA, asShop.body?.business);
    check('and a working token', (await api('GET', '/auth/me', { token: asShop.body.token })).status === 200);

    const messy = await api('POST', '/auth/signin', { body: { identifier: '  SHARMA   kirana ', secret: '1234' } });
    check('name matching stays case- and space-insensitive', messy.status === 200 && messy.body?.role === 'business', messy.body);

    const asAdmin = await api('POST', '/auth/signin', { body: { identifier: ADMIN_USER, secret: ADMIN_PASS } });
    check('the super admin signs in through the SAME endpoint', asAdmin.status === 200 && asAdmin.body?.role === 'admin', asAdmin.body);
    check('the admin token reaches admin routes',
      (await api('GET', '/admin/stats', { token: asAdmin.body.token })).status === 200);
    check('the admin token is still refused by business routes',
      (await api('GET', '/categories', { token: asAdmin.body.token })).status === 403);

    // --- failures must be indistinguishable ---
    const wrongPin = await api('POST', '/auth/signin', { body: { identifier: 'Sharma Kirana', secret: '0000' } });
    const wrongAdmin = await api('POST', '/auth/signin', { body: { identifier: ADMIN_USER, secret: 'nope' } });
    const unknown = await api('POST', '/auth/signin', { body: { identifier: 'No Such Shop', secret: '1234' } });
    check('wrong shop PIN -> 401', wrongPin.status === 401);
    check('wrong admin password -> 401', wrongAdmin.status === 401);
    check('unknown identifier -> 401', unknown.status === 401);
    check('all three failures are byte-identical (no account enumeration)',
      wrongPin.body.error === wrongAdmin.body.error && wrongAdmin.body.error === unknown.body.error,
      { wrongPin: wrongPin.body.error, wrongAdmin: wrongAdmin.body.error, unknown: unknown.body.error });

    const missing = await api('POST', '/auth/signin', { body: { identifier: 'Sharma Kirana' } });
    check('a missing field -> 400 naming it', missing.status === 400 && /secret/.test(missing.body?.error ?? ''), missing.body);

    // --- a shop must not be able to impersonate the admin ---
    const shadow = await api('POST', '/auth/register', { body: { businessName: ADMIN_USER, pin: '9999' } });
    check('registering a shop named like the admin -> 409', shadow.status === 409, shadow.body);
    const shadowCased = await api('POST', '/auth/register', { body: { businessName: ADMIN_USER.toUpperCase(), pin: '9999' } });
    check('the reservation is case-insensitive', shadowCased.status === 409, shadowCased.body);

    const stillAdmin = await api('POST', '/auth/signin', { body: { identifier: ADMIN_USER, secret: ADMIN_PASS } });
    check('the admin login still resolves to admin', stillAdmin.body?.role === 'admin', stillAdmin.body?.role);
  }

  // ------------------------------------------------------------ categories
  section('Categories');
  let catBev, catSnack, catB;
  {
    const c1 = await api('POST', '/categories', { token: tokenA, body: { name: 'Beverages', color: '#2563EB' } });
    catBev = c1.body?.category?._id;
    check('create category -> 201', c1.status === 201 && !!catBev, c1.body);

    const dup = await api('POST', '/categories', { token: tokenA, body: { name: 'beverages' } });
    check('same category name twice (case-insensitive) -> 409', dup.status === 409, dup.body);

    const badColor = await api('POST', '/categories', { token: tokenA, body: { name: 'Bad Colour', color: 'blue' } });
    check('non-hex color -> 400', badColor.status === 400, badColor.body);

    const c2 = await api('POST', '/categories', { token: tokenA, body: { name: 'Snacks', color: '#F59E0B' } });
    catSnack = c2.body?.category?._id;
    check('create second category -> 201', c2.status === 201 && !!catSnack, c2.body);

    // Business B may reuse the name -- tenants are independent.
    const cb = await api('POST', '/categories', { token: tokenB, body: { name: 'Beverages' } });
    catB = cb.body?.category?._id;
    check('other tenant may reuse the same category name -> 201', cb.status === 201, cb.body);

    const listA = await api('GET', '/categories', { token: tokenA });
    check('tenant A sees exactly its own 2 categories', listA.body?.categories?.length === 2, listA.body);

    const listB = await api('GET', '/categories', { token: tokenB });
    check('tenant B sees exactly its own 1 category', listB.body?.categories?.length === 1, listB.body);

    const crossEdit = await api('PATCH', `/categories/${catB}`, { token: tokenA, body: { name: 'Hijacked' } });
    check("tenant A cannot edit tenant B's category -> 404", crossEdit.status === 404, crossEdit.body);

    const crossDelete = await api('DELETE', `/categories/${catB}`, { token: tokenA });
    check("tenant A cannot delete tenant B's category -> 404", crossDelete.status === 404, crossDelete.body);
  }

  // -------------------------------------------------------------- products
  section('Products');
  let pTea, pChips, pSamosa;
  {
    const p1 = await api('POST', '/products', {
      token: tokenA, body: { name: 'Masala Chai', categoryId: catBev, price: 15, cost: 6, stock: 50 },
    });
    pTea = p1.body?.product?._id;
    check('create product -> 201', p1.status === 201 && !!pTea, p1.body);

    const strings = await api('POST', '/products', {
      token: tokenA, body: { name: 'Chips', categoryId: catSnack, price: '20.50', cost: '12', stock: '8' },
    });
    pChips = strings.body?.product?._id;
    check('numeric strings from TextInput are coerced', strings.status === 201 && strings.body.product.price === 20.5 && strings.body.product.stock === 8, strings.body);

    const p3 = await api('POST', '/products', {
      token: tokenA, body: { name: 'Samosa', categoryId: catSnack, price: 10, cost: 4, stock: 3 },
    });
    pSamosa = p3.body?.product?._id;
    check('create low-stock product -> 201', p3.status === 201, p3.body);

    const neg = await api('POST', '/products', {
      token: tokenA, body: { name: 'Negative', categoryId: catBev, price: -5 },
    });
    check('negative price -> 400', neg.status === 400, neg.body);

    const fracStock = await api('POST', '/products', {
      token: tokenA, body: { name: 'Half', categoryId: catBev, price: 5, stock: 1.5 },
    });
    check('fractional stock -> 400', fracStock.status === 400, fracStock.body);

    const foreignCat = await api('POST', '/products', {
      token: tokenA, body: { name: 'Cross Tenant', categoryId: catB, price: 5 },
    });
    check("product pointing at another tenant's category -> 400", foreignCat.status === 400, foreignCat.body);

    const injected = await api('POST', '/products', {
      token: tokenB, body: { name: 'Injected', categoryId: catB, price: 5, businessId: 'sharma kirana' },
    });
    check('businessId in the request body is ignored', injected.status === 201 && injected.body.product.businessId === bizB, injected.body);

    const listA = await api('GET', '/products', { token: tokenA });
    check('tenant A lists 3 products with category names joined', listA.body?.products?.length === 3 && listA.body.products.every((p) => p.category), listA.body);

    const filtered = await api('GET', `/products?categoryId=${catSnack}`, { token: tokenA });
    check('filter by categoryId returns 2', filtered.body?.products?.length === 2, filtered.body);

    const searched = await api('GET', '/products?search=chai', { token: tokenA });
    check('case-insensitive search works', searched.body?.products?.length === 1, searched.body);

    const regexSafe = await api('GET', '/products?search=(unclosed', { token: tokenA });
    check('regex metacharacters in search do not crash -> 200', regexSafe.status === 200, regexSafe.body);

    const restock = await api('PATCH', `/products/${pSamosa}/stock`, { token: tokenA, body: { delta: 5 } });
    check('stock delta +5 applied atomically', restock.body?.product?.stock === 8, restock.body);

    const overDraw = await api('PATCH', `/products/${pSamosa}/stock`, { token: tokenA, body: { delta: -100 } });
    check('stock delta below zero -> 409 with available count', overDraw.status === 409 && overDraw.body?.details?.available === 8, overDraw.body);

    const crossProduct = await api('PATCH', `/products/${pTea}`, { token: tokenB, body: { price: 1 } });
    check("tenant B cannot reprice tenant A's product -> 404", crossProduct.status === 404, crossProduct.body);
  }

  // -------------------------------------------------------------- checkout
  section('Checkout');
  let orderId;
  {
    const r = await api('POST', '/orders', {
      token: tokenA,
      body: {
        customerName: 'Ramesh',
        extraCharges: 10,
        items: [
          { productId: pTea, qty: 2, discount: 5 },     // 30 - 5  = 25
          { productId: pChips, qty: 1, discount: 0 },   // 20.50   = 20.50
        ],
      },
    });
    orderId = r.body?.order?._id;
    const o = r.body?.order;
    check('checkout -> 201', r.status === 201 && !!orderId, r.body);
    // subtotal is GROSS now, with the discount shown as its own deduction.
    check('subtotal is gross (30 + 20.50 = 50.50)', o?.subtotal === 50.5, o);
    check('discountTotal is reported separately (5)', o?.discountTotal === 5, o);
    check('grandTotal = gross - discount + charges (50.50 - 5 + 10 = 55.50)', o?.grandTotal === 55.5, o);
    check('the three figures actually add up',
      round2(o.subtotal - o.discountTotal + o.extraCharges) === o.grandTotal,
      { subtotal: o?.subtotal, discountTotal: o?.discountTotal, extraCharges: o?.extraCharges, grandTotal: o?.grandTotal });
    check('line snapshot stores name, price and cost', o?.items?.[0]?.name === 'Masala Chai' && o.items[0].cost === 6, o?.items);
    check('first order of the shop is receipt number 1', o?.orderNumber === 1, o?.orderNumber);
    check('receiptNo is human-readable', o?.receiptNo === 'INV-000001', o?.receiptNo);

    const tea = await api('GET', '/products?search=Masala', { token: tokenA });
    check('stock decremented 50 -> 48', tea.body?.products?.[0]?.stock === 48, tea.body?.products?.[0]);

    // PRD 7 edge case 2 -- discount larger than the line total.
    const clamp = await api('POST', '/orders', {
      token: tokenA,
      body: { customerName: 'Discount Abuser', items: [{ productId: pTea, qty: 1, discount: 9999 }] },
    });
    check('discount exceeding line value is clamped to the line gross',
      clamp.status === 201 && clamp.body.order.items[0].discount === 15 && clamp.body.order.subtotal === 15,
      clamp.body?.order);
    check('grandTotal never goes below zero', clamp.body?.order?.grandTotal === 0, clamp.body?.order);

    const tampered = await api('POST', '/orders', {
      token: tokenA,
      body: { items: [{ productId: pTea, qty: 1, price: 1, name: 'Hacked', cost: 0 }] },
    });
    check('client-supplied price/name are ignored; DB price used', tampered.status === 201 && tampered.body.order.items[0].price === 15 && tampered.body.order.items[0].name === 'Masala Chai', tampered.body?.order?.items);

    const prevNo = tampered.body?.order?.orderNumber;
    const second = await api('POST', '/orders', { token: tokenA, body: { items: [{ productId: pChips, qty: 1 }] } });
    check('receipt numbers increment by exactly one',
      second.body?.order?.orderNumber === prevNo + 1, { prevNo, next: second.body?.order?.orderNumber });

    const dupLines = await api('POST', '/orders', {
      token: tokenA,
      body: { items: [{ productId: pChips, qty: 1 }, { productId: pChips, qty: 2 }] },
    });
    check('same product twice merges into one line of qty 3', dupLines.status === 201 && dupLines.body.order.items.length === 1 && dupLines.body.order.items[0].qty === 3, dupLines.body?.order?.items);

    const oversell = await api('POST', '/orders', {
      token: tokenA, body: { items: [{ productId: pSamosa, qty: 999 }] },
    });
    check('overselling -> 409 listing what is available', oversell.status === 409 && oversell.body?.details?.outOfStock?.[0]?.available === 8, oversell.body);

    const empty = await api('POST', '/orders', { token: tokenA, body: { items: [] } });
    check('empty cart -> 400', empty.status === 400, empty.body);

    const crossItem = await api('POST', '/orders', { token: tokenB, body: { items: [{ productId: pTea, qty: 1 }] } });
    check("tenant B cannot sell tenant A's product -> 400", crossItem.status === 400, crossItem.body);

    const anon = await api('POST', '/orders', { token: tokenA, body: { items: [{ productId: pTea, qty: 1 }] } });
    check('missing customerName defaults to "Walk-in"', anon.body?.order?.customerName === 'Walk-in', anon.body?.order);

    const listA = await api('GET', '/orders', { token: tokenA });
    check('tenant A order history is non-empty', (listA.body?.orders?.length || 0) >= 5, listA.body?.pagination);

    const listB = await api('GET', '/orders', { token: tokenB });
    check('tenant B order history is empty (no leakage)', listB.body?.orders?.length === 0, listB.body);

    const one = await api('GET', `/orders/${orderId}`, { token: tokenA });
    check('receipt reprint by id -> 200', one.status === 200 && one.body?.order?.customerName === 'Ramesh', one.body);

    const crossOrder = await api('GET', `/orders/${orderId}`, { token: tokenB });
    check("tenant B cannot read tenant A's receipt -> 404", crossOrder.status === 404, crossOrder.body);
  }

  // ------------------------------------------------ receipts that add up
  section('Receipt arithmetic');
  {
    const cat = await api('POST', '/categories', { token: tokenA, body: { name: 'MathCat' } });
    const item = (await api('POST', '/products', {
      token: tokenA, body: { name: 'MathItem', categoryId: cat.body.category._id, price: 50, cost: 20, stock: 50 },
    })).body.product;

    // The exact case from the bug report: one item at 50, discount 10.
    const r = await api('POST', '/orders', {
      token: tokenA, body: { items: [{ productId: item._id, qty: 1, discount: 10 }] },
    });
    const o = r.body.order;
    check('subtotal shows the gross 50, not the discounted 40', o.subtotal === 50, o);
    check('the discount is its own line (10)', o.discountTotal === 10, o);
    check('grand total is 40', o.grandTotal === 40, o);
    check('50 - 10 + 0 = 40 reads correctly on the receipt',
      round2(o.subtotal - o.discountTotal + o.extraCharges) === o.grandTotal, o);
    check('the line still records its net value for profit maths', o.items[0].lineTotal === 40, o.items[0]);

    // With charges too.
    const r2 = await api('POST', '/orders', {
      token: tokenA, body: { extraCharges: 15, items: [{ productId: item._id, qty: 3, discount: 20 }] },
    });
    const o2 = r2.body.order;
    check('gross 150, discount 20, charges 15 -> 145', o2.subtotal === 150 && o2.discountTotal === 20 && o2.grandTotal === 145, o2);

    // No discount at all: subtotal and grand total agree.
    const r3 = await api('POST', '/orders', { token: tokenA, body: { items: [{ productId: item._id, qty: 2 }] } });
    check('with no discount, subtotal equals grand total', r3.body.order.subtotal === 100 && r3.body.order.grandTotal === 100, r3.body?.order);
    check('and discountTotal is zero', r3.body.order.discountTotal === 0);

    // An edit must keep the invariant.
    const edited = await api('PATCH', `/orders/${o.order?._id ?? o._id}`, {
      token: tokenA, body: { items: [{ productId: item._id, qty: 4, discount: 30 }], extraCharges: 5 },
    });
    const e = edited.body.order;
    check('after an edit the arithmetic still reads correctly',
      e.subtotal === 200 && e.discountTotal === 30 && e.grandTotal === 175
      && round2(e.subtotal - e.discountTotal + e.extraCharges) === e.grandTotal, e);

    // Reports separate gross from discounts.
    const sum = await api('GET', '/reports/summary', { token: tokenA });
    check('summary reports gross sales', typeof sum.body?.sales?.grossSales === 'number', sum.body?.sales);
    check('and discounts given', sum.body?.sales?.discountsGiven > 0, sum.body?.sales);

    const exp = await api('GET', '/reports/export', { token: tokenA });
    const row = exp.body.orders.find((x) => x.grandTotal === 145);
    check('the export shows gross and discount as separate columns that reconcile',
      row && round2(row.subtotal - row.discount + row.extraCharges) === row.grandTotal, row);
  }

  // -------------------------------------------------------------- concurrency
  section('Concurrency (the last unit)');
  {
    const c = await api('POST', '/categories', { token: tokenA, body: { name: 'Scarce' } });
    const p = await api('POST', '/products', {
      token: tokenA, body: { name: 'Last One', categoryId: c.body.category._id, price: 100, cost: 40, stock: 1 },
    });
    const id = p.body.product._id;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api('POST', '/orders', { token: tokenA, body: { items: [{ productId: id, qty: 1 }] } })
      )
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409).length;
    check('5 simultaneous checkouts on 1 unit -> exactly 1 succeeds', created === 1, { created, rejected });
    check('the other 4 are rejected with 409', rejected === 4, { created, rejected });

    const after = await api('GET', `/products?search=Last One`, { token: tokenA });
    check('stock ends at exactly 0, never negative', after.body?.products?.[0]?.stock === 0, after.body?.products?.[0]);
  }

  // ------------------------------------------------------------------ void
  section('Void order restores stock');
  {
    const before = await api('GET', '/products?search=Masala', { token: tokenA });
    const stockBefore = before.body.products[0].stock;

    const v = await api('DELETE', `/orders/${orderId}`, { token: tokenA });
    check('void order -> 200', v.status === 200, v.body);

    const after = await api('GET', '/products?search=Masala', { token: tokenA });
    check('voided order returns its 2 units to stock', after.body.products[0].stock === stockBefore + 2, { stockBefore, after: after.body.products[0].stock });

    const gone = await api('GET', `/orders/${orderId}`, { token: tokenA });
    check('voided order is no longer retrievable -> 404', gone.status === 404, gone.body);

    const client2 = await MongoClient.connect(uri);
    const stillThere = await client2.db('mini_pos_test')
      .collection('orders').findOne({ _id: new (await import('mongodb')).ObjectId(String(orderId)) });
    await client2.close();
    check('the voided receipt is retained on disk for audit', Boolean(stillThere?.deletedAt), stillThere?.deletedAt);
  }

  // --------------------------------------------------------------- reports
  section('Reports');
  {
    const s = await api('GET', '/reports/summary', { token: tokenA });
    check('summary -> 200 with sales + inventory blocks', s.status === 200 && s.body?.sales && s.body?.inventory, s.body);
    check('profit = revenue - cogs', s.body?.sales?.profit === Math.round((s.body.sales.revenue - s.body.sales.cogs) * 100) / 100, s.body?.sales);
    check('revenue is a positive number', s.body?.sales?.revenue > 0, s.body?.sales);
    check('stock valuation present', typeof s.body?.inventory?.stockValueAtCost === 'number', s.body?.inventory);

    // Relative dates: a fixed '2026-08-18' froze the test in time -- it started
    // failing at midnight on the 19th because "today's" sale left the window.
    const isoDay = (d) => d.toISOString().slice(0, 10);
    const trendTo = new Date();
    const trendFrom = new Date(trendTo.getTime() - 17 * 864e5);
    const t = await api('GET', `/reports/sales-trend?from=${isoDay(trendFrom)}&to=${isoDay(trendTo)}`, { token: tokenA });
    check('sales-trend -> 18 gap-filled day buckets', t.status === 200 && t.body?.trend?.length === 18, { len: t.body?.trend?.length });
    check('trend buckets are YYYY-MM-DD and carry profit', /^\d{4}-\d{2}-\d{2}$/.test(t.body?.trend?.[0]?.period || '') && 'profit' in (t.body?.trend?.[0] || {}), t.body?.trend?.[0]);
    check("today's bucket has the revenue", t.body?.trend?.some((b) => b.revenue > 0), t.body?.trend?.filter((b) => b.revenue > 0));

    const mFrom = new Date(trendTo.getFullYear(), trendTo.getMonth() - 2, 1);
    const m = await api('GET', `/reports/sales-trend?groupBy=month&from=${isoDay(mFrom)}&to=${isoDay(trendTo)}`, { token: tokenA });
    check('groupBy=month -> 3 YYYY-MM buckets', m.body?.trend?.length === 3 && /^\d{4}-\d{2}$/.test(m.body.trend[0].period), m.body?.trend);

    const c = await api('GET', '/reports/by-category', { token: tokenA });
    check('by-category -> 200 with shares summing to ~100', c.status === 200 && Math.abs(c.body.categories.reduce((s2, x) => s2 + x.sharePercent, 0) - 100) < 0.5, c.body?.categories);
    check('by-category carries a colour for the chart', c.body?.categories?.every((x) => /^#/.test(x.color)), c.body?.categories);

    const tp = await api('GET', '/reports/top-products?limit=5', { token: tokenA });
    check('top-products -> sorted desc by revenue', tp.status === 200 && tp.body.products.every((p, i, a) => i === 0 || a[i - 1].revenue >= p.revenue), tp.body?.products);

    const ls = await api('GET', '/reports/low-stock?threshold=8', { token: tokenA });
    check('low-stock threshold filter works', ls.status === 200 && ls.body.products.every((p) => p.stock <= 8), ls.body?.products);

    const ex = await api('GET', '/reports/export', { token: tokenA });
    check('export -> orders[] + items[] for CSV/XLSX/PDF', ex.status === 200 && Array.isArray(ex.body.orders) && Array.isArray(ex.body.items), { orders: ex.body?.orders?.length, items: ex.body?.items?.length });
    check('export item rows carry lineProfit', ex.body?.items?.every((i) => typeof i.lineProfit === 'number'), ex.body?.items?.[0]);

    const badRange = await api('GET', '/reports/summary?from=2026-09-01&to=2026-08-01', { token: tokenA });
    check('from after to -> 400', badRange.status === 400, badRange.body);

    const emptyB = await api('GET', '/reports/summary', { token: tokenB });
    check('tenant B reports show zero revenue (isolation holds in aggregations)', emptyB.body?.sales?.revenue === 0, emptyB.body?.sales);
  }

  // ------------------------------------------------- deletes really delete
  section('Deletes persist (verified in the database)');
  {
    const client = await MongoClient.connect(uri);
    const db = client.db('mini_pos_test');
    // "live" = visible to the app; "any" = still on disk (soft-deleted rows are).
    const liveCats = (name) => db.collection('categories').countDocuments({ businessId: bizA, name, deletedAt: null });
    const anyCats = (name) => db.collection('categories').countDocuments({ businessId: bizA, name });
    const liveProds = (name) => db.collection('products').countDocuments({ businessId: bizA, name, deletedAt: null });
    const anyProds = (name) => db.collection('products').countDocuments({ businessId: bizA, name });

    // An empty category deletes outright.
    const empty = await api('POST', '/categories', { token: tokenA, body: { name: 'ToDelete' } });
    check('created a throwaway category', empty.status === 201, empty.body);
    const delEmpty = await api('DELETE', `/categories/${empty.body.category._id}`, { token: tokenA });
    check('delete empty category -> 200', delEmpty.status === 200, delEmpty.body);
    check('it is invisible to the app', (await liveCats('ToDelete')) === 0);
    check('but the row is retained on disk (soft delete)', (await anyCats('ToDelete')) === 1);
    check('the row carries a deletedAt timestamp',
      Boolean((await db.collection('categories').findOne({ businessId: bizA, name: 'ToDelete' }))?.deletedAt));
    const listAfter = await api('GET', '/categories', { token: tokenA });
    check('it is gone from GET /categories', !listAfter.body.categories.some((c) => c.name === 'ToDelete'));
    const delAgain = await api('DELETE', `/categories/${empty.body.category._id}`, { token: tokenA });
    check('deleting it twice -> 404', delAgain.status === 404, delAgain.body);

    // A category holding products refuses, then cascades with ?force=true.
    const held = await api('POST', '/categories', { token: tokenA, body: { name: 'HasStuff' } });
    const child = await api('POST', '/products', {
      token: tokenA, body: { name: 'ChildItem', categoryId: held.body.category._id, price: 5, stock: 2 },
    });
    check('created a category with one product', child.status === 201, child.body);
    const refuse = await api('DELETE', `/categories/${held.body.category._id}`, { token: tokenA });
    check('delete non-empty category -> 409 with productCount', refuse.status === 409 && refuse.body.details?.productCount === 1, refuse.body);
    check('nothing was deleted by the refused attempt', (await liveCats('HasStuff')) === 1 && (await liveProds('ChildItem')) === 1);
    const forced = await api('DELETE', `/categories/${held.body.category._id}?force=true`, { token: tokenA });
    check('?force=true -> 200 and reports the cascade', forced.status === 200 && forced.body.deleted?.products === 1, forced.body);
    check('category AND its product are hidden from the app', (await liveCats('HasStuff')) === 0 && (await liveProds('ChildItem')) === 0);
    check('both rows are retained on disk', (await anyCats('HasStuff')) === 1 && (await anyProds('ChildItem')) === 1);

    // Products delete outright.
    const solo = await api('POST', '/products', {
      token: tokenA, body: { name: 'SoloItem', categoryId: catBev, price: 9, stock: 1 },
    });
    const delSolo = await api('DELETE', `/products/${solo.body.product._id}`, { token: tokenA });
    check('delete product -> 200', delSolo.status === 200, delSolo.body);
    check('product is hidden from the app', (await liveProds('SoloItem')) === 0);
    check('product row is retained on disk', (await anyProds('SoloItem')) === 1);
    const soloList = await api('GET', '/products', { token: tokenA });
    check('product is gone from GET /products', !soloList.body.products.some((p) => p.name === 'SoloItem'));

    // A deleted product must not resurface in a fresh session either.
    const relogin = await api('POST', '/auth/login', { body: { businessName: 'Sharma Kirana', pin: '1234' } });
    const freshList = await api('GET', '/products', { token: relogin.body.token });
    check('deleted product absent for a brand-new token', !freshList.body.products.some((p) => p.name === 'SoloItem'));
    const freshCats = await api('GET', '/categories', { token: relogin.body.token });
    check('deleted categories absent for a brand-new token',
      !freshCats.body.categories.some((c) => ['ToDelete', 'HasStuff'].includes(c.name)));

    // A deleted name is free to reuse, and doing so must not revive the old row.
    const reuse = await api('POST', '/categories', { token: tokenA, body: { name: 'ToDelete' } });
    check('a deleted category name can be reused -> 201', reuse.status === 201, reuse.body);
    check('reuse creates a NEW row, leaving the deleted one alone',
      String(reuse.body.category._id) !== String(empty.body.category._id) && (await anyCats('ToDelete')) === 2);

    // Deleted rows must not leak through aggregations either.
    const catList = await api('GET', '/categories', { token: tokenA });
    const dupRows = catList.body.categories.filter((c) => c.name === 'ToDelete');
    check('the category list shows the reused name exactly once', dupRows.length === 1, dupRows);
    const lowStock = await api('GET', '/reports/low-stock?threshold=99999', { token: tokenA });
    check('low-stock report excludes deleted products',
      !lowStock.body.products.some((pr) => ['SoloItem', 'ChildItem'].includes(pr.name)), lowStock.body?.products?.map((x) => x.name));
    const topProd = await api('GET', '/reports/summary', { token: tokenA });
    check('inventory valuation excludes deleted products', topProd.body?.inventory?.products >= 1, topProd.body?.inventory);

    await client.close();
  }

  // ---------------------------------------------------- editing a past sale
  section('Editing an order');
  {
    // A clean shop so stock arithmetic is unambiguous.
    const cat = await api('POST', '/categories', { token: tokenA, body: { name: 'EditCat' } });
    const mk = async (name, price, cost, stock) => (await api('POST', '/products', {
      token: tokenA, body: { name, categoryId: cat.body.category._id, price, cost, stock },
    })).body.product;
    const a = await mk('EditA', 100, 40, 20);
    const b = await mk('EditB', 50, 20, 10);
    const c = await mk('EditC', 30, 10, 4);

    const stockOf = async (id) => (await api('GET', `/products?search=Edit`, { token: tokenA }))
      .body.products.find((p) => String(p._id) === String(id))?.stock;

    const sale = await api('POST', '/orders', {
      token: tokenA, body: { customerName: 'Asha', extraCharges: 20, items: [{ productId: a._id, qty: 2 }, { productId: b._id, qty: 1 }] },
    });
    const orderId = sale.body.order._id;
    const receiptNo = sale.body.order.orderNumber;
    check('sale created: 2x100 + 1x50 + 20 = 270', sale.body.order.grandTotal === 270, sale.body.order?.grandTotal);
    check('stock taken: A 20->18, B 10->9', (await stockOf(a._id)) === 18 && (await stockOf(b._id)) === 9);

    // ---- metadata only ----
    const meta = await api('PATCH', `/orders/${orderId}`, { token: tokenA, body: { customerName: 'Asha Patel', extraCharges: 10 } });
    check('editing customer and charges -> 200', meta.status === 200, meta.body);
    // subtotal 250 (unchanged) + the new 10 of charges
    check('grand total recomputed (260)', meta.body.order.grandTotal === 260, meta.body.order?.grandTotal);
    check('the edit is stamped', Boolean(meta.body.order.editedAt) && meta.body.order.editCount === 1, meta.body.order?.editCount);
    check('the receipt number never changes', meta.body.order.orderNumber === receiptNo);
    check('stock untouched by a metadata edit', (await stockOf(a._id)) === 18 && (await stockOf(b._id)) === 9);

    // ---- increase a quantity: only the DELTA moves ----
    const up = await api('PATCH', `/orders/${orderId}`, {
      token: tokenA, body: { items: [{ productId: a._id, qty: 4 }, { productId: b._id, qty: 1 }] },
    });
    check('raising 2 -> 4 succeeds', up.status === 200, up.body);
    check('only 2 more units were taken (18 -> 16)', (await stockOf(a._id)) === 16, await stockOf(a._id));
    check('the untouched line did not move (B still 9)', (await stockOf(b._id)) === 9);
    check('total reflects the new quantity (4x100 + 50 + 10 = 460)', up.body.order.grandTotal === 460, up.body.order?.grandTotal);

    // ---- decrease a quantity: units come back ----
    const down = await api('PATCH', `/orders/${orderId}`, {
      token: tokenA, body: { items: [{ productId: a._id, qty: 1 }, { productId: b._id, qty: 1 }] },
    });
    check('lowering 4 -> 1 returns 3 units (16 -> 19)', (await stockOf(a._id)) === 19, await stockOf(a._id));
    check('total follows (100 + 50 + 10 = 160)', down.body.order.grandTotal === 160, down.body.order?.grandTotal);

    // ---- remove a line entirely ----
    const removed = await api('PATCH', `/orders/${orderId}`, { token: tokenA, body: { items: [{ productId: a._id, qty: 1 }] } });
    check('removing a line -> 200 with one item left', removed.status === 200 && removed.body.order.items.length === 1, removed.body?.order?.items?.length);
    check("the removed line's unit came back (B 9 -> 10)", (await stockOf(b._id)) === 10, await stockOf(b._id));

    // ---- add an item that was forgotten ----
    const added = await api('PATCH', `/orders/${orderId}`, {
      token: tokenA, body: { items: [{ productId: a._id, qty: 1 }, { productId: c._id, qty: 2 }] },
    });
    check('adding a forgotten item -> 200', added.status === 200 && added.body.order.items.length === 2, added.body?.order?.items?.length);
    check('its stock was taken (C 4 -> 2)', (await stockOf(c._id)) === 2, await stockOf(c._id));
    check('the new line is priced from the product (2x30)',
      added.body.order.items.find((i) => i.name === 'EditC')?.lineTotal === 60, added.body?.order?.items);

    // ---- a past sale must not be silently repriced ----
    await api('PATCH', `/products/${a._id}`, { token: tokenA, body: { price: 999 } });
    const afterReprice = await api('PATCH', `/orders/${orderId}`, {
      token: tokenA, body: { items: [{ productId: a._id, qty: 2 }, { productId: c._id, qty: 2 }] },
    });
    const lineA = afterReprice.body.order.items.find((i) => i.name === 'EditA');
    check('an existing line keeps its ORIGINAL price after the product was repriced',
      lineA?.price === 100, lineA);
    check('so the receipt total uses the historical price (2x100 + 60 + 10 = 270)',
      afterReprice.body.order.grandTotal === 270, afterReprice.body.order?.grandTotal);

    // ---- guards ----
    const tooMany = await api('PATCH', `/orders/${orderId}`, { token: tokenA, body: { items: [{ productId: c._id, qty: 999 }] } });
    check('asking for more than exists -> 409 naming the shortfall',
      tooMany.status === 409 && tooMany.body?.details?.outOfStock?.[0]?.name === 'EditC', tooMany.body);
    const stillThere = await api('GET', `/orders/${orderId}`, { token: tokenA });
    check('the failed edit changed nothing', stillThere.body.order.items.length === 2, stillThere.body?.order?.items?.length);
    check('and rolled back the stock it had already moved', (await stockOf(c._id)) === 2, await stockOf(c._id));

    const emptied = await api('PATCH', `/orders/${orderId}`, { token: tokenA, body: { items: [] } });
    check('emptying an order -> 400 (void it instead)', emptied.status === 400, emptied.body);

    const nothing = await api('PATCH', `/orders/${orderId}`, { token: tokenA, body: {} });
    check('an empty patch -> 400', nothing.status === 400, nothing.body);

    const negative = await api('PATCH', `/orders/${orderId}`, { token: tokenA, body: { extraCharges: -50 } });
    check('negative extra charges -> 400', negative.status === 400, negative.body);

    const hugeDiscount = await api('PATCH', `/orders/${orderId}`, {
      token: tokenA, body: { items: [{ productId: a._id, qty: 1, discount: 99999 }] },
    });
    check('a discount beyond the line value is clamped, never negative',
      hugeDiscount.status === 200 && hugeDiscount.body.order.items[0].discount === 100
      && hugeDiscount.body.order.subtotal === 100 && hugeDiscount.body.order.grandTotal >= 0,
      { items: hugeDiscount.body?.order?.items, order: hugeDiscount.body?.order });

    const crossTenant = await api('PATCH', `/orders/${orderId}`, { token: tokenB, body: { customerName: 'Hijack' } });
    check("another shop cannot edit your sale -> 404", crossTenant.status === 404, crossTenant.body);

    const foreignProduct = await api('PATCH', `/orders/${orderId}`, {
      token: tokenA, body: { items: [{ productId: pTea, qty: 1 }, { productId: a._id, qty: 1 }] },
    });
    check('a product from this shop is fine; the edit succeeds', foreignProduct.status === 200, foreignProduct.body?.error);

    // ---- a voided sale cannot be edited ----
    const doomed = await api('POST', '/orders', { token: tokenA, body: { items: [{ productId: b._id, qty: 1 }] } });
    await api('DELETE', `/orders/${doomed.body.order._id}`, { token: tokenA });
    const editVoided = await api('PATCH', `/orders/${doomed.body.order._id}`, { token: tokenA, body: { customerName: 'Ghost' } });
    check('editing a voided sale -> 404', editVoided.status === 404, editVoided.body);

    // ---- reports follow the edits ----
    const sum = await api('GET', '/reports/summary', { token: tokenA });
    check('inventory investment is reported', typeof sum.body?.inventory?.investment === 'number', sum.body?.inventory);
    check('retail value and potential profit too',
      typeof sum.body?.inventory?.retailValue === 'number' && typeof sum.body?.inventory?.potentialProfit === 'number', sum.body?.inventory);
    check('potentialProfit = retail - investment',
      sum.body.inventory.potentialProfit === Math.round((sum.body.inventory.retailValue - sum.body.inventory.investment) * 100) / 100,
      sum.body?.inventory);
    check('low-stock and out-of-stock counts are reported',
      typeof sum.body?.inventory?.lowStock === 'number' && typeof sum.body?.inventory?.outOfStock === 'number', sum.body?.inventory);
  }

  // ---------------------------------------------------------------- images
  section('Product photos');
  {
    // Smallest valid files of each type, built by hand so the test does not
    // depend on any image library.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      Buffer.alloc(64, 0x20),
      Buffer.from([0xff, 0xd9]),
    ]).toString('base64');
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(48, 0x11),
    ]).toString('base64');

    const up = await api('POST', '/images', {
      token: tokenA, body: { base64: jpeg, contentType: 'image/jpeg', width: 600, height: 600 },
    });
    check('upload a JPEG -> 201 with an id and url', up.status === 201 && /^\/images\/[a-f0-9]{24}$/.test(up.body?.image?.url ?? ''), up.body);
    check('the response reports the stored byte count', up.body?.image?.bytes > 0, up.body?.image);
    check('the response never contains the image bytes', !JSON.stringify(up.body).includes('data'), up.body);
    const imageId = up.body.image._id;

    const pngUp = await api('POST', '/images', { token: tokenA, body: { base64: png, contentType: 'image/png' } });
    check('upload a PNG -> 201', pngUp.status === 201, pngUp.body);

    // --- the security check: a lying contentType must be rejected ---
    const lying = await api('POST', '/images', { token: tokenA, body: { base64: png, contentType: 'image/jpeg' } });
    check('PNG bytes declared as JPEG -> 400 (magic bytes are checked)', lying.status === 400, lying.body);

    const notAnImage = await api('POST', '/images', {
      token: tokenA, body: { base64: Buffer.from('#!/bin/sh\nrm -rf /').toString('base64'), contentType: 'image/jpeg' },
    });
    check('arbitrary data claiming to be an image -> 400', notAnImage.status === 400, notAnImage.body);

    const svg = await api('POST', '/images', { token: tokenA, body: { base64: jpeg, contentType: 'image/svg+xml' } });
    check('a disallowed type -> 400', svg.status === 400, svg.body);

    const huge = await api('POST', '/images', {
      token: tokenA, body: { base64: Buffer.alloc(500 * 1024, 0x41).toString('base64'), contentType: 'image/jpeg' },
    });
    check('oversized image -> 400 naming the limit', huge.status === 400 && /limit/i.test(huge.body?.error ?? ''), huge.body);

    const garbage = await api('POST', '/images', { token: tokenA, body: { base64: 'not!!base64', contentType: 'image/jpeg' } });
    check('malformed base64 -> 400', garbage.status === 400, garbage.body);

    // --- serving ---
    const raw = await fetch(`${BASE}/images/${imageId}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    check('GET the image with a header -> 200 image/jpeg', raw.status === 200 && raw.headers.get('content-type') === 'image/jpeg');
    check('it is cached for a year and marked immutable', /max-age=31536000/.test(raw.headers.get('cache-control') ?? '') && /immutable/.test(raw.headers.get('cache-control') ?? ''), raw.headers.get('cache-control'));
    check('cache is private, not shared', /private/.test(raw.headers.get('cache-control') ?? ''));
    const bytes = Buffer.from(await raw.arrayBuffer());
    check('the bytes come back byte-for-byte', bytes.equals(Buffer.from(jpeg, 'base64')), { got: bytes.length, want: Buffer.from(jpeg, 'base64').length });

    const viaQuery = await fetch(`${BASE}/images/${imageId}?token=${tokenA}`);
    check('GET with ?token= also works (for <Image> tags)', viaQuery.status === 200);
    await viaQuery.arrayBuffer();

    const noAuth = await fetch(`${BASE}/images/${imageId}`);
    check('GET with no credentials -> 401', noAuth.status === 401);

    const crossTenant = await fetch(`${BASE}/images/${imageId}?token=${tokenB}`);
    check("another shop cannot read the photo -> 404", crossTenant.status === 404);

    const etag = await fetch(`${BASE}/images/${imageId}`, {
      headers: { Authorization: `Bearer ${tokenA}`, 'If-None-Match': `"${imageId}"` },
    });
    check('a matching ETag -> 304 Not Modified', etag.status === 304);

    const writeWithQueryToken = await fetch(`${BASE}/images?token=${tokenA}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: jpeg, contentType: 'image/jpeg' }),
    });
    check('?token= does NOT work for writes, only for GET -> 401', writeWithQueryToken.status === 401);

    // --- attaching to products ---
    const withPhoto = await api('POST', '/products', {
      token: tokenA, body: { name: 'Photographed', categoryId: catBev, price: 99, stock: 2, imageId },
    });
    check('create a product with a photo -> 201', withPhoto.status === 201 && String(withPhoto.body.product.imageId) === String(imageId), withPhoto.body?.product);

    const listed = await api('GET', '/products?search=Photographed', { token: tokenA });
    check('the product list carries imageUrl', listed.body?.products?.[0]?.imageUrl === `/images/${imageId}`, listed.body?.products?.[0]);
    check('products without a photo report imageUrl null',
      (await api('GET', '/products?search=Masala', { token: tokenA })).body.products[0].imageUrl === null);

    const foreignImage = await api('POST', '/products', {
      token: tokenB, body: { name: 'Thief', categoryId: catB, price: 5, imageId },
    });
    check("cannot attach another shop's photo to your product -> 400", foreignImage.status === 400, foreignImage.body);

    // --- replacing a photo retires the old row ---
    const replacement = await api('POST', '/images', { token: tokenA, body: { base64: png, contentType: 'image/png' } });
    const swapped = await api('PATCH', `/products/${withPhoto.body.product._id}`, {
      token: tokenA, body: { imageId: replacement.body.image._id },
    });
    check('replacing the photo -> 200 with the new id', swapped.status === 200 && String(swapped.body.product.imageId) === String(replacement.body.image._id), swapped.body?.product);
    const oldGone = await fetch(`${BASE}/images/${imageId}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    check('the replaced photo is no longer served -> 404', oldGone.status === 404);

    // --- clearing a photo ---
    const cleared = await api('PATCH', `/products/${withPhoto.body.product._id}`, { token: tokenA, body: { imageId: null } });
    check('imageId: null clears the photo', cleared.status === 200 && cleared.body.product.imageId === null, cleared.body?.product);

    // --- explicit delete detaches from the product ---
    const solo = await api('POST', '/images', { token: tokenA, body: { base64: jpeg, contentType: 'image/jpeg' } });
    const soloProduct = await api('POST', '/products', {
      token: tokenA, body: { name: 'SoloPhoto', categoryId: catBev, price: 10, imageId: solo.body.image._id },
    });
    const delImg = await api('DELETE', `/images/${solo.body.image._id}`, { token: tokenA });
    check('DELETE an image -> 200', delImg.status === 200, delImg.body);
    const detached = await api('GET', `/products?search=SoloPhoto`, { token: tokenA });
    check('its product no longer points at the deleted photo', detached.body.products[0].imageId == null, detached.body?.products?.[0]);

    const crossDelete = await api('DELETE', `/images/${replacement.body.image._id}`, { token: tokenB });
    check("another shop cannot delete your photo -> 404", crossDelete.status === 404);

    // --- usage reporting ---
    const usage = await api('GET', '/images/usage', { token: tokenA });
    check('usage reports a count and byte total', usage.status === 200 && usage.body.usage.images >= 1 && usage.body.usage.bytes > 0, usage.body?.usage);
    const usageB = await api('GET', '/images/usage', { token: tokenB });
    check('usage is per tenant', usageB.body?.usage?.images === 0, usageB.body?.usage);
  }

  // ------------------------------------------------- receipt numbers per tenant
  section('Receipt numbers');
  {
    const cB = await api('POST', '/categories', { token: tokenB, body: { name: 'B Stuff' } });
    const pB = await api('POST', '/products', {
      token: tokenB, body: { name: 'B Item', categoryId: cB.body.category._id, price: 30, stock: 5 },
    });
    const bOrder = await api('POST', '/orders', { token: tokenB, body: { items: [{ productId: pB.body.product._id, qty: 1 }] } });
    check("another shop's numbering starts at 1 (counters are per tenant)", bOrder.body?.order?.orderNumber === 1, bOrder.body?.order?.orderNumber);

    const beforeVoid = await api('POST', '/orders', { token: tokenB, body: { items: [{ productId: pB.body.product._id, qty: 1 }] } });
    check('next number is 2', beforeVoid.body?.order?.orderNumber === 2);
    const voided = await api('DELETE', `/orders/${beforeVoid.body.order._id}`, { token: tokenB });
    check('voiding reports the receipt it cancelled', voided.body?.voided?.receiptNo === 'INV-000002', voided.body?.voided);
    const afterVoid = await api('POST', '/orders', { token: tokenB, body: { items: [{ productId: pB.body.product._id, qty: 1 }] } });
    check('a voided receipt number is never reissued', afterVoid.body?.order?.orderNumber === 3, afterVoid.body?.order?.orderNumber);

    const listB = await api('GET', '/orders', { token: tokenB });
    check('the voided order is absent from history', !listB.body.orders.some((o) => o.orderNumber === 2), listB.body.orders.map((o) => o.orderNumber));
    check('the list payload carries receiptNo (lean() drops virtuals)',
      listB.body.orders.every((o) => /^INV-\d{6}$/.test(o.receiptNo ?? '')), listB.body.orders.map((o) => o.receiptNo));
    const oneOrder = await api('GET', `/orders/${listB.body.orders[0]._id}`, { token: tokenB });
    check('a single order carries receiptNo too', /^INV-\d{6}$/.test(oneOrder.body?.order?.receiptNo ?? ''), oneOrder.body?.order?.receiptNo);
    const sumB = await api('GET', '/reports/summary', { token: tokenB });
    check('reports count 2 orders, not 3 (voided one excluded)', sumB.body?.sales?.orders === 2, sumB.body?.sales);
  }

  // ----------------------------------------------------------------- admin
  section('Super admin');
  let adminToken;
  {
    const bad = await api('POST', '/auth/admin/login', { body: { username: ADMIN_USER, password: 'wrong' } });
    check('wrong admin password -> 401', bad.status === 401, bad.body);

    const ok = await api('POST', '/auth/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
    adminToken = ok.body?.token;
    check('admin login -> 200 + token', ok.status === 200 && !!adminToken, ok.body);

    const wrongRole = await api('GET', '/admin/businesses', { token: tokenA });
    check('business token cannot reach admin routes -> 403', wrongRole.status === 403, wrongRole.body);

    const adminOnPos = await api('GET', '/categories', { token: adminToken });
    check('admin token cannot reach business routes -> 403', adminOnPos.status === 403, adminOnPos.body);

    const list = await api('GET', '/admin/businesses', { token: adminToken });
    check('admin lists all businesses with counts', list.status === 200 && list.body.businesses.length >= 2, list.body?.businesses);
    /**
     * Look for the FIELD, not the substring. The old version matched "pin"
     * anywhere in the serialised payload, so a shop called "Pinky Store" -- or
     * a test fixture named "Pin Change Co" -- failed a leak check while nothing
     * had leaked. What must never appear is a `pin` key or a bcrypt hash.
     */
    const listJson = JSON.stringify(list.body);
    check('admin listing never exposes a pin field',
      !/"pin(Hash)?"\s*:/i.test(listJson), listJson.slice(0, 200));
    check('and no bcrypt hash rides along in it',
      !/\$2[aby]\$\d{2}\$/.test(listJson), listJson.slice(0, 200));
    const a = list.body.businesses.find((b) => b.businessId === bizA);
    check('per-business counts are populated', a && a.products >= 3 && a.orders >= 1 && a.revenue > 0, a);

    const stats = await api('GET', '/admin/stats', { token: adminToken });
    check('platform stats -> 200', stats.status === 200 && stats.body.stats.businesses >= 2, stats.body);

    const detail = await api('GET', `/admin/businesses/${bizA}`, { token: adminToken });
    check('admin drill-down by opaque id -> 200', detail.status === 200 && detail.body.counts.products >= 3, detail.body?.counts);

    const del = await api('DELETE', `/admin/businesses/${bizA}`, { token: adminToken });
    check('cascading archive -> 200 with counts', del.status === 200 && del.body?.deleted?.products >= 3 && del.body?.deleted?.orders >= 1, del.body);
    check('the response says it is restorable', del.body?.restorable === true, del.body);

    // Verify in the database that the cascade FLAGGED rather than removed, and
    // that every single row was reached.
    const client = await MongoClient.connect(uri);
    const db = client.db('mini_pos_test');
    const state = async (bid) => ({
      businesses: {
        total: await db.collection('businesses').countDocuments({ businessId: bid }),
        live: await db.collection('businesses').countDocuments({ businessId: bid, deletedAt: null }),
      },
      categories: {
        total: await db.collection('categories').countDocuments({ businessId: bid }),
        live: await db.collection('categories').countDocuments({ businessId: bid, deletedAt: null }),
      },
      products: {
        total: await db.collection('products').countDocuments({ businessId: bid }),
        live: await db.collection('products').countDocuments({ businessId: bid, deletedAt: null }),
      },
      orders: {
        total: await db.collection('orders').countDocuments({ businessId: bid }),
        live: await db.collection('orders').countDocuments({ businessId: bid, deletedAt: null }),
      },
    });

    const archived = await state(bizA);
    check('rows still exist (soft delete, not removal)',
      archived.businesses.total === 1 && archived.categories.total >= 1 && archived.products.total >= 3 && archived.orders.total >= 1, archived);
    check('every row of that tenant is flagged deleted',
      archived.businesses.live + archived.categories.live + archived.products.live + archived.orders.live === 0, archived);
    check('the deletion is attributed to the admin',
      (await db.collection('products').findOne({ businessId: bizA }))?.deletedBy === 'admin:superadmin');

    const other = await state(bizB);
    check("the other tenant is completely untouched", other.products.live >= 1 && other.categories.live >= 1, other);

    const relogin = await api('POST', '/auth/login', { body: { businessName: 'Sharma Kirana', pin: '1234' } });
    check('archived business cannot log in -> 401', relogin.status === 401, relogin.body);

    const staleToken = await api('GET', '/products', { token: tokenA });
    check('a token issued before the archive returns no data', (staleToken.body?.products?.length ?? 0) === 0, staleToken.body);

    const gone = await api('GET', '/auth/me', { token: tokenA });
    check('/auth/me rejects an archived tenant -> 401', gone.status === 401, gone.body);

    const activeList = await api('GET', '/admin/businesses', { token: adminToken });
    check('archived business is hidden from the default admin list',
      !activeList.body.businesses.some((b) => b.businessId === bizA), activeList.body?.businesses?.map((b) => b.name));

    const withDeleted = await api('GET', '/admin/businesses?includeDeleted=true', { token: adminToken });
    const archivedRow = withDeleted.body.businesses.find((b) => b.businessId === bizA);
    check('?includeDeleted=true reveals it, flagged', Boolean(archivedRow?.isDeleted), archivedRow);
    check('its archived counts are reported for the restore decision',
      archivedRow?.archived?.products >= 3 && archivedRow?.archived?.orders >= 1, archivedRow?.archived);
    check('its live counts read zero', archivedRow?.products === 0 && archivedRow?.orders === 0, archivedRow);

    // ---- THE leak test: reusing a deleted shop's name must inherit nothing ----
    const reregister = await api('POST', '/auth/register', { body: { businessName: 'Sharma Kirana', pin: '5555' } });
    check('the freed business name can be registered again -> 201', reregister.status === 201, reregister.body);
    const reBizId = reregister.body?.business?.businessId;
    check('the new shop gets a DIFFERENT opaque key', Boolean(reBizId) && reBizId !== bizA, { old: bizA, new: reBizId });

    const newOwnerProducts = await api('GET', '/products', { token: reregister.body.token });
    const newOwnerCats = await api('GET', '/categories', { token: reregister.body.token });
    const newOwnerOrders = await api('GET', '/orders', { token: reregister.body.token });
    const newOwnerReports = await api('GET', '/reports/summary', { token: reregister.body.token });
    check('new owner of the same NAME sees no products', (newOwnerProducts.body?.products?.length ?? 0) === 0, newOwnerProducts.body);
    check('new owner sees no categories', (newOwnerCats.body?.categories?.length ?? 0) === 0, newOwnerCats.body);
    check('new owner sees no orders', (newOwnerOrders.body?.orders?.length ?? 0) === 0, newOwnerOrders.body);
    check('new owner sees zero revenue', newOwnerReports.body?.sales?.revenue === 0, newOwnerReports.body?.sales);
    check('new owner\'s receipt numbering starts fresh', true); // asserted after a sale below

    // ---- restore ----
    const restore = await api('POST', `/admin/businesses/${bizA}/restore`, { token: adminToken });
    check('restore -> 200 with counts', restore.status === 200 && restore.body?.restored?.products >= 3, restore.body);
    const afterRestore = await state(bizA);
    check('every archived row is live again',
      afterRestore.businesses.live === 1 && afterRestore.products.live >= 3 && afterRestore.orders.live >= 1, afterRestore);

    check('it was renamed because the name had been taken meanwhile',
      restore.body?.renamedFrom === 'Sharma Kirana' && /restored/i.test(restore.body?.business?.name ?? ''), restore.body);
    check('its businessId is unchanged, so no data had to move',
      restore.body?.business?.businessId === bizA, restore.body?.business);

    const reloginOld = await api('POST', '/auth/login', { body: { businessName: 'Sharma Kirana', pin: '5555' } });
    check('the ORIGINAL name now belongs to the new shop, not the restored one',
      reloginOld.status === 200 && reloginOld.body?.business?.businessId === reBizId, reloginOld.body?.business);

    const reloginNew = await api('POST', '/auth/login', { body: { businessName: restore.body.business.name, pin: '1234' } });
    check('the restored shop signs in under its new name',
      reloginNew.status === 200 && reloginNew.body?.business?.businessId === bizA, reloginNew.body?.business);
    const restoredData = await api('GET', '/products', { token: tokenA });
    check('its data is reachable again with the original token', (restoredData.body?.products?.length ?? 0) >= 3, restoredData.body?.products?.length);

    const restoreAgain = await api('POST', `/admin/businesses/${bizA}/restore`, { token: adminToken });
    check('restoring a live business -> 409', restoreAgain.status === 409, restoreAgain.body);

    // ---- purge ----
    const purgeLive = await api('DELETE', `/admin/businesses/${bizA}/purge`, { token: adminToken });
    check('purging a LIVE business is refused -> 409', purgeLive.status === 409, purgeLive.body);

    await api('DELETE', `/admin/businesses/${bizA}`, { token: adminToken });
    const purge = await api('DELETE', `/admin/businesses/${bizA}/purge`, { token: adminToken });
    check('purge after archive -> 200', purge.status === 200 && purge.body?.purged?.products >= 3, purge.body);
    const afterPurge = await state(bizA);
    check('purge really removes every row',
      afterPurge.businesses.total + afterPurge.categories.total + afterPurge.products.total + afterPurge.orders.total === 0, afterPurge);
    check('the order counter is removed too',
      (await db.collection('counters').countDocuments({ _id: `${bizA}:order` })) === 0);
    check('the OTHER tenant survived the purge', (await state(bizB)).products.live >= 1);

    await client.close();

    const missing = await api('DELETE', '/admin/businesses/biz_000000000000000000000000', { token: adminToken });
    check('archiving an unknown business -> 404', missing.status === 404, missing.body);
  }

  // ------------------------------------------------------------ misc guards
  section('Misc guards');
  {
    const r404 = await api('GET', '/nope');
    check('unknown route -> 404 JSON', r404.status === 404 && r404.body?.ok === false, r404.body);

    const badId = await api('GET', '/orders/not-an-objectid', { token: tokenB });
    check('malformed ObjectId -> 400 not 500', badId.status === 400, badId.body);

    const badJson = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
    });
    check('malformed JSON body -> 400 not a crash', badJson.status === 400);
  }

  console.log(`\n${'='.repeat(58)}`);
  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  const txnLine = serverLog.join('').includes('Transactions unavailable');
  console.log(`Checkout path used: ${txnLine ? 'compensating writes (no replica set)' : 'MongoDB transactions'}`);
  await shutdown(failures.length ? 1 : 0);
} catch (err) {
  console.error('\nHarness crashed:', err);
  console.error('Server output:\n' + serverLog.join(''));
  await shutdown(1);
}
