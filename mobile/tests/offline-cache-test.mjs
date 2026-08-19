/**
 * The offline catalogue cache (PRD 1, "offline-capable").
 *
 * Two properties, and the second matters far more than the first:
 *
 *   1. USEFUL — after one online visit, the catalogue survives a restart and
 *      renders with the backend unreachable, labelled as a saved copy rather
 *      than passed off as live.
 *
 *   2. SAFE — the cache never crosses tenants. A shared phone is the normal
 *      case for a family shop, so signing in as a different business must never
 *      show the previous business's products, not even for the instant before
 *      the first fetch lands. The API cannot defend this: it never sees a read
 *      of local cache.
 *
 * Offline is simulated by routing the API origin to a dead end, which is closer
 * to real patchy data than stopping the server would be: DNS still resolves,
 * requests just never arrive.
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

/* ------------------------------ two tenants ------------------------------ */
const shopA = 'CacheA ' + crypto.randomBytes(3).toString('hex');
const shopB = 'CacheB ' + crypto.randomBytes(3).toString('hex');
const tokenA = (await req('/auth/register', { businessName: shopA, pin: '1111' })).token;
const tokenB = (await req('/auth/register', { businessName: shopB, pin: '2222' })).token;

const catA = (await req('/categories', { name: 'AlphaCat' }, tokenA)).category;
const catB = (await req('/categories', { name: 'BetaCat' }, tokenB)).category;
await req('/products', { name: 'AlphaWidget', categoryId: catA._id, price: 100, cost: 60, stock: 7 }, tokenA);
await req('/products', { name: 'BetaGadget', categoryId: catB._id, price: 250, cost: 150, stock: 4 }, tokenB);

