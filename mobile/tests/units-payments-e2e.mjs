/**
 * Selling half a kilo, and saying how it was paid, through the real screens.
 *
 * What the unit suite cannot prove: that a kg product actually offers a field
 * you can type 1.75 into, that a pcs product does not, that the number you type
 * reaches the server as typed, and that the payment you chose is the payment
 * the report counts.
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

const shop = 'Kilo ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const grain = (await req('/categories', { name: 'Grain' }, token)).category;
const rice = (await req('/products', {
  name: 'Rice', categoryId: grain._id, price: 60, cost: 45, stock: 40, unit: 'kg',
}, token)).product;
const soap = (await req('/products', {
  name: 'Soap', categoryId: grain._id, price: 30, cost: 20, stock: 20,
}, token)).product;

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
/** The payment chips are radios, not buttons -- four exclusive choices. */
const tapRadio = async (name) =>
  page.getByRole('radio', { name, exact: true }).last().click();

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ============ 1. the stock list says what things are sold by ============ */
  console.log('\n=== the shelf says kg where it is kg ===');
  await tapTab('Stock');
  await page.waitForTimeout(2200);
  let text = await body();
  check('a kg product shows its unit', /40 kg/.test(text), text.slice(0, 700));
  check('  and a pcs product does not say "pcs"',
    /\b20\b/.test(text) && !/20 pcs/.test(text), text.slice(0, 700));

  /* ==================== 2. selling 1.75 kg ==================== */
  console.log('\n=== selling one and three quarter kilos ===');
  await tapTab('Sell');
  await page.waitForTimeout(2000);
  await tap('ADD Rice');
  await page.waitForTimeout(900);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1600);

  const qtyBox = page.getByLabel('Quantity Rice').first();
  check('a kg line offers a typeable quantity', await qtyBox.isVisible(), 'no quantity field');
  await qtyBox.fill('1.75');
  await page.waitForTimeout(900);
  text = await body();
  check('  1.75 x 60 is charged', /105/.test(text), text.slice(0, 900));

  /* ============ 3. and NOT being able to for a counted item ============ */
  console.log('\n=== soap has no such field ===');
  await tap('Close', { exact: false }).catch(() => {});
  await page.waitForTimeout(900);
  await tapTab('Sell');
  await page.waitForTimeout(1200);
  await tap('ADD Soap');
  await page.waitForTimeout(900);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1600);
  const soapBox = page.getByLabel('Quantity Soap');
  check('a pcs line has no quantity field',
    (await soapBox.count()) === 0, await soapBox.count());

  /* ==================== 4. choosing how it is paid ==================== */
  console.log('\n=== how the money came in ===');
  text = await body();
  check('the cart asks how it is paid', /Paid by/.test(text), text.slice(0, 1200));
  check('  offering cash, UPI, card and other',
    /Cash/.test(text) && /UPI/.test(text) && /Card/.test(text) && /Other/.test(text),
    text.slice(0, 1200));

  await tapRadio('UPI');
  await page.waitForTimeout(700);
  const upiChecked = await page.getByRole('radio', { name: 'UPI', exact: true }).last()
    .getAttribute('aria-checked');
  check('  choosing UPI is announced as chosen', upiChecked === 'true', upiChecked);

  await tap('Complete order', { exact: false });
  await page.waitForTimeout(3500);
  // The receipt prompt appears after a sale; dismiss it.
  await tap('Done', { exact: false }).catch(() => {});
  await page.waitForTimeout(1500);

  const orders = (await get('/orders', token)).orders;
  check('the sale went through', orders.length === 1, orders.length);
  const order = orders[0];
  check('  it was recorded as UPI', order.paymentMethod === 'upi', order.paymentMethod);

  const riceLine = order.items.find((i) => i.name === 'Rice');
  check('  the rice line kept the fraction', riceLine.qty === 1.75, riceLine.qty);
  check('  and the unit', riceLine.unit === 'kg', riceLine.unit);
  check('  the soap line is whole', order.items.find((i) => i.name === 'Soap').qty === 1);
  check('  and the total is 1.75 x 60 + 30', order.grandTotal === 135, order.grandTotal);

  const stockNow = (await get('/products', token)).products;
  check('the rice stock came down by the fraction',
    stockNow.find((p) => p.name === 'Rice').stock === 38.25,
    stockNow.find((p) => p.name === 'Rice').stock);

  /* ============ 5. the next sale starts from cash again ============ */
  console.log('\n=== the payment choice does not stick to the next customer ===');
  await tapTab('Sell');
  await page.waitForTimeout(1500);
  await tap('ADD Soap');
  await page.waitForTimeout(800);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1600);
  const chosen = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="radio"]')]
      .find((n) => n.getAttribute('aria-checked') === 'true');
    return el ? el.getAttribute('aria-label') : null;
  });
  check('a fresh cart is back to Cash', chosen === 'Cash', chosen);
  check('  and the choice is announced, not just coloured',
    (await page.locator('[role="radio"]').count()) === 4,
    await page.locator('[role="radio"]').count());

  await tap('Complete order', { exact: false });
  await page.waitForTimeout(3500);
  await tap('Done', { exact: false }).catch(() => {});
  await page.waitForTimeout(1500);

  /* ==================== 6. the drawer question ==================== */
  console.log('\n=== the report answers what is in the drawer ===');
  await tapTab('Reports');
  await page.waitForTimeout(3500);
  const report = await body();
  check('the report breaks the takings down', /How it was paid/.test(report), report.slice(0, 1500));
  check('  naming UPI', /UPI/.test(report), report.slice(0, 1500));
  check('  and Cash', /Cash/.test(report), report.slice(0, 1500));

  const summary = await get('/reports/summary', token);
  const upiRow = summary.payments.find((p) => p.method === 'upi');
  const cashRow = summary.payments.find((p) => p.method === 'cash');
  check('  UPI holds the first sale', upiRow?.amount === 135, summary.payments);
  check('  cash holds the second', cashRow?.amount === 30, summary.payments);
  check('  and together they are the revenue',
    upiRow.amount + cashRow.amount === summary.sales.revenue,
    { parts: [upiRow.amount, cashRow.amount], revenue: summary.sales.revenue });

  /* ============ 7. counting a fraction on the stock count ============ */
  console.log('\n=== the stock count takes fractions too ===');
  await tapTab('Stock');
  await page.waitForTimeout(2000);
  await tap('Stock count');
  await page.waitForTimeout(2000);
  const riceCount = page.getByLabel('Counted quantity for Rice').first();
  await riceCount.fill('37.5');
  await page.waitForTimeout(900);
  text = await body();
  // The typed figure lives in the input's value, not the page text.
  check('a fractional count is accepted', (await riceCount.inputValue()) === '37.5',
    await riceCount.inputValue());
  check('  and shows a fractional variance', /-0.75 kg/.test(text), text.slice(0, 800));

  /**
   * The decimal point is dropped, not stripped. Stripping it turns 18.5 into
   * 185 -- a tenfold error in the field where it is least likely to be noticed.
   */
  const soapCount = page.getByLabel('Counted quantity for Soap').first();
  await soapCount.fill('18.5');
  await page.waitForTimeout(900);
  check('a fraction typed against pcs truncates rather than concatenating',
    (await soapCount.inputValue()) === '18', await soapCount.inputValue());
  text = await body();
  check('  and the variance is read from 18, not 185',
    !/167/.test(text) && !/185/.test(text), text.slice(0, 700));

  await page.waitForTimeout(600);
  await tap('Apply count');
  await page.waitForTimeout(1300);
  await tap('Apply count');
  await page.waitForTimeout(3000);

  const counted = (await get('/products', token)).products;
  check('the fractional count was applied',
    counted.find((p) => p.name === 'Rice').stock === 37.5,
    counted.find((p) => p.name === 'Rice').stock);
  check('  and the whole one too',
    counted.find((p) => p.name === 'Soap').stock === 18,
    counted.find((p) => p.name === 'Soap').stock);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
