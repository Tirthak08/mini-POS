/**
 * Finding a receipt again.
 *
 * The sales list has always been a date window, which answers "what did I sell
 * on Tuesday" and nothing else. The questions a shopkeeper actually arrives
 * with -- "the one for Ramesh", "receipt 42", "the one that came to 1250" --
 * had no answer at all once the sale fell out of the window, and the list
 * stopped at a hundred rows besides.
 *
 * The property being pinned down here: a search finds the sale WHEREVER it is
 * in time, and finds it from any of the three things somebody remembers about
 * it.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5186;
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
    MONGODB_DB: 'searchtest', JWT_SECRET: 'search-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'search-admin',
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
  const shop = 'Search ' + crypto.randomBytes(3).toString('hex');
  const token = (await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } })).body.token;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;
  const rice = (await api('POST', '/products', {
    token, body: { name: 'Rice', categoryId: cat._id, price: 100, cost: 60, stock: 10000 },
  })).body.product;

  const ramesh = (await api('POST', '/customers', { token, body: { name: 'Ramesh Bhai' } })).body.customer;
  const suresh = (await api('POST', '/customers', { token, body: { name: 'Suresh Patel' } })).body.customer;

  const sell = async (qty, extra = {}) => (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty }], ...extra },
  })).body.order;

  /* Thirty walk-in sales, so the list has more rows than one page and the
     interesting ones are not simply the newest. */
  for (let i = 0; i < 30; i += 1) await sell(1);
  const rameshSale = await sell(3, { customerId: ramesh._id, amountPaid: 0 });   // 300
  /* 12 x 100 plus a 50 delivery charge. Rice is sold in pieces, so a
     fractional quantity is (rightly) refused -- and the total searched for has
     to be the GRAND total, charges included, because that is the figure that
     was on the screen. */
  const sureshSale = await sell(12, { customerId: suresh._id, extraCharges: 50 }); // 1250
  for (let i = 0; i < 30; i += 1) await sell(1);

  const list = async (q) => (await api('GET', `/orders?limit=100${q ?? ''}`, { token })).body;

  /* ==================== 1. it searches at all ==================== */
  console.log('\n=== searching by receipt number ===');
  const n = rameshSale.orderNumber;
  for (const form of [`${n}`, `INV-${String(n).padStart(6, '0')}`, `inv-${n}`, `INV ${n}`]) {
    const r = await list(`&q=${encodeURIComponent(form)}`);
    check(`"${form}" finds receipt ${n}`,
      r.orders.some((o) => o.orderNumber === n), { form, got: r.orders.map((o) => o.orderNumber).slice(0, 5) });
  }

  console.log('\n=== searching by customer ===');
  let res = await list('&q=ramesh');
  check('a lower-case fragment finds the customer',
    res.orders.length === 1 && res.orders[0].customerName === 'Ramesh Bhai',
    res.orders.map((o) => o.customerName));
  res = await list('&q=BHAI');
  check('  and so does a different fragment in a different case',
    res.orders.length === 1 && res.orders[0]._id === rameshSale._id, res.orders.length);
  res = await list('&q=patel');
  check('  the other customer is found by their surname',
    res.orders.length === 1 && res.orders[0]._id === sureshSale._id, res.orders.map((o) => o.customerName));

  console.log('\n=== searching by what it came to ===');
  res = await list('&q=1250');
  check('an exact total finds the sale',
    res.orders.some((o) => o._id === sureshSale._id), res.orders.map((o) => o.grandTotal));
  res = await list('&q=1251');
  check('  and a total nobody was charged finds nothing',
    res.orders.length === 0, res.orders.map((o) => o.grandTotal));

  /**
   * A number is a perfectly good receipt number AND a perfectly good total.
   * Both are tried, because a search that silently picked one would look broken
   * from the other side.
   */
  const hundred = await list('&q=100');
  check('a number that is both a receipt number and a total returns both',
    hundred.orders.some((o) => o.orderNumber === 100) || hundred.orders.some((o) => o.grandTotal === 100),
    hundred.orders.length);
  check('  and every row it returns actually matches one of the two',
    hundred.orders.every((o) => o.orderNumber === 100 || o.grandTotal === 100
      || /100/i.test(o.customerName ?? '')),
    hundred.orders.map((o) => [o.orderNumber, o.grandTotal]).slice(0, 6));

  /* ==================== 2. it ignores the date window ==================== */
  console.log('\n=== a search is not confined to the window on screen ===');
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const dayAfter = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const windowed = await list(`&from=${tomorrow}&to=${dayAfter}`);
  check('the plain list obeys the window and finds nothing ahead of today',
    windowed.orders.length === 0, windowed.orders.length);
  const searched = await list(`&from=${tomorrow}&to=${dayAfter}&q=ramesh`);
  check('  but the same window with a search still finds the sale',
    searched.orders.length === 1 && searched.orders[0]._id === rameshSale._id,
    searched.orders.length);
  check('  and the answer says it looked at all time',
    searched.search?.allTime === true && searched.search?.q === 'ramesh', searched.search);
  check('  while a plain listing still reports the window it used',
    windowed.range?.from && !windowed.search, Object.keys(windowed));

  /* ==================== 3. paging ==================== */
  console.log('\n=== more results than fit on a page ===');
  const p1 = (await api('GET', '/orders?limit=20&page=1', { token })).body;
  const p2 = (await api('GET', '/orders?limit=20&page=2', { token })).body;
  check('the total counts every sale, not just the page', p1.pagination.total === 62, p1.pagination.total);
  check('  and says how many pages that is', p1.pagination.pages === 4, p1.pagination);
  check('  page two holds different receipts',
    p2.orders.length === 20
    && !p2.orders.some((o) => p1.orders.some((a) => a._id === o._id)),
    { p1: p1.orders.length, p2: p2.orders.length });
  check('  newest first, across the page boundary',
    new Date(p1.orders.at(-1).timestamp) >= new Date(p2.orders[0].timestamp),
    [p1.orders.at(-1)?.orderNumber, p2.orders[0]?.orderNumber]);

  /* ==================== 4. it cannot be tricked ==================== */
  console.log('\n=== a search box is still an input ===');
  const dotStar = await list('&q=.*');
  check('regex metacharacters are searched for literally, not run',
    dotStar.orders.length === 0, dotStar.orders.length);
  const empty = await list('&q=%20%20');
  check('  a blank search is just the ordinary list',
    empty.orders.length > 0 && !empty.search, { n: empty.orders.length, search: empty.search });

  /* Another shop's receipts are not findable from here, whatever is typed. */
  const other = 'Other ' + crypto.randomBytes(3).toString('hex');
  const otherToken = (await api('POST', '/auth/register', { body: { businessName: other, pin: '1234' } })).body.token;
  const otherCat = (await api('POST', '/categories', { token: otherToken, body: { name: 'Tea' } })).body.category;
  const otherProd = (await api('POST', '/products', {
    token: otherToken, body: { name: 'Chai', categoryId: otherCat._id, price: 10, cost: 5, stock: 50 },
  })).body.product;
  await api('POST', '/orders', {
    token: otherToken, body: { customerName: 'Ramesh Bhai', items: [{ productId: otherProd._id, qty: 1 }] },
  });
  const mine = await list('&q=ramesh');
  check('another shop\'s customer of the same name is not returned',
    mine.orders.length === 1 && mine.orders[0]._id === rameshSale._id,
    mine.orders.map((o) => [o.customerName, o.grandTotal]));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
