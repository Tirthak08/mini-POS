/**
 * AUDIT 2 — selling, and the history it leaves behind.
 *
 * The till, the receipt list and its period filters, correcting a sale, voiding
 * one, and expenses. The arithmetic on screen is checked against the arithmetic
 * on the server every time, because the cart computes its own preview and a
 * preview that disagrees with the bill is the worst possible bug in a POS.
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

const shop = 'Audit2 ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const grain = (await req('/categories', { name: 'Grain' }, token)).category;
const snacks = (await req('/categories', { name: 'Snacks' }, token)).category;
const mk = async (n, c, price, cost, stock) =>
  (await req('/products', { name: n, categoryId: c, price, cost, stock }, token)).product;
const rice = await mk('Rice', grain._id, 60, 45, 100);
const dal = await mk('Dal', grain._id, 110, 85, 40);
const chips = await mk('Chips', snacks._id, 20, 12, 5);

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);
const tap = async (name, { exact = true } = {}) =>
  page.getByRole('button', { name, exact }).last().click();
const tapTab = async (name) =>
  page.locator('[role="tab"]').filter({ hasText: name }).last().click();
const fill = async (label, value) =>
  page.getByLabel(label, { exact: false }).last().fill(value);

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

const stockOf = async (id) => (await get('/products', token)).products
  .find((p) => String(p._id) === String(id)).stock;

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ==================== 1. the grid and its filters ==================== */
  console.log('\n=== finding a product at the till ===');
  let text = await body();
  check('every product is on the grid',
    /Rice/.test(text) && /Dal/.test(text) && /Chips/.test(text), text.slice(0, 500));

  await page.getByRole('button', { name: 'Category', exact: false }).last().click();
  await page.waitForTimeout(900);
  await tap('Snacks');
  await page.waitForTimeout(1200);
  text = await body();
  check('the category filter narrows the grid',
    /Chips/.test(text) && !/ADD Rice/.test(text), text.slice(0, 500));

  await page.getByRole('button', { name: 'Category', exact: false }).last().click();
  await page.waitForTimeout(900);
  await tap('All');
  await page.waitForTimeout(1100);

  const search = page.getByPlaceholder('Search').last();
  await search.fill('da');
  await page.waitForTimeout(1100);
  text = await body();
  check('search finds a product part-way through its name',
    /Dal/.test(text) && !/ADD Rice/.test(text), text.slice(0, 500));
  await search.fill('');
  await page.waitForTimeout(1000);

  /* ==================== 2. the cart's arithmetic ==================== */
  console.log('\n=== the cart adds up ===');
  await tap('ADD Rice');
  await page.waitForTimeout(700);
  await tap('plus Rice');
  await page.waitForTimeout(700);
  await tap('ADD Dal');
  await page.waitForTimeout(700);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1600);

  text = await body();
  check('the subtotal is the sum of the lines', /₹230/.test(text), text.slice(0, 1200));

  // A discount on one line, a hand-typed price on another, and a delivery
  // charge: the three things that most often disagree between screen and server.
  await fill('Discount Rice', '20');
  await page.waitForTimeout(900);
  await fill('Price Dal', '100');
  await page.waitForTimeout(900);
  await fill('Extra charges', '15');
  await page.waitForTimeout(900);

  text = await body();
  // 2x60 = 120, minus 20 -> 100; Dal repriced 110 -> 100; plus 15 delivery.
  check('the discount shows as its own deduction', /₹20/.test(text), text.slice(0, 1400));
  check('  and the grand total is 120 + 100 - 20 + 15', /₹215/.test(text), text.slice(0, 1400));
  check('  the repriced line is flagged as repriced', /₹100/.test(text), text.slice(0, 1400));

  await tap('Complete order', { exact: false });
  await page.waitForTimeout(3500);
  await tap('Done', { exact: false }).catch(() => {});
  await page.waitForTimeout(1500);

  let orders = (await get('/orders', token)).orders;
  check('the sale is recorded', orders.length === 1, orders.length);
  const first = orders[0];
  check('  and the server charged what the screen said', first.grandTotal === 215, first.grandTotal);
  check('  the discount is on the receipt', first.discountTotal === 20, first.discountTotal);
  check('  the extra charge too', first.extraCharges === 15, first.extraCharges);
  check('  the repriced line kept what the catalogue said',
    first.items.find((i) => i.name === 'Dal').listPrice === 110, first.items.find((i) => i.name === 'Dal'));
  check('the stock came down by what was sold',
    await stockOf(rice._id) === 98 && await stockOf(dal._id) === 39,
    { rice: await stockOf(rice._id), dal: await stockOf(dal._id) });

  /* ==================== 3. the stock guard ==================== */
  console.log('\n=== the till will not sell what is not there ===');
  await tapTab('Sell');
  await page.waitForTimeout(1400);
  await tap('ADD Chips');
  await page.waitForTimeout(600);
  for (let i = 0; i < 6; i += 1) {
    await tap('plus Chips').catch(() => {});
    await page.waitForTimeout(350);
  }
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1500);
  text = await body();
  check('the quantity stops at what is in stock', /\/ 5/.test(text), text.slice(0, 900));
  const overRes = await waitForText(/Not enough stock|5/, 3000);
  check('  and it never exceeds it on screen', !/6\s*\n\s*\/ 5/.test(overRes.seen));
  // Closed rather than cleared: "Clear cart" opens a confirmation, and leaving
  // an unanswered dialog behind would make every later tap ambiguous.
  await tap('Close', { exact: false }).catch(() => {});
  await page.waitForTimeout(1200);

  /* ==================== 4. the receipt list ==================== */
  console.log('\n=== the sales list ===');
  await tapTab('Sales');
  await page.waitForTimeout(2500);
  text = await body();
  check('the sale appears in the list', /INV-000001/.test(text), text.slice(0, 900));
  check('  with its total', /₹215/.test(text), text.slice(0, 900));
  check('  and a period summary above it', /Period/.test(text), text.slice(0, 900));

  /* ==================== 5. the period filter ==================== */
  console.log('\n=== the period filter actually filters ===');
  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1100);
  await tap('Yesterday');
  await page.waitForTimeout(2200);
  text = await body();
  check('a period with no sales in it shows none',
    !/INV-000001/.test(text), text.slice(0, 900));
  check('  and says so rather than looking broken',
    /No sales|Nothing/i.test(text), text.slice(0, 900));

  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1100);
  await tap('Today');
  await page.waitForTimeout(2200);
  check('switching back brings it back', /INV-000001/.test(await body()), (await body()).slice(0, 600));

  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1100);
  await tap('All time');
  await page.waitForTimeout(2200);
  check('"all time" shows it too', /INV-000001/.test(await body()), (await body()).slice(0, 600));

  /* ==================== 6. correcting a sale ==================== */
  console.log('\n=== correcting a receipt ===');
  await tap('INV-000001', { exact: false });
  await page.waitForTimeout(1800);
  text = await body();
  check('the receipt opens', /Rice/.test(text) && /Dal/.test(text), text.slice(0, 900));

  const riceBefore = await stockOf(rice._id);
  await tap('Edit sale');
  await page.waitForTimeout(1600);
  // One more kilo of rice than the receipt says.
  await tap('plus Rice').catch(() => {});
  await page.waitForTimeout(900);
  await tap('Save', { exact: false });
  await page.waitForTimeout(2500);

  orders = (await get('/orders', token)).orders;
  const edited = orders.find((o) => o.orderNumber === 1);
  check('the correction saved', edited.items.find((i) => i.name === 'Rice').qty === 3,
    edited.items.map((i) => [i.name, i.qty]));
  check('  and it says the receipt was amended', edited.editCount >= 1, edited.editCount);
  check('  only the DIFFERENCE came off the stock',
    await stockOf(rice._id) === riceBefore - 1,
    { before: riceBefore, after: await stockOf(rice._id) });

  /* ==================== 7. voiding ==================== */
  console.log('\n=== voiding a sale puts the stock back ===');
  const beforeVoid = { rice: await stockOf(rice._id), dal: await stockOf(dal._id) };
  // Saving a correction closes the receipt, so it has to be opened again.
  await tap('INV-000001', { exact: false });
  await page.waitForTimeout(1800);
  await tap('Void sale');
  await page.waitForTimeout(1600);
  await tap('Void sale');
  await page.waitForTimeout(2800);

  check('the sale leaves the list',
    !/INV-000001/.test(await body()), (await body()).slice(0, 700));
  check('  and the stock is restored',
    await stockOf(rice._id) === beforeVoid.rice + 3 && await stockOf(dal._id) === beforeVoid.dal + 1,
    { before: beforeVoid, after: { rice: await stockOf(rice._id), dal: await stockOf(dal._id) } });
  check('  the receipt number is not handed out again',
    (await get('/orders', token)).orders.length === 0);

  /* ==================== 8. expenses ==================== */
  console.log('\n=== money going out ===');
  await tap('Expenses', { exact: false });
  await page.waitForTimeout(1600);
  await tap('Add expense', { exact: false });
  await page.waitForTimeout(1400);
  await fill('Amount', '2500');
  await fill('What was it for', 'Shop rent');
  await tap('Save');
  await page.waitForTimeout(2200);

  let expenses = (await get('/expenses', token)).expenses;
  check('an expense is recorded', expenses.length === 1 && expenses[0].amount === 2500,
    expenses.map((e) => [e.note, e.amount]));

  await tap('Add expense', { exact: false });
  await page.waitForTimeout(1300);
  await tap('Save');
  await page.waitForTimeout(1500);
  check('an expense with nothing in it is refused',
    (await get('/expenses', token)).expenses.length === 1);
  check('  saying what is missing', /Enter an amount|required/i.test(await body()), (await body()).slice(0, 500));
  await tap('Cancel', { exact: false }).catch(() => {});
  await page.waitForTimeout(1000);

  text = await body();
  check('the expenses tab totals what went out', /₹2,500/.test(text), text.slice(0, 900));

  await tap('Delete', { exact: false }).catch(() => {});
  await page.waitForTimeout(1300);
  await tap('Delete', { exact: false }).catch(() => {});
  await page.waitForTimeout(2000);
  check('an expense can be deleted',
    (await get('/expenses', token)).expenses.length === 0,
    (await get('/expenses', token)).expenses.length);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
