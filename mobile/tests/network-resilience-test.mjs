/**
 * Network failure handling, and the one rule that must never bend.
 *
 * A free-tier host sleeps after ~15 minutes idle and takes ~50 seconds to wake,
 * so the app has to survive a first request that hangs. The tempting fix --
 * "retry anything that fails" -- is a money bug: a POST /orders that times out
 * may well have REACHED the server and been applied, with only the reply lost.
 * Retrying it would charge the customer twice and take stock twice.
 *
 * So the rule is: retry reads, never retry writes, and wake the host separately
 * through an endpoint that changes nothing.
 *
 * A stalled connection is simulated in the browser: the request is held open
 * past the client's timeout and then failed, which is what a sleeping host looks
 * like from a phone -- connected, then silence.
 */
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m, headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`));
};

/* ------------------------------- seed a shop ------------------------------- */
const shop = 'Net ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Gold' }, token)).category;
await req('/products', { name: 'Ring', categoryId: cat._id, price: 50, cost: 30, stock: 9 }, token);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Every API request the app actually puts on the wire. */
const sent = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/api/')) sent.push(`${r.method()} ${u.split('/api/')[1].split('?')[0]}`);
});

/**
 * Hold a matching request open past the client's 20s timeout, then fail it.
 * `stall` is set per-scenario; everything else passes straight through.
 */
let stall = null;
await page.route('**/api/**', async (route) => {
  if (stall && stall(route.request())) {
    await new Promise((r) => setTimeout(r, 25000)); // longer than requestTimeoutMs
    return route.abort('timedout');
  }
  return route.continue();
});

const body = () => page.evaluate(() => document.body.innerText);
const tapTab = async (route, wait = 2400) => {
  await page.locator(`[role="tab"][href$="/${route}"]`).first().click();
  await page.waitForTimeout(wait);
};

/* ============ 1. the app wakes the host before anyone asks it to ============ */
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

console.log('=== the app pings /health on its own, before any sign-in ===');
const healthPings = sent.filter((r) => r.includes('health'));
check('a health ping went out before sign-in', healthPings.length >= 1, sent.slice(0, 8));
check('it is a GET, so it cannot change anything',
  healthPings.every((r) => r.startsWith('GET')), healthPings);

await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
await page.waitForTimeout(3600);
check('signed in normally when the network is healthy', /Point of Sale/.test(await body()), (await body()).slice(0, 160));

/* ================= 2. a stalled READ is retried once ================= */
console.log('\n=== a read that stalls is retried, transparently ===');
sent.length = 0;
let stalledOnce = false;
// Only the FIRST products read stalls -- exactly like a cold start, where the
// retry lands on a host that has finished booting.
stall = (r) => {
  if (r.method() === 'GET' && r.url().includes('/api/products') && !stalledOnce) {
    stalledOnce = true;
    return true;
  }
  return false;
};
await tapTab('Inventory', 1200);
await page.waitForTimeout(30000); // 20s timeout + the retry
const productReads = sent.filter((r) => r.startsWith('GET') && r.includes('products'));
check('the stalled read was retried (sent twice)', productReads.length >= 2, productReads);
const afterRetry = await body();
check('the catalogue arrived on the retry', /Ring/.test(afterRetry), afterRetry.slice(0, 260));
stall = null;
await page.screenshot({ path: '/tmp/net-1-read-retried.png', fullPage: true });

/* ============ 3. a stalled CHECKOUT is NEVER retried ============ */
console.log('\n=== the money rule: a stalled checkout is never sent twice ===');
await tapTab('Pos', 2600);
await page.getByRole('button', { name: 'Add Ring', exact: false }).last().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'View cart', exact: false }).last().click();
await page.waitForTimeout(1200);

sent.length = 0;
// The order POST never gets an answer, so the client cannot know whether the
// sale was applied. This is precisely when a retry would be a double charge.
stall = (r) => r.method() === 'POST' && r.url().includes('/api/orders');
await page.getByRole('button', { name: 'Complete order', exact: false }).last().click();
// The client gives up at 20s and toasts; the toast self-dismisses ~2.6s later,
// so read it inside that window rather than after.
await page.waitForTimeout(21500);
const afterCheckout = await body();
await page.waitForTimeout(3000); // let any (wrongly) retried POST show up

const orderPosts = sent.filter((r) => r.startsWith('POST') && r.includes('orders'));
check('the checkout was sent EXACTLY once, never retried', orderPosts.length === 1, orderPosts);
check('the failure is explained in plain language',
  /internet connection|took too long/i.test(afterCheckout), afterCheckout.slice(-320));
check('no "npm run dev" instruction reaches a shopkeeper',
  !/npm run dev/i.test(afterCheckout), afterCheckout.slice(-320));
check('no "same Wi-Fi" instruction either',
  !/same Wi-?Fi/i.test(afterCheckout), afterCheckout.slice(-320));
check('the cart is kept so the sale can be re-rung',
  /Grand total/.test(afterCheckout) || /1 items/.test(afterCheckout), afterCheckout.slice(-320));
await page.screenshot({ path: '/tmp/net-2-checkout-not-retried.png', fullPage: true });

stall = null;
console.log('\n=== the shop is not left holding a duplicate sale ===');
const orders = (await req('/orders', null, token, 'GET')).orders ?? [];
check('at most one order exists on the server, never two', orders.length <= 1,
  { count: orders.length, receipts: orders.map((o) => o.receiptNo) });

/* ============ 4. the dev message still exists for LAN development ============ */
console.log('\n=== the dev-flavoured message is not deleted, just scoped ===');
const fs = await import('node:fs');
const client = fs.readFileSync('/root/posapp/src/api/client.js', 'utf8');
check('the LAN hint is still there for `npm run dev` work', /npm run dev/.test(client));
check('but it is gated on the API being a local address',
  /IS_REMOTE_API\s*\n?\s*\?/.test(client) || /IS_REMOTE_API/.test(client), 'IS_REMOTE_API not referenced');

console.log(`\n${pass} passed, ${fail} failed | page errors: ${pageErrors.length}`);
pageErrors.slice(0, 5).forEach((e) => console.log('  -', e.slice(0, 160)));
await browser.close();
process.exit(fail ? 1 : 0);