/* --------------------------- one browser context ------------------------- */
// A persistent context is the point: localStorage (which AsyncStorage maps to on
// web) has to survive the reloads that stand in for app restarts.
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const frontText = () => page.evaluate(() => {
  const roots = [...document.querySelectorAll('div')].filter((d) => {
    const cls = (d.className || '').toString();
    return cls.includes('flex-1 bg-slate-50') && getComputedStyle(d).pointerEvents === 'auto';
  });
  if (!roots.length) throw new Error('no focused screen container');
  return roots[roots.length - 1].innerText;
});
const body = () => page.evaluate(() => document.body.innerText);
const tapTab = async (route, wait = 2600) => {
  await page.locator(`[role="tab"][href$="/${route}"]`).first().click();
  await page.waitForTimeout(wait);
};
const signIn = async (shop, pin) => {
  await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
  await page.locator('[placeholder="••••"]').first().fill(pin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await page.waitForTimeout(3400);
};

/** Every API request black-holed: the app is online, the server is not reachable. */
const goOffline = () => page.route('**/api/**', (route) => route.abort('connectionfailed'));
const goOnline = () => page.unroute('**/api/**');

/* ============================ 1. useful ============================ */
console.log('=== shop A signs in online and sees its catalogue ===');
await page.goto(APP, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await signIn(shopA, '1111');
let seen = await frontText();
check('A sees its own product', seen.includes('AlphaWidget'), seen.slice(0, 260));
check('and no staleness banner while online', !/saved list/i.test(seen), seen.slice(0, 260));

const cached = await page.evaluate(() => {
  const raw = localStorage.getItem('minipos-catalogue');
  if (!raw) return null;
  const s = JSON.parse(raw).state ?? {};
  return { products: (s.products ?? []).map((p) => p.name), owner: s.ownerBusinessId, loadedAt: s.loadedAt };
});
check('the catalogue was written to disk', Boolean(cached?.products?.length), cached);
check('the cache holds A\'s product', cached?.products?.includes('AlphaWidget'), cached?.products);
check('and is stamped with the tenant that owns it', /^biz_[0-9a-f]{24}$/.test(cached?.owner ?? ''), cached?.owner);
check('and with when it was synced', typeof cached?.loadedAt === 'number' && cached.loadedAt > 0, cached?.loadedAt);

console.log('\n=== restart with the server unreachable ===');
await goOffline();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
let offline = await frontText();
check('the app still opens signed in, not back at the login screen',
  !/Sharma Kirana/.test(await body()), offline.slice(0, 200));
check('the saved catalogue renders with no network', offline.includes('AlphaWidget'), offline.slice(0, 320));
check('its price is there too, so a vendor can still quote', /₹100/.test(offline), offline.slice(0, 320));
check('and it is labelled a saved copy, not passed off as live',
  /saved list/i.test(offline), offline.slice(0, 320));
check('the banner warns the stock counts may have moved',
  /out of date/i.test(offline), offline.slice(0, 320));
check('the red "cannot reach server" error is suppressed in favour of the amber one',
  !/Cannot reach the server/i.test(offline), offline.slice(0, 320));
await page.screenshot({ path: '/tmp/offline-1-cached-pos.png', fullPage: true });

await tapTab('Inventory', 2800);
const offlineStock = await frontText();
check('the Stock tab serves the cache too', offlineStock.includes('AlphaWidget'), offlineStock.slice(0, 300));
check('and carries the same warning', /saved list/i.test(offlineStock), offlineStock.slice(0, 300));
await page.screenshot({ path: '/tmp/offline-2-cached-stock.png', fullPage: true });

console.log('\n=== checkout offline still fails loudly, and keeps the sale ===');
await tapTab('Pos', 2600);
await page.getByRole('button', { name: 'Add AlphaWidget', exact: false }).last().click();
await page.waitForTimeout(900);
await page.getByRole('button', { name: 'View cart', exact: false }).last().click();
await page.waitForTimeout(1300);
await page.getByRole('button', { name: 'Complete order', exact: false }).last().click();
// Read straight away: the toast self-dismisses after ~2.6s.
await page.waitForTimeout(900);
const afterTry = await body();
check('the operator is told the sale did not go through', /Cannot reach the server|reach/i.test(afterTry), afterTry.slice(0, 300));
// The sticky bar still carrying the line is the property that matters: the sale
// was not silently discarded. (It shows whether or not the sheet stayed open.)
check('and the cart is NOT cleared, so nothing is silently lost',
  /1 items/.test(afterTry) || /Grand total/.test(afterTry), afterTry.slice(0, 300));
const ordersA = (await req('/orders', null, tokenA, 'GET')).orders ?? [];
check('no phantom order reached the server', ordersA.length === 0, ordersA.length);

console.log('\n=== coming back online refreshes and drops the banner ===');
await goOnline();
await page.waitForTimeout(2200);   // let the toast clear
// The checkout sheet may or may not still be up; close it only if it is.
const closeBtn = page.getByRole('button', { name: 'Close', exact: false });
if (await closeBtn.count()) {
  await closeBtn.last().click();
  await page.waitForTimeout(800);
}
await tapTab('Inventory', 2000);
await tapTab('Pos', 3400);
const back = await frontText();
check('the banner is gone once a live fetch lands', !/saved list/i.test(back), back.slice(0, 300));
check('and the catalogue is still there', back.includes('AlphaWidget'), back.slice(0, 300));

/* ============================ 2. safe ============================ */
console.log('\n=== the cache must not cross tenants: A signs out, B signs in ===');
await page.getByRole('button', { name: 'Log out', exact: false }).last().click();
await page.waitForTimeout(900);
// Confirm dialog.
await page.getByRole('button', { name: 'Log out', exact: true }).last().click();
await page.waitForTimeout(2600);
const afterLogout = await page.evaluate(() => {
  const raw = localStorage.getItem('minipos-catalogue');
  const s = raw ? (JSON.parse(raw).state ?? {}) : {};
  return { products: (s.products ?? []).map((p) => p.name), owner: s.ownerBusinessId };
});
check('signing out empties the cached catalogue', (afterLogout.products ?? []).length === 0, afterLogout);
check('and clears the ownership stamp', !afterLogout.owner, afterLogout.owner);

await signIn(shopB, '2222');
let bSees = await frontText();
check('B sees its own product', bSees.includes('BetaGadget'), bSees.slice(0, 300));
check("B does NOT see A's product", !bSees.includes('AlphaWidget'), bSees.slice(0, 300));
await page.screenshot({ path: '/tmp/offline-3-tenant-b.png', fullPage: true });

console.log('\n=== and not even offline, where only the cache can answer ===');
await goOffline();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const bOffline = await frontText();
check('B still sees its own product from cache', bOffline.includes('BetaGadget'), bOffline.slice(0, 320));
check("and A's product is nowhere on B's device session",
  !(await body()).includes('AlphaWidget'), bOffline.slice(0, 320));

console.log('\n=== a cache belonging to another shop is discarded, not shown ===');
// Forge the worst case directly: A's rows on disk while B is the signed-in
// tenant. This is what a mid-session switch or a restored backup looks like.
await goOnline();
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('minipos-catalogue'));
  raw.state.products = [{
    _id: 'forged1', name: 'ForgedFromOtherShop', categoryId: 'x',
    price: 999, cost: 1, stock: 99, imageUrl: null,
  }];
  raw.state.categories = [{ _id: 'x', name: 'ForgedCat', color: '#000000' }];
  raw.state.ownerBusinessId = 'biz_' + 'f'.repeat(24);   // not B
  localStorage.setItem('minipos-catalogue', JSON.stringify(raw));
});
await goOffline();   // offline, so ONLY the cache could supply rows
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const forged = await body();
check('a cache stamped for another tenant is never rendered',
  !forged.includes('ForgedFromOtherShop'), forged.slice(0, 320));
check('nor is its category', !forged.includes('ForgedCat'), forged.slice(0, 320));
check('the screen is honestly empty instead', /No products|no products/i.test(forged), forged.slice(0, 320));
await page.screenshot({ path: '/tmp/offline-4-foreign-cache-rejected.png', fullPage: true });

const purged = await page.evaluate(() => {
  const raw = localStorage.getItem('minipos-catalogue');
  const s = raw ? (JSON.parse(raw).state ?? {}) : {};
  return { products: (s.products ?? []).map((p) => p.name), owner: s.ownerBusinessId };
});
check('and the foreign cache is wiped from disk, not just hidden',
  (purged.products ?? []).length === 0, purged);

console.log('\n=== B recovers normally once back online ===');
await goOnline();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const recovered = await frontText();
check('B sees its own catalogue again', recovered.includes('BetaGadget'), recovered.slice(0, 300));
check('and no banner, because this is a live fetch', !/saved list/i.test(recovered), recovered.slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed | console errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log('  -', e.slice(0, 200)));
await browser.close();
process.exit(fail ? 1 : 0);
