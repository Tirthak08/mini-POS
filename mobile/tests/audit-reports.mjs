/**
 * AUDIT 3 — the reports, and every filter on them.
 *
 * Each headline figure is computed here, independently, from the sales this
 * suite made — then compared with what the screen shows. A report that agrees
 * with the server but not with arithmetic is still wrong, and the server is not
 * an independent witness to its own aggregate.
 *
 * The shop is built to make the numbers awkward on purpose: a discount, an
 * extra charge, a line sold below list, a sale on credit, a repayment, a void,
 * and expenses. Every one of those has broken a total in this app at some point.
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
const money = (n) => `₹${n.toLocaleString('en-IN')}`;

/* ---------------------------- a shop with edges ---------------------------- */
const shop = 'Audit3 ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const grain = (await req('/categories', { name: 'Grain' }, token)).category;
const snacks = (await req('/categories', { name: 'Snacks' }, token)).category;
const mk = async (n, c, price, cost, stock) =>
  (await req('/products', { name: n, categoryId: c, price, cost, stock }, token)).product;
const rice = await mk('Rice', grain._id, 100, 60, 500);
const dal = await mk('Dal', grain._id, 200, 150, 200);
const chips = await mk('Chips', snacks._id, 20, 12, 300);

/** Everything the report should be able to work out, worked out here instead. */
const expected = { revenue: 0, cogs: 0, discounts: 0, extra: 0, items: 0, orders: 0, byCat: {} };
const note = ({ lines, extraCharges = 0 }) => {
  let net = 0;
  for (const [product, qty, price, discount = 0] of lines) {
    const unit = price ?? product.price;
    /* A discount belongs to the LINE it was given on, so it comes off that
       line's category too. Counting the category at list price while counting
       revenue net of the discount is how a by-category chart ends up totalling
       more than the day's takings. */
    const lineNet = unit * qty - discount;
    net += lineNet;
    expected.cogs += product.cost * qty;
    expected.items += qty;
    expected.discounts += discount;
    const cat = String(product.categoryId) === String(grain._id) ? 'Grain' : 'Snacks';
    expected.byCat[cat] = (expected.byCat[cat] ?? 0) + lineNet;
  }
  /* Extra charges (delivery and the like) belong to NO category -- which is why
     the category totals are checked against revenue minus them, below. */
  expected.revenue += net + extraCharges;
  expected.extra += extraCharges;
  expected.orders += 1;
};

// 1. an ordinary sale
await req('/orders', { items: [{ productId: rice._id, qty: 3 }] }, token);
note({ lines: [[rice, 3]] });

// 2. a sale with a discount and a delivery charge
await req('/orders', {
  items: [{ productId: dal._id, qty: 2, discount: 50 }], extraCharges: 30, paymentMethod: 'upi',
}, token);
note({ lines: [[dal, 2, null, 50]], extraCharges: 30 });

// 3. a line sold BELOW the shelf price
await req('/orders', { items: [{ productId: chips._id, qty: 10, price: 15 }], paymentMethod: 'card' }, token);
note({ lines: [[chips, 10, 15]] });

// 4. a sale on credit — revenue in full, but only part of it in the drawer
const ramesh = (await req('/customers', { name: 'Ramesh Bhai' }, token)).customer;
await req('/orders', {
  customerId: ramesh._id, amountPaid: 100, items: [{ productId: rice._id, qty: 5 }],
}, token);
note({ lines: [[rice, 5]] });

// 5. a sale that is then voided — it must vanish from every figure
const voidedRevenue = 4 * 200; // dal, all of it in Grain -- must appear nowhere
const doomed = await req('/orders', { items: [{ productId: dal._id, qty: 4 }] }, token);
await req(`/orders/${doomed.order._id}`, null, token, 'DELETE');

// 6. a repayment: money in the drawer that belongs to no sale in this period
await req(`/customers/${ramesh._id}/payments`, { amount: 200, method: 'cash' }, token);

// 7. expenses
await req('/expenses', { amount: 2500, note: 'Shop rent' }, token);
await req('/expenses', { amount: 340, note: 'Electricity' }, token);
const expectedExpenses = 2840;

