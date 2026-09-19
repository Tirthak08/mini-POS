/**
 * Goods that come back.
 *
 * Before this, the only way to undo any part of a sale was to void the whole
 * thing -- which says the sale never happened, on the day it happened. A
 * customer returning one of three packets a week later is neither a void nor an
 * edit, and pretending it is one of those quietly rewrites a day the shop has
 * already counted, banked and reported on.
 *
 * The properties pinned down here:
 *   - stock comes back, once, and the ledger says why
 *   - you cannot return more than you sold, however you arrange the requests
 *   - the refund is what was CHARGED, not what is on the shelf label
 *   - money out of the till lowers the drawer; money off a khata lowers the debt
 *   - and the profit figure nets BOTH the refund and the cost of the returned goods
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5187;
const API = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 320) : ''}`));
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
    MONGODB_DB: 'returntest', JWT_SECRET: 'return-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'return-admin',
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
  const shop = 'Returns ' + crypto.randomBytes(3).toString('hex');
  const token = (await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } })).body.token;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;
  const mk = async (name, extra) => (await api('POST', '/products', {
    token, body: { name, categoryId: cat._id, price: 100, cost: 60, stock: 500, ...extra },
  })).body.product;

  const rice = await mk('Rice');                      // pieces, 100 / 60
  const atta = await mk('Atta', { unit: 'kg', price: 40, cost: 25 });
  const stockOf = async (id) => (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(id)).stock;

  /* ==================== 1. the ordinary case ==================== */
  console.log('\n=== one of three comes back ===');
  const sale = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 3 }] },
  })).body.order;
  check('the sale went through', sale.grandTotal === 300, sale.grandTotal);
  check('  and took the stock', await stockOf(rice._id) === 497, await stockOf(rice._id));

  const ret = await api('POST', `/orders/${sale._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 1 }], reason: 'Torn packet' },
  });
  check('the return is accepted', ret.status === 201, ret.body);
  check('  refunding what one was charged at', ret.body.return.refundTotal === 100, ret.body.return);
  check('  numbered as a credit note, not a receipt',
    ret.body.return.creditNoteNo === 'CN-000001', ret.body.return.creditNoteNo);
  check('  the stock is back on the shelf', await stockOf(rice._id) === 498, await stockOf(rice._id));
  check('  and the original receipt is untouched',
    (await api('GET', `/orders/${sale._id}`, { token })).body.order.grandTotal === 300);

  /* The ledger endpoint answers with a merged `timeline` -- adjustments and
     sales together -- because that is the only order in which a discrepancy
     can be read. */
  const movements = (await api('GET', `/products/${rice._id}/movements`, { token })).body;
  const returnRow = (movements.timeline ?? []).find((m) => m.reason === 'return');
  check('the stock ledger says why it moved', Boolean(returnRow),
    (movements.timeline ?? []).map((m) => m.reason ?? m.type));
  check('  by exactly one unit', returnRow?.delta === 1, returnRow?.delta);
  check('  naming the credit note and the receipt',
    /CN-000001/.test(returnRow?.note ?? '') && /INV-/.test(returnRow?.note ?? ''), returnRow?.note);

  const reread = (await api('GET', `/orders/${sale._id}`, { token })).body.order;
  check('the receipt now says what has come back', reread.items[0].returned === 1, reread.items[0]);
  check('  and what still could', reread.items[0].returnable === 2, reread.items[0]);
  check('  with the money refunded against it', reread.returnedTotal === 100, reread.returnedTotal);

  /* ==================== 2. you cannot return what you did not sell ========= */
  console.log('\n=== the quantity is bounded by the receipt ===');
  let bad = await api('POST', `/orders/${sale._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 3 }] },
  });
  check('returning more than is left is refused', bad.status === 400, bad.body);
  check('  saying how many can still come back',
    /at most 2|Only 2/i.test(JSON.stringify(bad.body)), bad.body);
  check('  and nothing moved', await stockOf(rice._id) === 498, await stockOf(rice._id));

  bad = await api('POST', `/orders/${sale._id}/returns`, {
    token, body: { items: [{ productId: atta._id, qty: 1 }] },
  });
  check('an item that was never on the receipt is refused', bad.status === 400, bad.body);

  bad = await api('POST', `/orders/${sale._id}/returns`, { token, body: { items: [] } });
  check('a return of nothing is refused', bad.status === 400, bad.body);

  bad = await api('POST', `/orders/${sale._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 1 }, { productId: rice._id, qty: 1 }] },
  });
  check('the same item listed twice is refused, not silently doubled',
    bad.status === 400, bad.body);
  check('  and still nothing moved', await stockOf(rice._id) === 498, await stockOf(rice._id));

  /* Two returns in sequence must not be able to exceed the sale between them. */
  const second = await api('POST', `/orders/${sale._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 2 }] },
  });
  check('the rest can come back in a second trip', second.status === 201, second.body);
  check('  and then there is nothing left to return',
    (await api('POST', `/orders/${sale._id}/returns`, {
      token, body: { items: [{ productId: rice._id, qty: 1 }] },
    })).status === 400);
  check('  the shelf holds exactly what it started with',
    await stockOf(rice._id) === 500, await stockOf(rice._id));

  /* ==================== 3. the refund is what was charged ================== */
  console.log('\n=== a discounted line refunds at the discounted rate ===');
  const discounted = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 4, discount: 100 }] },   // 400 - 100 = 300, so 75 each
  })).body.order;
  const dRet = await api('POST', `/orders/${discounted._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 2 }] },
  });
  check('two of four refund 150, not 200', dRet.body.return.refundTotal === 150, dRet.body.return);
  check('  because the unit rate is the line total over the quantity',
    dRet.body.return.lines[0].price === 75, dRet.body.return.lines[0]);

  console.log('\n=== fractions follow the unit, same as selling ===');
  const kgSale = (await api('POST', '/orders', {
    token, body: { items: [{ productId: atta._id, qty: 2.5 }] },
  })).body.order;
  const half = await api('POST', `/orders/${kgSale._id}/returns`, {
    token, body: { items: [{ productId: atta._id, qty: 0.5 }] },
  });
  check('half a kilo can come back', half.status === 201, half.body);
  check('  refunded at 40 a kilo', half.body.return.refundTotal === 20, half.body.return.refundTotal);
  const riceSale = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 2 }] },
  })).body.order;
  check('half a packet cannot',
    (await api('POST', `/orders/${riceSale._id}/returns`, {
      token, body: { items: [{ productId: rice._id, qty: 0.5 }] },
    })).status === 400);

  /* ==================== 4. a voided sale ==================== */
  console.log('\n=== a cancelled sale has nothing to return ===');
  const doomed = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1 }] },
  })).body.order;
  await api('DELETE', `/orders/${doomed._id}`, { token });
  const afterVoid = await api('POST', `/orders/${doomed._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 1 }] },
  });
  check('returning against it is refused', afterVoid.status === 400, afterVoid.body);
  check('  and says the stock already went back',
    /cancelled|already went back/i.test(JSON.stringify(afterVoid.body)), afterVoid.body);

  /* ==================== 5. udhaar ==================== */
  console.log('\n=== a refund on a khata is not a handful of cash ===');
  const ramesh = (await api('POST', '/customers', { token, body: { name: 'Ramesh Bhai' } })).body.customer;
  const onCredit = (await api('POST', '/orders', {
    token, body: { customerId: ramesh._id, amountPaid: 0, items: [{ productId: rice._id, qty: 5 }] },
  })).body.order;
  const balance = async () => (await api('GET', `/customers/${ramesh._id}`, { token })).body.customer.balance;
  check('they owe 500', await balance() === 500, await balance());

  const credited = await api('POST', `/orders/${onCredit._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 2 }], refundMethod: 'credit' },
  });
  check('the return is credited to the account', credited.status === 201, credited.body);
  check('  and the debt comes down by the refund', await balance() === 300, await balance());

  const ledger = (await api('GET', `/customers/${ramesh._id}`, { token })).body.timeline;
  check('  the khata shows the credit note',
    ledger.some((e) => e.type === 'refund' && e.amount === 200), ledger.map((e) => e.type));

  const walkIn = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 1 }] },
  })).body.order;
  const noAccount = await api('POST', `/orders/${walkIn._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 1 }], refundMethod: 'credit' },
  });
  check('crediting a walk-in sale is refused -- there is no account',
    noAccount.status === 400, noAccount.body);

  /* ==================== 6. the books ==================== */
  console.log('\n=== what the report makes of it ===');
  const fresh = 'Books ' + crypto.randomBytes(3).toString('hex');
  const t2 = (await api('POST', '/auth/register', { body: { businessName: fresh, pin: '1234' } })).body.token;
  const c2 = (await api('POST', '/categories', { token: t2, body: { name: 'Grain' } })).body.category;
  const p2 = (await api('POST', '/products', {
    token: t2, body: { name: 'Rice', categoryId: c2._id, price: 100, cost: 60, stock: 100 },
  })).body.product;
  const s2 = (await api('POST', '/orders', {
    token: t2, body: { items: [{ productId: p2._id, qty: 10 }] },      // 1000 revenue, 600 cogs
  })).body.order;

  let sum = (await api('GET', '/reports/summary', { token: t2 })).body;
  check('before any return, revenue is 1000', sum.sales.revenue === 1000, sum.sales.revenue);
  check('  and gross profit 400', sum.sales.grossProfit === 400, sum.sales.grossProfit);
  check('  with 1000 in the drawer', sum.received === 1000, sum.received);

  await api('POST', `/orders/${s2._id}/returns`, {
    token: t2, body: { items: [{ productId: p2._id, qty: 3 }], refundMethod: 'cash' },
  });
  sum = (await api('GET', '/reports/summary', { token: t2 })).body;
  check('the refund is reported', sum.sales.refunds === 300, sum.sales.refunds);
  check('  gross revenue still says what the receipts add up to',
    sum.sales.revenue === 1000, sum.sales.revenue);
  check('  net revenue is what the shop kept', sum.sales.netRevenue === 700, sum.sales.netRevenue);
  /* The goods are back on the shelf, so their cost is no longer a cost.
     Subtracting the refund alone would report 100 and make every return look
     like a total loss of margin. */
  check('  the cost of the returned goods comes back out of COGS',
    sum.sales.netCogs === 420, { netCogs: sum.sales.netCogs, cogs: sum.sales.cogs });
  check('  so gross profit is 280, not 100', sum.sales.grossProfit === 280, sum.sales.grossProfit);
  check('  and the drawer is 300 lighter', sum.received === 700, sum.received);
  const cash = sum.payments.find((p) => p.method === 'cash');
  check('  with the cash row showing the money that went back out',
    cash?.refunded === 300 && cash?.amount === 700, cash);
  check('  three items counted as returned', sum.sales.itemsReturned === 3, sum.sales.itemsReturned);

  /* A refund to a khata must NOT move the drawer figure. */
  const cust2 = (await api('POST', '/customers', { token: t2, body: { name: 'Suresh' } })).body.customer;
  const credSale = (await api('POST', '/orders', {
    token: t2, body: { customerId: cust2._id, amountPaid: 0, items: [{ productId: p2._id, qty: 2 }] },
  })).body.order;
  const beforeReceived = (await api('GET', '/reports/summary', { token: t2 })).body.received;
  await api('POST', `/orders/${credSale._id}/returns`, {
    token: t2, body: { items: [{ productId: p2._id, qty: 2 }], refundMethod: 'credit' },
  });
  sum = (await api('GET', '/reports/summary', { token: t2 })).body;
  check('a refund onto an account leaves the drawer alone',
    sum.received === beforeReceived, { before: beforeReceived, after: sum.received });
  check('  but still comes off the revenue', sum.sales.refunds === 500, sum.sales.refunds);
  check('  and off what they owe',
    (await api('GET', `/customers/${cust2._id}`, { token: t2 })).body.customer.balance === 0);

  /* ==================== 7. undoing a return ==================== */
  console.log('\n=== a return entered by mistake ===');
  const undoSale = (await api('POST', '/orders', {
    token, body: { items: [{ productId: rice._id, qty: 4 }] },
  })).body.order;
  const before = await stockOf(rice._id);
  const toUndo = (await api('POST', `/orders/${undoSale._id}/returns`, {
    token, body: { items: [{ productId: rice._id, qty: 4 }] },
  })).body.return;
  check('the stock came back', await stockOf(rice._id) === before + 4, await stockOf(rice._id));
  const undone = await api('DELETE', `/returns/${toUndo._id}`, { token });
  check('the return can be undone', undone.status === 200, undone.body);
  check('  and the stock goes back out', await stockOf(rice._id) === before, await stockOf(rice._id));
  check('  leaving the receipt returnable again',
    (await api('GET', `/orders/${undoSale._id}`, { token })).body.order.items[0].returnable === 4);
  check('  and gone from the credit note list',
    !(await api('GET', '/returns', { token })).body.returns.some((r) => r._id === toUndo._id));

  /* If the returned goods have been sold again, undoing cannot silently take
     the shelf negative. */
  const tight = await mk('Tight', { stock: 5 });
  const tightSale = (await api('POST', '/orders', {
    token, body: { items: [{ productId: tight._id, qty: 5 }] },
  })).body.order;
  const tightRet = (await api('POST', `/orders/${tightSale._id}/returns`, {
    token, body: { items: [{ productId: tight._id, qty: 5 }] },
  })).body.return;
  await api('POST', '/orders', { token, body: { items: [{ productId: tight._id, qty: 5 }] } });
  const refused = await api('DELETE', `/returns/${tightRet._id}`, { token });
  check('undoing is refused when the goods have been sold again',
    refused.status === 409, refused.body);
  check('  and the shelf is not taken negative', await stockOf(tight._id) === 0, await stockOf(tight._id));

  /* ============ 8. a credit note survives a backup ============ */
  console.log('\n=== the shop is restored somewhere else ===');
  /**
   * The trap this guards is the one that bit the first restore: every document
   * gets a NEW _id in the new shop, so a credit note whose orderId still names
   * the source shop's receipt is a refund hanging off somebody else's sale --
   * and it would look perfectly fine until somebody opened that receipt.
   */
  const backup = (await api('GET', '/backup/export', { token: t2 })).body.backup;
  check('the export carries the credit notes', backup.counts.returns === 2, backup.counts);
  check('  and the credit note counter with them',
    Number(backup.counters?.return) >= 2, backup.counters);

  const heir = 'Heir ' + crypto.randomBytes(3).toString('hex');
  const t3 = (await api('POST', '/auth/register', { body: { businessName: heir, pin: '1234' } })).body.token;
  const restored = await api('POST', '/backup/restore', { token: t3, body: { backup } });
  check('the restore succeeds', restored.status === 200, restored.body);

  const heirReturns = (await api('GET', '/returns', { token: t3 })).body.returns;
  check('  both credit notes came back', heirReturns.length === 2, heirReturns.length);

  const heirOrders = (await api('GET', '/orders?limit=100', { token: t3 })).body.orders;
  const heirProducts = (await api('GET', '/products', { token: t3 })).body.products;
  check('  each one points at a receipt in THIS shop',
    heirReturns.every((r) => heirOrders.some((o) => String(o._id) === String(r.orderId))),
    { returns: heirReturns.map((r) => r.orderId), orders: heirOrders.map((o) => o._id) });
  check('  and at a product in this shop',
    heirReturns.every((r) => r.lines.every((l) =>
      heirProducts.some((pr) => String(pr._id) === String(l.productId)))),
    heirReturns.flatMap((r) => r.lines.map((l) => l.productId)));
  check('  the receipt it reads off still knows what came back',
    (await api('GET', `/orders/${heirReturns[0].orderId}`, { token: t3 })).body.order.returnedTotal > 0);
  check('  and the next credit note does not reuse a number',
    (await api('POST', `/orders/${heirOrders.find((o) => o.items.some((i) => i.qty >= 10))?._id}/returns`, {
      token: t3, body: { items: [{ productId: heirProducts[0]._id, qty: 1 }] },
    })).body.return?.returnNumber > 2);

  /* ==================== 9. it is still one shop's data ==================== */
  console.log('\n=== another shop cannot reach in ===');
  const outsider = (await api('POST', '/auth/register', {
    body: { businessName: 'Outsider ' + crypto.randomBytes(3).toString('hex'), pin: '1234' },
  })).body.token;
  const trespass = await api('POST', `/orders/${sale._id}/returns`, {
    token: outsider, body: { items: [{ productId: rice._id, qty: 1 }] },
  });
  check('returning against somebody else\'s receipt is not found',
    trespass.status === 404, trespass.status);
  check('  and their credit note list is empty',
    (await api('GET', '/returns', { token: outsider })).body.returns.length === 0);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
