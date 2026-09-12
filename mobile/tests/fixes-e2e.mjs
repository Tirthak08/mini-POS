/**
 * The four reported problems, driven through a real browser.
 *
 *   1. a category may not hold two products of the same name;
 *   2. the category dropdown is a CENTRED dialog, not a bottom sheet;
 *   3. the sale price can be changed at the till;
 *   4. (the keyboard) -- see the scope note below.
 *
 * SCOPE, honestly. Number 4 is NOT verifiable here and this suite does not
 * pretend to check it: there is no soft keyboard on web, so `keyboardDidShow`
 * never fires and the dialog looks correct whether or not the fix exists. The
 * arithmetic that actually moves the card is covered by
 * tests/dialog-layout-test.mjs, which can fail. What IS checked below is that
 * the resize plumbing did not break the no-keyboard case -- a dialog that is
 * still centred and still the right height with the keyboard down.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const SHOT = '/tmp/shots2';

const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`));
};

const shop = 'Fix ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const grain = (await req('/categories', { name: 'Grain' }, token)).category;
await req('/categories', { name: 'Snacks' }, token);
await req('/categories', { name: 'Drinks' }, token);
const rice = (await req('/products', {
  name: 'Rice 5kg', categoryId: grain._id, price: 500, cost: 300, stock: 40,
}, token)).product;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);
const tap = async (name, { exact = true } = {}) =>
  page.getByRole('button', { name, exact }).last().click();
/**
 * The cart is a full-screen Modal whose footer sits over the tab bar, so any
 * tab tap while it is open is swallowed by the footer rather than failing
 * loudly. Closing first makes tab navigation reliable from anywhere.
 */
const closeCart = async () => {
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.last().isVisible().catch(() => false)) {
    await close.last().click().catch(() => {});
    await page.waitForTimeout(900);
  }
};

const tapTab = async (name) => {
  await closeCart();
  await page.locator('[role="tab"]').filter({ hasText: name }).last().click();
};
const tapSegment = async (label) =>
  page.getByText(new RegExp(`^${label} \\(\\d+\\)$`)).last().click();