const expectedGrossProfit = expected.revenue - expected.cogs;
const expectedNet = expectedGrossProfit - expectedExpenses;
// Cash: sale 1 (300) + the 100 handed over on credit + the 200 repayment.
const expectedCash = 300 + 100 + 200;
const expectedUpi = 2 * 200 - 50 + 30;
const expectedCard = 10 * 15;
const expectedReceived = expectedCash + expectedUpi + expectedCard;

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

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  await tapTab('Reports');
  await page.waitForTimeout(3800);
  let text = await body();

  /* ==================== 1. the headline figures ==================== */
  console.log('\n=== the numbers on the front of the report ===');
  check(`revenue is ${money(expected.revenue)}`,
    text.includes(money(expected.revenue)), { expected: money(expected.revenue), text: text.slice(0, 900) });
  check(`  gross profit is ${money(expectedGrossProfit)}`,
    text.includes(money(expectedGrossProfit)), money(expectedGrossProfit));
  check(`  expenses are ${money(expectedExpenses)}`,
    text.includes(money(expectedExpenses)), money(expectedExpenses));
  check(`  and the net is a LOSS of ${money(Math.abs(expectedNet))}`,
    text.includes(`-${money(Math.abs(expectedNet))}`) && /Net loss/.test(text),
    { expected: `-${money(Math.abs(expectedNet))}`, text: text.slice(0, 1200) });
  check(`  ${expected.orders} orders, not counting the voided one`,
    new RegExp(`Orders\\s*\\n?\\s*${expected.orders}\\b`).test(text), text.slice(0, 1600));
  check(`  ${expected.items} items sold`,
    new RegExp(`Items sold\\s*\\n?\\s*${expected.items}\\b`).test(text), text.slice(0, 1600));
  check(`  discounts given ${money(expected.discounts)}`,
    text.includes(money(expected.discounts)), money(expected.discounts));

  /* ==================== 2. the drawer ==================== */
  console.log('\n=== how much should be in the drawer ===');
  const summary = await get('/reports/summary', token);
  const byMethod = Object.fromEntries((summary.payments ?? []).map((p) => [p.method, p.amount]));
  check(`cash is ${money(expectedCash)} — what was HANDED OVER, not what was billed`,
    byMethod.cash === expectedCash, { got: byMethod.cash, expected: expectedCash });
  check('  a repayment counts as money in', byMethod.cash >= 200, byMethod);
  check(`  upi is ${money(expectedUpi)}`, byMethod.upi === expectedUpi, { got: byMethod.upi, expected: expectedUpi });
  check(`  card is ${money(expectedCard)}`, byMethod.card === expectedCard, { got: byMethod.card, expected: expectedCard });
  check('  the parts add up to what came in',
    Math.abs(summary.received - expectedReceived) < 0.01,
    { received: summary.received, expected: expectedReceived });
  check('  and the shares add up to 100%',
    Math.abs(summary.payments.reduce((s, p) => s + p.sharePercent, 0) - 100) < 0.2,
    summary.payments.map((p) => p.sharePercent));
  check('the takings are LESS than revenue, because of the credit sale',
    summary.received < summary.sales.revenue,
    { received: summary.received, revenue: summary.sales.revenue });
  check('  and the screen shows the breakdown', /How it was paid/.test(text), text.slice(0, 1800));

  /* ==================== 3. receivables ==================== */
  console.log('\n=== what is still owed ===');
  check('the report shows what is out on credit', /Out on credit/.test(text), text.slice(0, 1800));
  check('  which is the bill minus what was paid minus the repayment',
    summary.receivables.owed === 500 - 100 - 200, summary.receivables);

  /* ==================== 4. by category ==================== */
  console.log('\n=== sales by category ===');
  const byCat = await get('/reports/by-category', token);
  const catRevenue = Object.fromEntries(byCat.categories.map((c) => [c.name, c.revenue]));
  check(`Grain is ${money(expected.byCat.Grain)}`,
    catRevenue.Grain === expected.byCat.Grain, { got: catRevenue.Grain, expected: expected.byCat.Grain });
  check(`  Snacks is ${money(expected.byCat.Snacks)} — at the price actually charged`,
    catRevenue.Snacks === expected.byCat.Snacks, { got: catRevenue.Snacks, expected: expected.byCat.Snacks });
  /* Independent of the two checks above: if the voided dal sale were still
     counted anywhere, the category totals would exceed the day's revenue. They
     are checked against revenue MINUS extra charges, which belong to no
     category at all. */
  const catTotal = byCat.categories.reduce((s, c) => s + c.revenue, 0);
  check('  the categories total the revenue, less the delivery charge',
    Math.abs(catTotal - (expected.revenue - expected.extra)) < 0.01,
    { catTotal, expected: expected.revenue - expected.extra });
  check(`  and the voided ${money(voidedRevenue)} sale is in none of them`,
    catTotal < expected.revenue - expected.extra + voidedRevenue,
    byCat.categories.map((c) => [c.name, c.revenue]));
  check('  and the shares add up to 100%',
    Math.abs(byCat.categories.reduce((s, c) => s + c.sharePercent, 0) - 100) < 0.2,
    byCat.categories.map((c) => c.sharePercent));

  /* ==================== 5. the period filter ==================== */
  console.log('\n=== the period filter ===');
  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1200);
  await tap('Yesterday');
  await page.waitForTimeout(3000);
  text = await body();
  check('a period with no sales says so plainly',
    /No sales in this period/.test(text), text.slice(0, 1400));
  check('  and does not leave the previous period\'s revenue on screen',
    !text.includes(money(expected.revenue)), text.slice(0, 1200));
  /* Receivables are not a period figure: a debt is outstanding until it is
     paid. The tile used to live inside the branch the empty state replaces, so
     picking a quiet day hid the money owed to you. */
  check('  but what is owed is still on screen',
    /Out on credit/.test(text) && text.includes(money(200)), text.slice(0, 1600));

  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1200);
  await tap('Today');
  await page.waitForTimeout(3000);
  check('switching back to today restores the figures',
    (await body()).includes(money(expected.revenue)), (await body()).slice(0, 900));

  for (const preset of ['This week', 'This month', 'This year', 'All time']) {
    await page.getByRole('button', { name: 'Period', exact: false }).last().click();
    await page.waitForTimeout(1100);
    await tap(preset);
    await page.waitForTimeout(2600);
    check(`"${preset}" includes today's sales`,
      (await body()).includes(money(expected.revenue)), { preset, text: (await body()).slice(0, 700) });
  }

  for (const preset of ['Yesterday', 'Last week', 'Last month', 'Last year']) {
    await page.getByRole('button', { name: 'Period', exact: false }).last().click();
    await page.waitForTimeout(1100);
    await tap(preset);
    await page.waitForTimeout(2600);
    const seen = await body();
    check(`"${preset}" excludes them`,
      /No sales in this period/.test(seen) && !seen.includes(money(expected.revenue)),
      { preset, text: seen.slice(0, 700) });
  }

  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1100);
  await tap('Today');
  await page.waitForTimeout(2600);

  /* ==================== 6. the detail views ==================== */
  console.log('\n=== the detail views behind the charts ===');
  text = await body();
  check('sales by category is on the report', /category/i.test(text), text.slice(0, 2500));
  const detailButtons = await page.getByRole('button', { name: 'Details', exact: false }).count();
  check('  and offers a detail view', detailButtons > 0, detailButtons);

  if (detailButtons > 0) {
    await tap('Details', { exact: false });
    await page.waitForTimeout(1800);
    const detail = await body();
    check('  which lists every category', /Grain/.test(detail) && /Snacks/.test(detail), detail.slice(-900));
    await tap('Close', { exact: false }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  /* ==================== 7. the export ==================== */
  console.log('\n=== the export ===');
  const exported = await get('/reports/export', token);
  check('the export holds one row per live sale',
    exported.orders.length === expected.orders, exported.orders.length);
  check('  and none for the voided one',
    !exported.orders.some((o) => o.grandTotal === 800), exported.orders.map((o) => o.grandTotal));
  check('  every row says how it was paid',
    exported.orders.every((o) => typeof o.paidBy === 'string'), exported.orders[0]);
  check('  and what is still owed on it',
    exported.orders.some((o) => o.balanceDue === 400), exported.orders.map((o) => o.balanceDue));
  check('  the item rows total the revenue',
    Math.abs(exported.items.reduce((s, i) => s + i.lineTotal, 0) - (expected.revenue - expected.extra)) < 0.01,
    { lines: exported.items.reduce((s, i) => s + i.lineTotal, 0), expected: expected.revenue - expected.extra });
  check('  and the expenses ride along',
    exported.expenses.reduce((s, e) => s + e.amount, 0) === expectedExpenses,
    exported.expenses);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
