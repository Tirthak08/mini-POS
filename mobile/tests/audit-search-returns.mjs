/**
 * AUDIT 5 — finding an old receipt, and putting part of a sale back.
 *
 * Both of these are about a sale that has already happened and has already
 * been counted, which is what makes them worth driving through the real
 * screens rather than the API alone: the numbers they change are numbers
 * somebody has already read once.
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
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 340) : ''}`));
};
const money = (n) => `₹${n.toLocaleString('en-IN')}`;

/* ------------------------------ a shop with a past ------------------------------ */
const shop = 'Audit5 ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Grain' }, token)).category;
const mk = async (n, extra) => (await req('/products', {
  name: n, categoryId: cat._id, price: 100, cost: 60, stock: 400, ...extra,
}, token)).product;
const rice = await mk('Rice');
const atta = await mk('Atta', { unit: 'kg', price: 40, cost: 25 });

const ramesh = (await req('/customers', { name: 'Ramesh Bhai' }, token)).customer;

/* 60 walk-ins, so the list pages and the interesting receipts are buried. */
for (let i = 0; i < 60; i += 1) await req('/orders', { items: [{ productId: rice._id, qty: 1 }] }, token);

/** The one that gets searched for: a named customer, a memorable total. */
const target = (await req('/orders', {
  customerId: ramesh._id, amountPaid: 0, items: [{ productId: rice._id, qty: 7 }],
}, token)).order;                                        // 700, on credit

