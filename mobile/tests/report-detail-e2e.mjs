/**
 * The report screen's new affordances, and the scroll reset on every tab.
 *
 *   1. switching tabs returns each screen to the top;
 *   2. the export can be previewed before it is sent;
 *   3. "Sales by category" and "Top products" open a full detail list;
 *   4. tapping a chart point shows its period and value.
 *
 * SCOPE: the save-to-device path is Android's Storage Access Framework and
 * cannot run here at all -- there is no folder picker on web. What is checked
 * is that choosing Save changes the mode the export runs in; that it writes to
 * a real folder is a phone test.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const SHOT = '/tmp/shots4';

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

/* ---- a shop with enough categories and products to force truncation ---- */
const shop = 'Det ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;

const CATS = ['Grain', 'Snacks', 'Drinks', 'Soap', 'Oil', 'Spices', 'Sweets', 'Tea'];
const cats = {};
for (const name of CATS) cats[name] = (await req('/categories', { name }, token)).category;

// 12 products across 8 categories: more than the 6 category slices and the 8
// top-product rows the cards can show, so "Details" has something to reveal.
const products = [];
for (const [i, name] of CATS.entries()) {
  for (let k = 0; k < (i < 4 ? 2 : 1); k += 1) {
    const p = (await req('/products', {
      name: `${name} item ${k + 1}`, categoryId: cats[name]._id,
      price: 100 + i * 20 + k * 5, cost: 50 + i * 10, stock: 500,
    }, token)).product;
    products.push(p);
  }
}
for (const [i, p] of products.entries()) {
  await req('/orders', { items: [{ productId: p._id, qty: (i % 4) + 1 }] }, token);
}
await req('/expenses', { amount: 2500, note: 'Shop rent' }, token);
await req('/expenses', { amount: 300, note: 'Electricity' }, token);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);
const tap = async (name, { exact = true } = {}) =>
  page.getByRole('button', { name, exact }).last().click();
