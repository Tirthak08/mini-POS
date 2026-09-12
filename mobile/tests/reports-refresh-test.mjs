/**
 * Reports must be refreshable, and must pick up a sale made elsewhere.
 *
 * SCOPE, stated plainly: the pull-to-refresh GESTURE cannot be performed here.
 * RefreshControl is native, and on web it renders nothing to drag. What this
 * suite does check is the thing the gesture is for -- that the silent reload
 * path fetches again, updates every figure, and does NOT blank the screen while
 * it works. It drives that path through the focus refresh, which shares the
 * exact same `load({ silent: true })` call, plus the error-banner retry.
 *
 * The one assertion that would otherwise be vacuous -- "the numbers changed" --
 * is made meaningful by ringing up a real sale through the API between reads,
 * so a screen that failed to refetch would keep the old total and fail.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const SHOT = '/tmp/shots3';

const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 350) : ''}`));
};

const shop = 'Rep ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Grain' }, token)).category;
const rice = (await req('/products', {
  name: 'Rice 5kg', categoryId: cat._id, price: 500, cost: 300, stock: 200,
}, token)).product;
// One sale before the app ever loads, so the first render has a known total.
await req('/orders', { items: [{ productId: rice._id, qty: 1 }] }, token);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Count the report calls so "did it actually refetch?" is answered by the
// network, not by inference from the rendered text.
let summaryCalls = 0;
page.on('request', (r) => { if (r.url().includes('/reports/summary')) summaryCalls += 1; });

const body = () => page.evaluate(() => document.body.innerText);
const tapTab = async (name) =>
  page.locator('[role="tab"]').filter({ hasText: name }).last().click();

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

/* ---------------------------- first read ---------------------------- */
await tapTab('Reports');
await page.waitForTimeout(3600);
const first = await body();
check('the report shows the one sale made so far', /500/.test(first), first.slice(0, 400));

const callsAfterMount = summaryCalls;
check('mounting fired exactly one summary request, not two',
  callsAfterMount === 1, { summaryCalls: callsAfterMount });

/* ------------- a sale happens elsewhere, then we come back ------------- */
console.log('\n=== returning to the tab picks up a sale made in between ===');
await tapTab('Sell');
await page.waitForTimeout(1600);

// Rung up through the API rather than the UI: this suite is about the refresh,
// and a real order is the cleanest way to move the number.
await req('/orders', { items: [{ productId: rice._id, qty: 3 }] }, token);

await tapTab('Reports');
await page.waitForTimeout(3600);

check('coming back refetched', summaryCalls > callsAfterMount,
  { before: callsAfterMount, after: summaryCalls });

const second = await body();
// 500 + 1500 = 2000. A screen that did not refetch would still say 500.
check('the total now includes the sale made while we were away',
  /2,000/.test(second), second.slice(0, 400));
check('profit moved with it (4 x 200 margin = 800)', /800/.test(second), second.slice(0, 400));
await page.screenshot({ path: `${SHOT}/reports-refreshed.png`, fullPage: true });

/* ----------- the refresh must not blank the screen while it works ----------- */
console.log('\n=== a silent refresh keeps the figures on screen ===');
await tapTab('Sell');
await page.waitForTimeout(1400);
await req('/orders', { items: [{ productId: rice._id, qty: 2 }] }, token);

/**
 * Hold the report responses back for 700ms first.
 *
 * Without this the assertions below are VACUOUS, and they were: against
 * localhost the four requests resolve in about ten milliseconds, so the
 * blocking path's spinner comes and goes between two samples and the test
 * passes whether or not the fix is there. Proven by disabling the fix and
 * watching it stay green. A refresh has to be slow enough to observe before
 * "did the screen go blank" is a question with an answer.
 */
await page.route('**/api/reports/**', async (route) => {
  await new Promise((r) => setTimeout(r, 700));
  await route.continue();
});

// Sample every 80ms across the whole refresh. If the reload used the blocking
// path, some frame would show the spinner with no figures at all -- which is
// exactly the flicker this change exists to avoid.
const framesPromise = (async () => {
  const frames = [];
  const until = Date.now() + 4200;
  while (Date.now() < until) {
    frames.push(await page.evaluate(() => ({
      hasRevenue: /Revenue/.test(document.body.innerText),
      hasSpinner: /Loading/i.test(document.body.innerText),
    })).catch(() => ({ hasRevenue: true, hasSpinner: false })));
    await page.waitForTimeout(80);
  }
  return frames;
})();
await tapTab('Reports');
const frames = await framesPromise;
await page.unroute('**/api/reports/**');
check('the delay was long enough for the refresh to be observable',
  frames.length >= 20, { sampled: frames.length });

const blank = frames.filter((f) => !f.hasRevenue);
const spinner = frames.filter((f) => f.hasSpinner);
check('the figures stayed on screen for every sampled frame',
  blank.length === 0, { blankFrames: blank.length, of: frames.length });
check('and the full-screen spinner never came back',
  spinner.length === 0, { spinnerFrames: spinner.length, of: frames.length });

const third = await body();
check('while still landing on the new total (500 + 1500 + 1000)',
  /3,000/.test(third), third.slice(0, 400));

/* ------------------------- the period still works ------------------------- */
console.log('\n=== changing the period still loads once, not twice ===');
const beforePeriod = summaryCalls;
await page.getByRole('button', { name: /^Period/ }).last().click();
await page.waitForTimeout(1100);
await page.getByRole('button', { name: 'Today', exact: true }).last().click();
await page.waitForTimeout(3200);
check('a period change fires one summary request, not one per focus listener too',
  summaryCalls - beforePeriod === 1, { fired: summaryCalls - beforePeriod });
check('and the figures are still there', /Revenue/.test(await body()), (await body()).slice(0, 250));

console.log(`\n${pass} passed, ${fail} failed | page errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log('  -', e.slice(0, 180)));
await browser.close();
process.exit(fail ? 1 : 0);
