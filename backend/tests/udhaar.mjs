/**
 * Credit: who owes the shop money, and what they have paid back.
 *
 * The property the whole feature rests on is that the balance is DERIVED, every
 * time, from receipts and repayments:
 *
 *     balance = SUM(grandTotal - amountPaid) - SUM(payments)
 *
 * Nothing is stored, so nothing can drift. The assertions below try to make it
 * drift anyway -- by voiding a credit sale, editing one after the fact, undoing
 * a repayment, deleting a customer, restoring a backup -- and check that the
 * arithmetic still comes out the same.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5185;
const API = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`));
};

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ launchTimeout: 120_000 }],
});
const uri = replSet.getUri();

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test', MONGODB_URI: uri,
    MONGODB_DB: 'udhaartest', JWT_SECRET: 'udhaar-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'udhaar-admin',
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const shutdown = async (code) => { server.kill(); await replSet.stop(); process.exit(code); };

for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 500));
}

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
};

try {
  const shop = 'Udhaar ' + crypto.randomBytes(3).toString('hex');
  const token = (await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } })).body.token;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;
  const rice = (await api('POST', '/products', {
    token, body: { name: 'Rice', categoryId: cat._id, price: 100, cost: 60, stock: 500 },
  })).body.product;

  const balanceOf = async (id) =>
    (await api('GET', `/customers/${id}`, { token })).body.customer.balance;
  const sell = (body) => api('POST', '/orders', { token, body });

  /* ==================== 1. a customer ==================== */
  console.log('\n=== a customer starts owing nothing ===');
  const made = await api('POST', '/customers', {
    token, body: { name: '  Ramesh   Bhai ', phone: '+91 98765 43210' },
  });
  check('creating a customer -> 201', made.status === 201, made.body);
  const ramesh = made.body.customer;
  check('  the name is tidied like a product name', ramesh.name === 'Ramesh Bhai', ramesh.name);
  check('  and they owe nothing yet', ramesh.balance === 0, ramesh.balance);

  const dup = await api('POST', '/customers', { token, body: { name: 'ramesh bhai' } });
  check('the same name again -> 409', dup.status === 409, dup.body);
  check('  case-insensitively', /already have a customer/i.test(dup.body?.error ?? ''), dup.body?.error);

  /* ============ 2. a sale paid in full changes nothing ============ */
  console.log('\n=== a sale that was paid for is not a debt ===');
  const paid = await sell({ customerId: ramesh._id, items: [{ productId: rice._id, qty: 2 }] });
  check('a normal sale to a customer -> 201', paid.status === 201, paid.body);
  check('  it is filed under their name', paid.body.order.customerName === 'Ramesh Bhai',
    paid.body.order.customerName);
  check('  and they still owe nothing', await balanceOf(ramesh._id) === 0, await balanceOf(ramesh._id));

  /* ==================== 3. udhaar ==================== */
  console.log('\n=== selling on credit ===');
  const partial = await sell({
    customerId: ramesh._id, amountPaid: 100, items: [{ productId: rice._id, qty: 5 }],
  });
  check('a part-paid sale -> 201', partial.status === 201, partial.body);
  check('  the receipt records what was handed over', partial.body.order.amountPaid === 100,
    partial.body.order.amountPaid);
  check('  and what is still owed on it', partial.body.order.balanceDue === 400,
    partial.body.order.balanceDue);
  check('the customer now owes 400', await balanceOf(ramesh._id) === 400, await balanceOf(ramesh._id));

  const nothing = await sell({
    customerId: ramesh._id, amountPaid: 0, items: [{ productId: rice._id, qty: 1 }],
  });
  check('a sale paid for with nothing at all -> 201', nothing.status === 201, nothing.body);
  check('  the debt grows to 500', await balanceOf(ramesh._id) === 500, await balanceOf(ramesh._id));

  /* ============ 4. credit needs somebody to collect from ============ */
  console.log('\n=== a walk-in cannot owe money ===');
  const anon = await sell({ amountPaid: 10, items: [{ productId: rice._id, qty: 1 }] });
  check('a part-paid walk-in sale -> 400', anon.status === 400, anon.body);
  check('  and says why', /nobody to collect from/i.test(anon.body?.error ?? ''), anon.body?.error);

  const over = await sell({
    customerId: ramesh._id, amountPaid: 5000, items: [{ productId: rice._id, qty: 1 }],
  });
  check('paying more than the bill -> 400', over.status === 400, over.body);
  check('  and neither attempt changed the debt',
    await balanceOf(ramesh._id) === 500, await balanceOf(ramesh._id));

  const ghost = await sell({
    customerId: '0123456789abcdef01234567', amountPaid: 0, items: [{ productId: rice._id, qty: 1 }],
  });
  check('a customer from nowhere -> 400', ghost.status === 400, ghost.body);

  /* ==================== 5. paying it back ==================== */
  console.log('\n=== paying it back ===');
  const pay1 = await api('POST', `/customers/${ramesh._id}/payments`, {
    token, body: { amount: 200, method: 'upi', note: 'part payment' },
  });
  check('recording a repayment -> 201', pay1.status === 201, pay1.body);
  check('  and it says the new balance', pay1.body.balance === 300, pay1.body.balance);
  check('  which the ledger agrees with', await balanceOf(ramesh._id) === 300, await balanceOf(ramesh._id));

  const zero = await api('POST', `/customers/${ramesh._id}/payments`, { token, body: { amount: 0 } });
  check('a zero repayment -> 400', zero.status === 400, zero.body);
  const negative = await api('POST', `/customers/${ramesh._id}/payments`, { token, body: { amount: -50 } });
  check('a negative repayment -> 400', negative.status === 400, negative.body);

  /**
   * Overpayment IS allowed: settling a 300 debt with a 500 note leaves 200 on
   * account, and refusing it sends the shopkeeper back to paper for exactly the
   * case the app most needs to handle.
   */
  const pay2 = await api('POST', `/customers/${ramesh._id}/payments`, { token, body: { amount: 500 } });
  check('paying more than owed is allowed', pay2.status === 201, pay2.body);
  check('  and shows as the shop owing them', pay2.body.balance === -200, pay2.body.balance);

  const undo = await api('DELETE', `/payments/${pay2.body.payment._id}`, { token });
  check('a mis-entered repayment can be undone', undo.status === 200, undo.body);
  check('  and the balance goes back', undo.body.balance === 300, undo.body.balance);

  /* ==================== 6. the ledger reads like a khata ==================== */
  console.log('\n=== the ledger ===');
  const detail = await api('GET', `/customers/${ramesh._id}`, { token });
  const timeline = detail.body.timeline;
  check('sales and repayments are in one list',
    timeline.some((e) => e.type === 'sale') && timeline.some((e) => e.type === 'payment'),
    timeline.map((e) => e.type));
  check('  newest first',
    timeline.every((e, i) => i === 0 || new Date(timeline[i - 1].at) >= new Date(e.at)),
    timeline.map((e) => e.at));
  check('  a sale says what it added to the debt',
    timeline.find((e) => e.type === 'sale' && e.credited === 400) !== undefined,
    timeline.filter((e) => e.type === 'sale').map((e) => e.credited));
  check('  a fully paid sale added nothing',
    timeline.some((e) => e.type === 'sale' && e.credited === 0),
    timeline.filter((e) => e.type === 'sale').map((e) => e.credited));
  check('  the undone repayment is gone from it',
    timeline.filter((e) => e.type === 'payment').length === 1,
    timeline.filter((e) => e.type === 'payment'));
  check('the totals add up',
    detail.body.customer.credited - detail.body.customer.repaid === detail.body.customer.balance,
    detail.body.customer);

  /* ============ 7. voiding a credit sale clears its debt ============ */
  console.log('\n=== a voided credit sale stops being owed ===');
  await api('DELETE', `/orders/${nothing.body.order._id}`, { token });
  check('voiding the 100 sale drops the debt to 200',
    await balanceOf(ramesh._id) === 200, await balanceOf(ramesh._id));

  /* ============ 8. correcting a sale after the fact ============ */
  console.log('\n=== "they paid the rest" ===');
  const settled = await api('PATCH', `/orders/${partial.body.order._id}`, {
    token, body: { amountPaid: 500 },
  });
  check('marking it paid in full -> 200', settled.status === 200, settled.body);
  check('  the debt from that sale is gone',
    await balanceOf(ramesh._id) === -200, await balanceOf(ramesh._id));

  /**
   * Back to 200, not to zero: the 400 that sale put on the ledger comes back,
   * and the 200 already repaid stays repaid. Running total from here: 200.
   */
  const back = await api('PATCH', `/orders/${partial.body.order._id}`, {
    token, body: { amountPaid: 100 },
  });
  check('  and it can be put back', back.status === 200 && await balanceOf(ramesh._id) === 200,
    await balanceOf(ramesh._id));

  /* ============ 9. moving a walk-in sale onto a ledger ============ */
  console.log('\n=== "that one was actually for Ramesh" ===');
  const walkIn = await sell({ items: [{ productId: rice._id, qty: 3 }] });
  const moved = await api('PATCH', `/orders/${walkIn.body.order._id}`, {
    token, body: { customerId: ramesh._id, amountPaid: 0 },
  });
  check('moving it and part-paying in one edit -> 200', moved.status === 200, moved.body);
  // 200 carried, plus the 300 sale just moved onto the ledger unpaid.
  check('  the debt is now 500', await balanceOf(ramesh._id) === 500, await balanceOf(ramesh._id));
  check('  and the receipt reads under their name',
    moved.body.order.customerName === 'Ramesh Bhai', moved.body.order.customerName);

  /* ==================== 10. who owes me ==================== */
  console.log('\n=== who owes me ===');
  const sita = (await api('POST', '/customers', { token, body: { name: 'Sita' } })).body.customer;
  await sell({ customerId: sita._id, amountPaid: 0, items: [{ productId: rice._id, qty: 9 }] });
  const clear = (await api('POST', '/customers', { token, body: { name: 'Anil' } })).body.customer;
  await sell({ customerId: clear._id, items: [{ productId: rice._id, qty: 1 }] });

  const all = await api('GET', '/customers', { token });
  check('the list carries every balance',
    all.body.customers.length === 3 && all.body.customers.every((c) => 'balance' in c),
    all.body.customers.map((c) => [c.name, c.balance]));
  // Ramesh 500 + Sita 900. Anil paid for his, so he is not on the street.
  check('  and totals what is on the street', all.body.totals.owed === 1400, all.body.totals);
  check('  counting only the people who owe', all.body.totals.owing === 2, all.body.totals);

  const owing = await api('GET', '/customers?owing=1', { token });
  check('the "owing" filter drops whoever is square',
    owing.body.customers.length === 2, owing.body.customers.map((c) => c.name));
  check('  worst first', owing.body.customers[0].name === 'Sita', owing.body.customers.map((c) => c.name));

  const search = await api('GET', '/customers?search=98765', { token });
  check('searching by phone finds them', search.body.customers.length === 1
    && search.body.customers[0].name === 'Ramesh Bhai', search.body.customers.map((c) => c.name));

  /* ==================== 11. the report ==================== */
  console.log('\n=== the summary says what is owed ===');
  const summary = (await api('GET', '/reports/summary', { token })).body;
  check('receivables are on the summary', summary.receivables?.owed === 1400, summary.receivables);
  check('  and the count of debtors', summary.receivables?.owing === 2, summary.receivables);

  /**
   * Deliberately NOT scoped to the reporting window: a debt is outstanding
   * until it is paid, and a figure that shrank every time the date filter
   * narrowed would mean something nobody asked for.
   */
  const narrow = (await api('GET', '/reports/summary?from=2020-01-01&to=2020-01-02', { token })).body;
  check('and it does not shrink when the period narrows',
    narrow.receivables?.owed === 1400, narrow.receivables);
  check('  even though the period itself is empty', narrow.sales.orders === 0, narrow.sales.orders);

  /* ==================== 12. deleting a debtor ==================== */
  console.log('\n=== a debt is not deleted by deleting the debtor ===');
  const refused = await api('DELETE', `/customers/${sita._id}`, { token });
  check('deleting someone who owes -> 409', refused.status === 409, refused.body);
  check('  naming the amount', refused.body.details?.balance === 900, refused.body.details);
  check('  and they are still there',
    (await api('GET', '/customers', { token })).body.customers.length === 3);

  const written = await api('DELETE', `/customers/${sita._id}?force=true`, { token });
  check('writing it off has to be said out loud', written.status === 200, written.body);
  check('  and then they are gone',
    (await api('GET', '/customers', { token })).body.customers.length === 2);

  const squared = await api('DELETE', `/customers/${clear._id}`, { token });
  check('somebody who owes nothing deletes normally', squared.status === 200, squared.body);

  /* ==================== 13. a backup carries the ledger ==================== */
  console.log('\n=== the ledger survives a backup ===');
  const backup = (await api('GET', '/backup/export', { token })).body.backup;
  check('customers are in the file', backup.counts.customers >= 1, backup.counts);
  check('  and repayments', backup.counts.payments >= 1, backup.counts);

  const fresh = 'Restored ' + crypto.randomBytes(3).toString('hex');
  const t2 = (await api('POST', '/auth/register', { body: { businessName: fresh, pin: '1111' } })).body.token;
  const restored = await api('POST', '/backup/restore', { token: t2, body: { backup } });
  check('restoring it -> 200', restored.status === 200, restored.body);

  const restoredList = (await api('GET', '/customers', { token: t2 })).body;
  check('the same people come back',
    restoredList.customers.length === 1 && restoredList.customers[0].name === 'Ramesh Bhai',
    restoredList.customers.map((c) => c.name));
  /**
   * The assertion that catches a restore which dropped the customer link: the
   * sales would all be there and nobody would owe anything.
   */
  check('  owing exactly what they owed', restoredList.totals.owed === 500, restoredList.totals);
  const restoredLedger = (await api('GET', `/customers/${restoredList.customers[0]._id}`, { token: t2 })).body;
  check('  with their repayment still in the ledger',
    restoredLedger.timeline.some((e) => e.type === 'payment' && e.amount === 200),
    restoredLedger.timeline.filter((e) => e.type === 'payment'));
  check('  and their sales', restoredLedger.timeline.filter((e) => e.type === 'sale').length >= 2,
    restoredLedger.timeline.filter((e) => e.type === 'sale').length);

  /* ==================== 14. tenant isolation ==================== */
  console.log('\n=== none of it crosses tenants ===');
  const peek = await api('GET', `/customers/${ramesh._id}`, { token: t2 });
  check("another shop reading my customer -> 404", peek.status === 404, peek.body);
  const payOther = await api('POST', `/customers/${ramesh._id}/payments`, {
    token: t2, body: { amount: 50 },
  });
  check('  or crediting them -> 404', payOther.status === 404, payOther.body);
  check('  and my balance is untouched', await balanceOf(ramesh._id) === 500, await balanceOf(ramesh._id));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
