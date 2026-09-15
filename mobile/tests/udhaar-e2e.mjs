/**
 * Udhaar, through the real screens.
 *
 * What the API suite cannot prove: that a sale can actually be put on somebody's
 * account from the till, that the debt shows up where a shopkeeper would look
 * for it, and that recording a repayment moves the number they act on.
 *
 * The assertion that matters most is the last one in each section: the balance
 * on screen is the SERVER's, recomputed from receipts and repayments. A screen
 * that did its own subtraction would be a second place the number could come
 * from, and two places eventually disagree.
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

const shop = 'Khata ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Grain' }, token)).category;
const rice = (await req('/products', {
  name: 'Rice', categoryId: cat._id, price: 100, cost: 60, stock: 500,
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

const balanceOnServer = async (id) => (await get(`/customers/${id}`, token)).customer.balance;

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ==================== 1. the tab, and an empty ledger ==================== */
  console.log('\n=== Udhaar is its own tab ===');
  await tapTab('Udhaar');
  await page.waitForTimeout(2500);
  let text = await body();
  check('the tab opens', /Out on credit/.test(text), text.slice(0, 400));
  check('  with nobody on the books yet', /No customers yet/.test(text), text.slice(0, 500));
  check('  and nothing out on the street', /₹0/.test(text), text.slice(0, 400));

  /* ==================== 2. adding a customer ==================== */
  console.log('\n=== adding somebody you sell to on credit ===');
  await tap('Add customer');
  await page.waitForTimeout(1300);
  await page.getByLabel('Name', { exact: false }).first().fill('Ramesh Bhai');
  await page.getByLabel('Phone', { exact: false }).first().fill('98765 43210');
  await tap('Save');
  await page.waitForTimeout(2200);

  const customers = (await get('/customers', token)).customers;
  check('the customer is created', customers.length === 1, customers.map((c) => c.name));
  const ramesh = customers[0];
  check('  owing nothing to begin with', ramesh.balance === 0, ramesh.balance);

  text = await body();
  check('  and the list says nobody owes anything',
    /Nobody owes you anything/.test(text), text.slice(0, 600));

  /* ==================== 3. selling on credit ==================== */
  console.log('\n=== putting a sale on their account ===');
  await tapTab('Sell');
  await page.waitForTimeout(1800);
  await tap('ADD Rice');
  await page.waitForTimeout(700);
  // ADD becomes a -/count/+ stepper once the item is in the cart, so the second
  // unit comes from the plus, not from tapping ADD again.
  await tap('plus Rice');
  await page.waitForTimeout(700);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1600);

  text = await body();
  check('the cart offers a customer', /Choose a customer/.test(text), text.slice(0, 900));
  await tap('Choose a customer');
  await page.waitForTimeout(1200);
  await tap('Ramesh Bhai');
  await page.waitForTimeout(1200);

  text = await body();
  check('  and now shows who the sale is for', /Ramesh Bhai/.test(text), text.slice(0, 900));
  check('  with a "paid now" box that only exists for them',
    /Paid now/.test(text), text.slice(0, 1200));

  await page.getByLabel('Paid now', { exact: false }).first().fill('50');
  await page.waitForTimeout(900);
  text = await body();
  check('typing a part payment says what goes on the account',
    /₹150 goes on Ramesh Bhai/.test(text), text.slice(0, 1400));

  await tap('Complete order', { exact: false });
  await page.waitForTimeout(3500);
  await tap('Done', { exact: false }).catch(() => {});
  await page.waitForTimeout(1500);

  const orders = (await get('/orders', token)).orders;
  check('the sale went through', orders.length === 1, orders.length);
  check('  filed under the customer', orders[0].customerName === 'Ramesh Bhai', orders[0].customerName);
  check('  recording what was handed over', orders[0].amountPaid === 50, orders[0].amountPaid);
  check('  and the server says they owe 150',
    await balanceOnServer(ramesh._id) === 150, await balanceOnServer(ramesh._id));

  /* ==================== 4. it shows where it should ==================== */
  console.log('\n=== the debt shows up where you would look for it ===');
  await tapTab('Udhaar');
  await page.waitForTimeout(2500);
  text = await body();
  check('the list now shows the debt', /₹150/.test(text), text.slice(0, 700));
  check('  and counts the person', /1 people owe you/.test(text), text.slice(0, 700));

  await tapTab('Reports');
  await page.waitForTimeout(3500);
  const report = await body();
  check('the report shows what is out on credit', /Out on credit/.test(report), report.slice(0, 1500));
  check('  with the amount', /₹150/.test(report), report.slice(0, 1500));

  /* ==================== 5. the next sale is a walk-in again ==================== */
  console.log('\n=== the customer does not stick to the next sale ===');
  await tapTab('Sell');
  await page.waitForTimeout(1500);
  await tap('ADD Rice');
  await page.waitForTimeout(700);
  await tap('Cart', { exact: false });
  await page.waitForTimeout(1600);
  text = await body();
  check('a fresh cart is a walk-in', /Choose a customer/.test(text), text.slice(0, 900));
  check('  with no "paid now" box', !/Paid now/.test(text), text.slice(0, 1200));
  await tap('Close', { exact: false }).catch(() => {});
  await page.waitForTimeout(900);

  /* ==================== 6. the ledger ==================== */
  console.log('\n=== the ledger reads like a khata ===');
  await tapTab('Udhaar');
  await page.waitForTimeout(2200);
  /**
   * Matched on the ROW's full name ("Ramesh Bhai, owes ₹150"), not on the bare
   * name. The POS customer picker is still mounted behind this screen with a
   * button labelled exactly "Ramesh Bhai", and `.last()` was landing on that
   * hidden one -- a click that can never resolve.
   */
  await page.getByRole('button', { name: /^Ramesh Bhai, / }).last().click();
  await page.waitForTimeout(2500);
  text = await body();
  check('the ledger opens', /Still owes/.test(text), text.slice(0, 600));
  check('  showing the balance', /₹150/.test(text), text.slice(0, 600));
  check('  and the sale that created it', /INV-/.test(text), text.slice(0, 900));
  check('  saying how much of it was paid', /₹50 of ₹200/.test(text), text.slice(0, 900));

  /* ==================== 7. recording a repayment ==================== */
  console.log('\n=== they come back and pay ===');
  await tap('Record a payment');
  await page.waitForTimeout(1500);
  const amountBox = page.getByLabel('Amount received', { exact: false }).first();
  check('the amount is pre-filled with what they owe',
    (await amountBox.inputValue()) === '150', await amountBox.inputValue());

  // A part payment, because that is the case the whole feature exists for.
  await amountBox.fill('100');
  await page.waitForTimeout(500);
  await page.getByRole('radio', { name: 'UPI', exact: true }).last().click();
  await page.waitForTimeout(500);
  await tap('Record a payment');
  const recorded = await waitForText(/₹100 received/, 15000);
  check('the payment is recorded', recorded.ok, recorded.seen.slice(0, 400));

  await page.waitForTimeout(2000);
  text = await body();
  check('  and the balance on screen came down', /₹50/.test(text), text.slice(0, 700));
  check('  which is what the server says',
    await balanceOnServer(ramesh._id) === 50, await balanceOnServer(ramesh._id));
  check('  the repayment is in the ledger', /Paid back ₹100/.test(text), text.slice(0, 900));

  /* ==================== 8. undoing a mis-entered payment ==================== */
  console.log('\n=== undoing a payment entered by mistake ===');
  await tap('Undo ₹100', { exact: false });
  await page.waitForTimeout(1300);
  await tap('Undo');
  const undone = await waitForText(/Payment removed/, 15000);
  check('it can be undone', undone.ok, undone.seen.slice(0, 400));
  await page.waitForTimeout(1800);
  check('  and the debt goes back up',
    await balanceOnServer(ramesh._id) === 150, await balanceOnServer(ramesh._id));
  check('  on screen too', /₹150/.test(await body()), (await body()).slice(0, 600));

  /* ============ 9. a debtor cannot be deleted by accident ============ */
  console.log('\n=== deleting a debtor asks what it really means ===');
  await tap('Back');
  await page.waitForTimeout(2000);
  await tap('Delete Ramesh Bhai');
  await page.waitForTimeout(1300);
  const dialog = await body();
  check('it warns the debt would be written off',
    /writes that debt off/i.test(dialog), dialog.slice(0, 700));
  check('  naming the amount', /₹150/.test(dialog), dialog.slice(0, 700));
  check('  and the button says so', /Write off and delete/.test(dialog), dialog.slice(0, 700));

  await tap('Cancel');
  await page.waitForTimeout(1200);
  check('backing out keeps them', (await get('/customers', token)).customers.length === 1);
  check('  and keeps the debt', await balanceOnServer(ramesh._id) === 150);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