const CARD = 'div.rounded-3xl.bg-white.overflow-hidden';
/** Geometry of the topmost dialog card on screen. */
const measureCard = () => page.evaluate((sel) => {
  const card = [...document.querySelectorAll(sel)]
    .map((el) => ({ r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 240 && r.height > 100)
    .pop();
  if (!card) return null;
  const { r } = card;
  return {
    top: Math.round(r.top),
    bottom: Math.round(window.innerHeight - r.bottom),
    left: Math.round(r.left),
    right: Math.round(window.innerWidth - r.right),
    height: Math.round(r.height),
    viewport: window.innerHeight,
  };
}, CARD);

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

/* ============== 1 + 2. the product form, its dropdown, duplicates ============== */
console.log('\n=== the category dropdown opens as a centred dialog, not a sheet ===');
await tapTab('Stock');
await page.waitForTimeout(1700);
await tapSegment('Products');
await page.waitForTimeout(800);
await tap('New product', { exact: false });
await page.waitForTimeout(1100);

const formBox = await measureCard();
check('the product form is centred with the keyboard down',
  formBox && formBox.bottom > 20 && Math.abs(formBox.top - formBox.bottom) <= 8, formBox);

await page.getByRole('button', { name: /^Category/ }).last().click();
await page.waitForTimeout(1000);
await page.screenshot({ path: `${SHOT}/dropdown-centred.png` });

const ddBox = await measureCard();
check('the dropdown was found', Boolean(ddBox), ddBox);
if (ddBox) {
  // The bug: a bottom sheet has a bottom gap of ~0 and is flush to both edges.
  check('it is NOT flush to the bottom edge like a sheet', ddBox.bottom > 20, ddBox);
  check('it is vertically centred', Math.abs(ddBox.top - ddBox.bottom) <= 8, ddBox);
  check('and inset from the sides, not full-bleed', ddBox.left >= 12 && ddBox.right >= 12, ddBox);
  check('it never exceeds the height cap', ddBox.height <= ddBox.viewport * 0.87, ddBox);
}

const ddText = await body();
check('every category is listed', ['Grain', 'Snacks', 'Drinks'].every((c) => ddText.includes(c)), ddText.slice(0, 240));

await page.getByRole('button', { name: 'Grain', exact: true }).last().click();
await page.waitForTimeout(900);
check('picking one closes the dialog and fills the field',
  (await body()).includes('Grain'), (await body()).slice(0, 200));

console.log('\n=== a duplicate name in the same category is refused ===');
await page.locator('[placeholder="Masala Chai"]').last().fill('Rice 5kg');
await page.locator('[placeholder="0"]').first().fill('500');
await page.waitForTimeout(400);
await tap('Save', { exact: false });
await page.waitForTimeout(2400);

const dupText = await body();
check('the save is rejected', /already has a product called/i.test(dupText), dupText.slice(0, 400));
check('and the message names the product rather than the database',
  /Rice 5kg/.test(dupText) && !/E11000|duplicate key/i.test(dupText), dupText.slice(0, 400));
await page.screenshot({ path: `${SHOT}/duplicate-refused.png` });

// The form must stay open with the typed values intact, or the operator has
// to retype everything to fix one word.
check('the form is still open so the name can be corrected',
  (await page.locator('[placeholder="Masala Chai"]').last().inputValue()) === 'Rice 5kg');

// Case-only differences are the commonest way a duplicate slips in.
await page.locator('[placeholder="Masala Chai"]').last().fill('rice 5KG');
await page.waitForTimeout(300);
await tap('Save', { exact: false });
await page.waitForTimeout(2300);
check('a differently-cased duplicate is refused too',
  /already has a product called/i.test(await body()), (await body()).slice(0, 300));

// And a genuinely new name goes through.
await page.locator('[placeholder="Masala Chai"]').last().fill('Wheat 10kg');
await page.waitForTimeout(300);
await tap('Save', { exact: false });
await page.waitForTimeout(2600);
const savedText = await body();
check('a new name saves normally', savedText.includes('Wheat 10kg'), savedText.slice(0, 300));

/* ==================== 3. price override at the till ==================== */
console.log('\n=== the price can be changed at the till ===');
await tapTab('Sell');
await page.waitForTimeout(2600);
check('back on the POS screen', /Point of Sale/.test(await body()), (await body()).slice(0, 200));

// "ADD Rice 5kg" rather than the card's own label: React Navigation keeps the
// Stock screen mounted behind this one and its cards are labelled identically,
// so `.last()` on the product name reaches the wrong screen entirely.
await tap('ADD Rice 5kg');
await page.waitForTimeout(1200);
// The cart is a panel behind "View cart" at phone width, not the grid itself.
await tap('View cart', { exact: false });
await page.waitForTimeout(1400);
const cartText = await body();
check('the item is in the cart at its catalogue price', /500/.test(cartText), cartText.slice(0, 300));

// The price box is empty by default and shows the catalogue price as a hint,
// so the common case needs no interaction.
const priceBox = page.locator('[placeholder="500"]').last();
check('the price field defaults to empty, hinting the catalogue price',
  (await priceBox.inputValue()) === '');

await priceBox.fill('560');
await page.waitForTimeout(1000);
const overText = await body();
check('the cart total follows the new price', /560/.test(overText), overText.slice(0, 400));
check('and the shelf price is shown alongside, so the change is visible',
  /Listed/.test(overText), overText.slice(0, 400));
await page.screenshot({ path: `${SHOT}/price-override.png` });

await tap('Complete order', { exact: false });
await page.waitForTimeout(3600);
const doneText = await body();
check('the sale completes', /Sale complete|Order complete/i.test(doneText), doneText.slice(0, 300));

// Checkout ends by offering the customer a receipt; dismiss it or its backdrop
// swallows every later tap.
await tap('Done', { exact: false });
await page.waitForTimeout(1200);

// The server is the authority; check it recorded both figures.
const day = new Date().toISOString().slice(0, 10);
const orders = await req(`/orders?from=${day}&to=${day}`, null, token, 'GET');
const line = orders.orders?.[0]?.items?.[0];
check('the server charged the overridden price', line?.price === 560, line);
check('and kept the catalogue price on the record', line?.listPrice === 500, line);
check('the receipt total uses the charged price', orders.orders?.[0]?.grandTotal === 560, orders.orders?.[0]);

// Profit must reflect what was actually collected.
const summary = await req(`/reports/summary?from=${day}&to=${day}`, null, token, 'GET');
check('revenue counts the extra rupees collected', summary.sales?.revenue === 560, summary.sales);
check('gross profit is 260, not the 200 the catalogue would predict',
  summary.sales?.grossProfit === 260, summary.sales);

/* ---- clearing the override falls back to the catalogue price ---- */
console.log('\n=== clearing the box restores the catalogue price ===');
await tap('ADD Rice 5kg');
await page.waitForTimeout(1200);
await tap('View cart', { exact: false });
await page.waitForTimeout(1400);
const box2 = page.locator('[placeholder="500"]').last();
await box2.fill('700');
await page.waitForTimeout(700);
check('the override applies', /700/.test(await body()));
await box2.fill('');
await page.waitForTimeout(800);
const clearedText = await body();
check('clearing it returns to the catalogue price', /500/.test(clearedText), clearedText.slice(0, 300));
check('and the "Listed" marker goes away', !/Listed/.test(clearedText), clearedText.slice(0, 300));

/* ==================== 4. the dialog with no keyboard ==================== */
console.log('\n=== the keyboard resize did not break the no-keyboard case ===');
await tapTab('Stock');
await page.waitForTimeout(1600);
await tapSegment('Categories');
await page.waitForTimeout(700);
await tap('New category', { exact: false });
await page.waitForTimeout(1000);
const catBox = await measureCard();
check('a short dialog is still centred', catBox && Math.abs(catBox.top - catBox.bottom) <= 8, catBox);
check('and still short, not stretched to the cap',
  catBox && catBox.height < catBox.viewport * 0.7, catBox);
await page.screenshot({ path: `${SHOT}/category-dialog.png` });

console.log(`\n${pass} passed, ${fail} failed | page errors: ${errors.length}`);
errors.slice(0, 6).forEach((e) => console.log('  -', e.slice(0, 200)));
await browser.close();
process.exit(fail ? 1 : 0);
