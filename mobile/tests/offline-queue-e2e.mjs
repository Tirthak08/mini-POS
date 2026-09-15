/**
 * Selling with the network cut, through the real screens.
 *
 * The cut is real: every request to the API is aborted at the transport with
 * ERR_INTERNET_DISCONNECTED, exactly as it fails on a phone that has lost data
 * or against a backend that has gone to sleep. Nothing is mocked -- the app
 * makes real requests that really fail, queues real sales to real storage, and
 * really replays them when the connection returns.
 *
 * Only the API is cut, not the whole browser. `context.setOffline` would also
 * stop the page itself from loading, and the moment that matters most here is
 * the app being KILLED AND REOPENED with no signal: on a phone the app comes
 * back from local storage, which a browser that cannot fetch its own HTML
 * cannot imitate.
 *
 * The two properties worth the whole feature:
 *   1. a sale rung up offline is never lost, and
 *   2. it is never recorded twice, however many times it is sent.
 *
 * Needs the API on :5000 and `npx expo export --platform web` served on :8099.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';

const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && m !== 'GET' && { body: JSON.stringify(body) }),
})).json();
const get = (p, t) => req(p, null, t, 'GET');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 350) : ''}`));
};

const shop = 'Offline ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Grain' }, token)).category;
const mk = async (n, stock, price) =>
  (await req('/products', { name: n, categoryId: cat._id, price, cost: price / 2, stock }, token)).product;
const rice = await mk('Rice', 50, 60);
const soap = await mk('Soap', 30, 25);
const ghee = await mk('Ghee', 2, 400);

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

let apiDown = false;
await page.route('**/api/**', (route) => (
  apiDown ? route.abort('internetdisconnected') : route.continue()
));
const goOffline = async () => { apiDown = true; };
const goOnline = async () => { apiDown = false; };
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);
const tap = async (name, { exact = true } = {}) =>
  page.getByRole('button', { name, exact }).last().click();
const tapTab = async (name) =>
  page.locator('[role="tab"]').filter({ hasText: name }).last().click();

const waitForText = async (re, ms = 12000) => {
  const until = Date.now() + ms;
  let seen = '';
  while (Date.now() < until) {
    seen = await body();
    if (re.test(seen)) return { ok: true, seen };
    await page.waitForTimeout(200);
  }
  return { ok: false, seen };
};

/**
 * Rings up one product. `expect` is polled for immediately after the tap,
 * because a toast is transient: a fixed wait long enough for a slow checkout is
 * also long enough for the message to have gone, which reads as the app having
 * said nothing when it did.
 */