const closeAnyOverlay = async () => {
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.last().isVisible().catch(() => false)) {
    await close.last().click().catch(() => {});
    await page.waitForTimeout(800);
  }
};
const tapTab = async (name) => {
  await closeAnyOverlay();
  await page.locator('[role="tab"]').filter({ hasText: name }).last().click();
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

/* ==================== 1. scroll resets on tab switch ==================== */
console.log('\n=== switching tabs returns the screen to the top ===');

/** Offset of the tallest scroller currently on screen. */
const scrollTop = () => page.evaluate(() => {
  const nodes = [...document.querySelectorAll('div')]
    .filter((el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200);
  return nodes.length ? Math.max(...nodes.map((n) => n.scrollTop)) : 0;
});
const scrollDown = () => page.evaluate(() => {
  const node = [...document.querySelectorAll('div')]
    .filter((el) => el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (node) node.scrollTop = 400;
  return node ? node.scrollTop : -1;
});

await tapTab('Stock');
await page.waitForTimeout(2000);
const pushed = await scrollDown();
await page.waitForTimeout(500);
check('the Stock list could be scrolled down', pushed > 100, { scrolledTo: pushed });

await tapTab('Sell');
await page.waitForTimeout(1400);
await tapTab('Stock');
await page.waitForTimeout(1600);
const backAtTop = await scrollTop();
check('coming back to Stock lands at the top again', backAtTop < 20, { offset: backAtTop });

/* ==================== 2 + 3 + 4. the report screen ==================== */
await tapTab('Reports');
await page.waitForTimeout(3800);
const rep = await body();
check('the report loaded', /Revenue/.test(rep), rep.slice(0, 250));

console.log('\n=== both sections say they are truncated, and offer the rest ===');
check('the category card says it is showing a subset',
  /Showing the top \d+ of \d+/.test(rep), rep.slice(0, 700));
check('the products card says what it is ranked by',
  /Showing the top \d+ by revenue/.test(rep), rep.slice(0, 900));

await page.getByRole('button', { name: /^Details — Sales by category$/ }).last().click();
await page.waitForTimeout(1500);
const catDetail = await body();
check('the category detail opened', /Sales by category/.test(catDetail), catDetail.slice(0, 200));
// The card shows 6 slices; the detail must show all 8 real categories.
const shownCats = CATS.filter((c) => catDetail.includes(c));
check('every category is listed, including the ones folded into "Other"',
  shownCats.length === CATS.length, { shown: shownCats.length, of: CATS.length });
check('the detail carries a totals row', /Total/.test(catDetail), catDetail.slice(0, 400));
check('and the shares add up to about 100%', /\b(99|100)(\.\d+)?%/.test(catDetail), catDetail.slice(0, 700));
await page.screenshot({ path: `${SHOT}/category-detail.png`, fullPage: true });

await tap('Close');
await page.waitForTimeout(1200);

await page.getByRole('button', { name: /^Details — Top products$/ }).last().click();
await page.waitForTimeout(2200);
const prodDetail = await body();
check('the product detail opened', /Top products/.test(prodDetail), prodDetail.slice(0, 200));
// The card requests 8; the detail requests 50, so all 12 products appear.
const rows = (prodDetail.match(/ item \d/g) ?? []).length;
check('it lists more products than the card did', rows > 8, { rows });
check('the product detail has a totals row too', /Total/.test(prodDetail));
await page.screenshot({ path: `${SHOT}/product-detail.png`, fullPage: true });

await tap('Close');
await page.waitForTimeout(1200);

/* ---------------------------- the preview ---------------------------- */
console.log('\n=== the export can be seen before it is sent ===');
await tap('Preview report', { exact: false });
await page.waitForTimeout(3200);
const preview = await body();
check('the preview opened', /Report preview/.test(preview), preview.slice(0, 250));
check('it names the shop and the period', preview.includes(shop), preview.slice(0, 250));
for (const section of ['Summary', 'Top products', 'Expenses', 'Sales']) {
  check(`the preview includes the ${section} table`, preview.includes(section), preview.slice(0, 400));
}
check('the expenses total is the 2,800 that was recorded',
  /2,800/.test(preview), preview.slice(0, 900));
check('and the summary shows a net figure', /Net (profit|loss)/.test(preview), preview.slice(0, 600));
await page.screenshot({ path: `${SHOT}/export-preview.png`, fullPage: true });

console.log('\n=== share or save is a choice, and it sticks ===');
const saveBtns = page.getByRole('button', { name: 'Save to device', exact: true });
check('the preview offers Save to device', await saveBtns.last().isVisible());
await saveBtns.last().click();
await page.waitForTimeout(700);
const savePicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[role="button"]')]
    .filter((b) => b.getAttribute('aria-label') === 'Save to device').pop();
  return el ? el.getAttribute('aria-selected') === 'true' || /bg-blue-600/.test(el.className) : null;
});
check('choosing Save marks it as the active mode', savePicked === true, { savePicked });

await tap('Close');
await page.waitForTimeout(1200);
const afterClose = await body();
check('closing the preview returns to the report', /Revenue/.test(afterClose), afterClose.slice(0, 200));
check('and the mode chosen inside the preview is still chosen outside',
  /Save to device/.test(afterClose), afterClose.slice(0, 900));

/* ---------------------------- chart tooltip ---------------------------- */
/**
 * NOT TESTED HERE, deliberately.
 *
 * react-native-chart-kit attaches its data-point handler as
 * `{ onPressIn, onClick }` on an SVG <Circle>, and react-native-svg's web build
 * forwards neither to the DOM node. A click, a real mouse press and a full
 * pointer sequence on the hit target were all tried against it; none fired the
 * handler. So any assertion about the tooltip here would pass with the feature
 * deleted -- and two earlier attempts did exactly that, matching a date and a
 * rupee sign that appear elsewhere on the page.
 *
 * The placement and labelling logic lives in utils/chartTooltip.js and is
 * covered by tests/chart-tooltip-test.mjs, whose assertions can fail (one of
 * them caught a null coordinate rendering at the chart's origin). Whether the
 * point responds to a thumb is a phone test.
 */
check('the chart rendered points that a thumb could hit on a device',
  (await page.locator('svg circle[r="14"]').count()) > 0,
  'chart-kit only draws the 14px touch target when onDataPointClick is wired');

console.log(`\n${pass} passed, ${fail} failed | page errors: ${errors.length}`);
errors.slice(0, 6).forEach((e) => console.log('  -', e.slice(0, 200)));
await browser.close();
process.exit(fail ? 1 : 0);