/** The one that gets partly returned: three packets, one comes back. */
const returnable = (await req('/orders', {
  items: [{ productId: rice._id, qty: 3 }], paymentMethod: 'cash',
}, token)).order;                                        // 300 cash

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
const waitForText = async (re, ms = 14000) => {
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

const search = async (q) => {
  const box = page.getByLabel('Search sales', { exact: false }).first();
  await box.fill(q);
  // The field is debounced, then the request goes out.
  await page.waitForTimeout(2200);
};

try {
  /* ==================== 1. the list pages ==================== */
  console.log('\n=== a list longer than one page ===');
  await tapTab('Sales');
  await page.waitForTimeout(3200);
  let text = await body();
  check('the sales list opens', /Sales/.test(text), text.slice(0, 300));
  check('  counting every sale, not just the page',
    /\b62\b/.test(text), text.slice(0, 700));
  check('  and offers the rest', /Show \d+ more/.test(text), text.slice(0, 900));
  check('  saying the money tiles only cover what is loaded',
    /of \d+ shown/.test(text), text.slice(0, 900));

  const rowsBefore = await page.getByRole('button', { name: /^INV-/ }).count();
  await tap('Show 12 more', { exact: false });
  await page.waitForTimeout(2500);
  const rowsAfter = await page.getByRole('button', { name: /^INV-/ }).count();
  check('loading more actually adds rows', rowsAfter > rowsBefore, { rowsBefore, rowsAfter });
  check('  and then there is nothing left to load',
    !/Show \d+ more/.test(await body()), (await body()).slice(0, 600));

  /* ==================== 2. searching ==================== */
  console.log('\n=== finding one receipt among sixty ===');
  await search('ramesh');
  text = await body();
  check('a name finds the sale', /Ramesh Bhai/.test(text), text.slice(0, 800));
  check('  and only that one', /Found\s*\n?\s*1\b/.test(text), text.slice(0, 900));
  check('  saying the period filter is not deciding anything',
    /Searching every sale/.test(text), text.slice(0, 900));

  await search(String(target.orderNumber));
  text = await body();
  check('a receipt number finds it too',
    new RegExp(`INV-0*${target.orderNumber}\\b`).test(text), text.slice(0, 800));

  await search('700');
  text = await body();
  check('so does the amount it came to', /₹700/.test(text), text.slice(0, 800));

  await search('zzzz');
  text = await body();
  check('a search that matches nothing says so, by name',
    /Nothing matches "zzzz"/.test(text), text.slice(0, 700));
  check('  and suggests what to try', /receipt number/i.test(text), text.slice(0, 900));

  await tap('Clear');
  await page.waitForTimeout(2400);
  text = await body();
  check('clearing brings the whole list back', /\b62\b/.test(text), text.slice(0, 700));
  check('  and the search notice is gone', !/Searching every sale/.test(text), text.slice(0, 500));

  /**
   * The search must reach OUTSIDE the period on screen, which is the whole
   * reason it ignores the date window. Narrow the filter to a day with no
   * sales, then search: the sale is still found.
   */
  console.log('\n=== the period filter does not hide what you search for ===');
  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1200);
  await tap('Yesterday');
  await page.waitForTimeout(2500);
  check('yesterday has no sales', /No sales yet/.test(await body()), (await body()).slice(0, 600));
  await search('ramesh');
  check('  but the search still finds one', /Ramesh Bhai/.test(await body()), (await body()).slice(0, 700));
  await tap('Clear');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1200);
  await tap('Today');
  await page.waitForTimeout(2500);

  /* ==================== 3. returning part of a sale ==================== */
  console.log('\n=== one of three packets comes back ===');
  const stockBefore = await stockOf(rice._id);
  await search(String(returnable.orderNumber));
  await page.getByRole('button', { name: new RegExp(`^INV-0*${returnable.orderNumber},`) }).last().click();
  await page.waitForTimeout(2600);
  text = await body();
  check('the receipt opens', /₹300/.test(text), text.slice(0, 900));
  check('  and offers to take items back', /Return items/.test(text), text.slice(0, 1200));

  await tap('Return items', { exact: false });
  await page.waitForTimeout(2000);
  text = await body();
  check('the return sheet opens', /Tick what came back/.test(text), text.slice(0, 900));
  check('  saying how much of the line can come back',
    /3 pcs can come back/.test(text), text.slice(0, 900));

  const confirm = page.getByRole('button', { name: 'Record return', exact: true }).last();
  check('  and will not record a return of nothing', await confirm.isDisabled(), await confirm.isDisabled());

  await page.getByRole('checkbox', { name: 'Rice', exact: false }).last().click();
  await page.waitForTimeout(900);
  text = await body();
  check('ticking a line fills in everything that is left', /Refunding[\s\S]*₹300/.test(text), text.slice(0, 1200));

  const qtyBox = page.getByLabel('How many Rice', { exact: false }).last();
  await qtyBox.fill('5');
  await page.waitForTimeout(900);
  text = await body();
  check('asking for more than was sold is called out', /Only 3 can come back/.test(text), text.slice(0, 1200));
  check('  and the button will not submit it', await confirm.isDisabled(), await confirm.isDisabled());

  await qtyBox.fill('1.5');
  await page.waitForTimeout(900);
  check('half a packet is called out too', /Whole pcs only/.test(await body()), (await body()).slice(0, 1200));

  await qtyBox.fill('1');
  await page.waitForTimeout(900);
  text = await body();
  check('one packet refunds ₹100', /Refunding[\s\S]*₹100/.test(text), text.slice(0, 1200));
  check('  and the button is live again', !(await confirm.isDisabled()), await confirm.isDisabled());

  await confirm.click();
  const done = await waitForText(/CN-\d+/, 16000);
  check('the return is recorded, with a credit note number', done.ok, done.seen.slice(0, 500));

  await page.waitForTimeout(2500);
  check('the stock came back', await stockOf(rice._id) === stockBefore + 1,
    { before: stockBefore, after: await stockOf(rice._id) });

  const server = (await get(`/orders/${returnable._id}`, token)).order;
  check('  the server agrees one came back', server.items[0].returned === 1, server.items[0]);
  check('  and ₹100 was refunded against the receipt', server.returnedTotal === 100, server.returnedTotal);

  /* ==================== 4. the receipt says so afterwards ==================== */
  console.log('\n=== the receipt no longer looks untouched ===');
  await search(String(returnable.orderNumber));
  await page.getByRole('button', { name: new RegExp(`^INV-0*${returnable.orderNumber},`) }).last().click();
  await page.waitForTimeout(2800);
  text = await body();
  check('the line says what came back', /1 of 3 returned/.test(text), text.slice(0, 1200));
  check('  the total says what was refunded', /Returned[\s\S]*₹100/.test(text), text.slice(0, 1400));
  check('  and what the sale was actually worth', /Kept[\s\S]*₹200/.test(text), text.slice(0, 1400));

  await tap('Return items', { exact: false });
  await page.waitForTimeout(1800);
  check('a second return offers only what is left',
    /2 pcs can come back/.test(await body()), (await body()).slice(0, 900));
  check('  and says what already went back',
    /1 already returned/.test(await body()), (await body()).slice(0, 900));
  await tap('Close', { exact: false }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1200);

  /* ==================== 5. the books ==================== */
  console.log('\n=== what the report makes of it ===');
  await tapTab('Reports');
  await page.waitForTimeout(3600);
  text = await body();
  const summary = await get('/reports/summary', token);
  check('the report shows the refund', /Returned/.test(text), text.slice(0, 1800));
  check('  as ₹100', text.includes(money(100)), text.slice(0, 1800));
  check('  with net revenue beside it', /Net revenue/.test(text), text.slice(0, 1800));
  check('  and revenue still says what the receipts add up to',
    text.includes(money(summary.sales.revenue)), { revenue: summary.sales.revenue, text: text.slice(0, 900) });
  check('the drawer figure is lighter by the refund',
    summary.received === 6000 + 300 - 100, summary.received);
  const cash = summary.payments.find((p) => p.method === 'cash');
  check('  and the cash row says money went back out',
    cash?.refunded === 100, cash);

  /* ==================== 6. a refund onto a khata ==================== */
  console.log('\n=== a customer with a running account ===');
  const balance = async () => (await get(`/customers/${ramesh._id}`, token)).customer.balance;
  check('Ramesh owes ₹700', await balance() === 700, await balance());

  await tapTab('Sales');
  await page.waitForTimeout(2600);
  await search(String(target.orderNumber));
  await page.getByRole('button', { name: new RegExp(`^INV-0*${target.orderNumber},`) }).last().click();
  await page.waitForTimeout(2600);
  await tap('Return items', { exact: false });
  await page.waitForTimeout(2000);
  text = await body();
  /* The sale was on an account, so taking it off the debt is the default --
     nobody hands a khata customer cash and collects it again the same day. */
  check('crediting the account is offered', /Off what they owe/.test(text), text.slice(0, 1400));
  check('  and is what it starts on',
    await page.getByRole('radio', { name: 'Off what they owe', exact: false })
      .last().getAttribute('aria-checked') === 'true');
  check('  explaining that no money changes hands',
    /Nothing changes hands/.test(text), text.slice(0, 1600));

  await page.getByRole('checkbox', { name: 'Rice', exact: false }).last().click();
  await page.waitForTimeout(800);
  await page.getByLabel('How many Rice', { exact: false }).last().fill('2');
  await page.waitForTimeout(900);
  const receivedBefore = (await get('/reports/summary', token)).received;
  await page.getByRole('button', { name: 'Record return', exact: true }).last().click();
  const credited = await waitForText(/CN-\d+/, 16000);
  check('the credit note is recorded', credited.ok, credited.seen.slice(0, 400));
  await page.waitForTimeout(2500);

  check('the debt comes down by the refund', await balance() === 500, await balance());
  check('  and the drawer does NOT move -- no money changed hands',
    (await get('/reports/summary', token)).received === receivedBefore,
    { before: receivedBefore, after: (await get('/reports/summary', token)).received });

  await tapTab('Udhaar');
  await page.waitForTimeout(2600);
  await page.getByRole('button', { name: /^Ramesh Bhai, / }).last().click();
  await page.waitForTimeout(2600);
  text = await body();
  check('the khata shows the new balance', /₹500/.test(text), text.slice(0, 800));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