const sell = async (productName, expect) => {
  await tapTab('Sell');
  await page.waitForTimeout(1400);
  await tap(`ADD ${productName}`);
  await page.waitForTimeout(700);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1500);
  await tap('Complete order', { exact: false });
  const seen = expect ? await waitForText(expect) : { ok: true, seen: '' };
  await page.waitForTimeout(1500);
  await tap('Done', { exact: false }).catch(() => {});
  await page.waitForTimeout(1000);
  return seen;
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ============ 1. a sale with the network cut still completes ============ */
  console.log('\n=== the network goes, the customer does not ===');
  await goOffline();
  const saved = await sell('Rice', /Saved on this phone/);
  check('the sale completes anyway, and says so', saved.ok, saved.seen.slice(0, 400));
  check('  and the cart is cleared, ready for the next customer',
    !/Complete order/.test(await body()), (await body()).slice(0, 300));

  const banner = await body();
  check('the phone says it is holding it', /1 sales waiting to sync/.test(banner), banner.slice(0, 500));
  check('  and how much money that is', /₹60/.test(banner), banner.slice(0, 500));

  /* ============ 2. the shelf reflects it immediately ============ */
  console.log('\n=== the grid does not sell the same stock twice ===');
  await tapTab('Sell');
  await page.waitForTimeout(1600);
  const grid = await body();
  check('the rice on screen has already come down', /49 left/.test(grid), grid.slice(0, 600));

  /* ============ 3. more sales pile up, and survive a restart ============ */
  console.log('\n=== a second sale, and then the app is killed ===');
  await sell('Soap', /Saved on this phone/);
  await page.waitForTimeout(800);
  check('both are held', /2 sales waiting to sync/.test(await body()), (await body()).slice(0, 500));

  check('nothing has reached the server', (await get('/orders', token)).orders === undefined
    || (await get('/orders', token)).orders.length === 0,
  (await get('/orders', token)).orders?.length);

  // A reload with the network still down is the app being killed and reopened
  // in a shop with no signal -- the exact moment the queue has to survive.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const afterRestart = await body();
  check('the queue survived the app being killed',
    /2 sales waiting to sync/.test(afterRestart), afterRestart.slice(0, 500));

  /* ==================== 4. the network comes back ==================== */
  console.log('\n=== the network comes back ===');
  await goOnline();
  await page.waitForTimeout(1200);

  await tap('Sync now');
  const synced = await waitForText(/2 sales synced/, 20000);
  check('both sales sync', synced.ok, synced.seen.slice(0, 400));
  check('  and the banner goes away',
    !/sales waiting to sync/.test(await body()), (await body()).slice(0, 400));

  const orders = (await get('/orders', token)).orders;
  check('the server now holds both', orders.length === 2, orders.length);
  check('  each with a receipt number',
    orders.every((o) => o.orderNumber > 0), orders.map((o) => o.orderNumber));
  check('  and they are different sales',
    new Set(orders.map((o) => o.orderNumber)).size === 2, orders.map((o) => o.orderNumber));

  const products = (await get('/products', token)).products;
  check('the stock the server holds matches the screen',
    products.find((p) => p.name === 'Rice').stock === 49
      && products.find((p) => p.name === 'Soap').stock === 29,
    products.map((p) => [p.name, p.stock]));

  /* ============ 5. syncing twice does not sell twice ============ */
  console.log('\n=== the sale cannot be recorded twice ===');
  await tapTab('Sell');
  await page.waitForTimeout(1500);
  const again = (await get('/orders', token)).orders;
  check('a second sync has nothing to send and changes nothing',
    again.length === 2, again.length);

  /* ======= 6. a queued sale the server will refuse when it drains ======= */
  console.log('\n=== a sale the shelf can no longer cover ===');
  await goOffline();
  await sell('Ghee', /Saved on this phone/);
  await page.waitForTimeout(800);
  check('it is taken like any other', /1 sales waiting to sync/.test(await body()),
    (await body()).slice(0, 400));

  // Sold out from under it, the way a second phone or a correction would.
  await goOnline();
  await req(`/products/${ghee._id}/stock`, { set: 0 }, token, 'PATCH');

  await tap('Sync now');
  const refused = await waitForText(/could not be saved/, 20000);
  check('the queue says it was refused rather than retrying forever',
    refused.ok, refused.seen.slice(0, 500));

  await page.waitForTimeout(1200);
  await tap('1 sales could not be saved', { exact: false });
  await page.waitForTimeout(1000);
  const detail = await body();
  check('  and says why, in the server\'s own words',
    /stock/i.test(detail), detail.slice(0, 800));
  check('  offering both a retry and a discard',
    /Try again/.test(detail) && /Discard/.test(detail), detail.slice(0, 800));

  const stillTwo = (await get('/orders', token)).orders;
  check('  and it was NOT recorded', stillTwo.length === 2, stillTwo.length);

  /* ============ 7. restock, retry, and it goes through ============ */
  console.log('\n=== restock it and the sale goes through ===');
  await req(`/products/${ghee._id}/stock`, { set: 5 }, token, 'PATCH');
  await tap('Try again', { exact: false });
  await page.waitForTimeout(1200);
  await tap('Sync now');
  const finallyOk = await waitForText(/1 sales synced/, 20000);
  check('the retry succeeds', finallyOk.ok, finallyOk.seen.slice(0, 400));

  const finalOrders = (await get('/orders', token)).orders;
  check('  and the sale is finally recorded', finalOrders.length === 3, finalOrders.length);
  check('  exactly once', new Set(finalOrders.map((o) => o.orderNumber)).size === 3,
    finalOrders.map((o) => o.orderNumber));
  check('  the ghee stock is right', (await get('/products', token)).products
    .find((p) => p.name === 'Ghee').stock === 4,
  (await get('/products', token)).products.find((p) => p.name === 'Ghee').stock);
  check('the banner is gone for good', !/waiting to sync|could not be saved/.test(await body()),
    (await body()).slice(0, 400));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

await goOnline();
check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
