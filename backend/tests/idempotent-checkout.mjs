/**
 * Sending the same sale twice.
 *
 * This is what makes an offline queue safe to build. A checkout that timed out
 * may well have been applied -- the reply is what got lost -- so the phone
 * cannot tell "never arrived" from "arrived, answer lost". Before `clientRef`
 * the only safe policy was never to retry, which is why a sale with no signal
 * simply failed.
 *
 * The property: for a given clientRef, the shop ends up with exactly one
 * receipt, one stock deduction and one set of numbers, no matter how many times
 * the request arrives or how closely the copies overlap.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5184;
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
    MONGODB_DB: 'idemtest', JWT_SECRET: 'idem-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'idem-admin',
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

const ref = () => `q${crypto.randomBytes(8).toString('hex')}`;

try {
  const shop = 'Idem ' + crypto.randomBytes(3).toString('hex');
  const token = (await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } })).body.token;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;
  const mk = async (name, stock, price = 100) =>
    (await api('POST', '/products', {
      token, body: { name, categoryId: cat._id, price, cost: 60, stock },
    })).body.product;

  const rice = await mk('Rice', 100);
  const stockOf = async (id) => (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(id)).stock;

  /* ==================== 1. the same sale, twice ==================== */
  console.log('\n=== the same sale sent twice ===');
  const r1 = ref();
  const first = await api('POST', '/orders', {
    token, body: { clientRef: r1, items: [{ productId: rice._id, qty: 3 }] },
  });
  check('the first arrival creates it', first.status === 201, first.body);
  check('  and the receipt carries the ref', first.body.order.clientRef === r1, first.body.order?.clientRef);

  const second = await api('POST', '/orders', {
    token, body: { clientRef: r1, items: [{ productId: rice._id, qty: 3 }] },
  });
  check('the second arrival is NOT a new sale', second.status === 200, second.status);
  check('  it says so plainly', second.body.duplicate === true, second.body);
  check('  and returns the SAME receipt',
    String(second.body.order._id) === String(first.body.order._id), {
      first: first.body.order._id, second: second.body.order._id,
    });
  check('  with the same receipt number',
    second.body.order.orderNumber === first.body.order.orderNumber, {
      first: first.body.order.orderNumber, second: second.body.order.orderNumber,
    });

  check('the stock moved exactly once', await stockOf(rice._id) === 97, await stockOf(rice._id));
  check('  and there is one order, not two',
    (await api('GET', '/orders', { token })).body.orders.length === 1);

  /* ============ 2. a different cart under the same ref ============ */
  console.log('\n=== the ref wins over the cart ===');
  const impostor = await api('POST', '/orders', {
    token, body: { clientRef: r1, items: [{ productId: rice._id, qty: 50 }] },
  });
  check('a different cart under a used ref changes nothing', impostor.status === 200, impostor.status);
  check('  the original receipt comes back',
    impostor.body.order.items[0].qty === 3, impostor.body.order.items?.[0]);
  check('  and no extra stock moved', await stockOf(rice._id) === 97, await stockOf(rice._id));

  /* ======= 2b. a replay of a recorded sale, after the shelf emptied ======= */
  console.log('\n=== replaying a recorded sale once the stock is gone ===');
  const scarce = await mk('Ghee', 5);
  const r1b = ref();
  const recorded = await api('POST', '/orders', {
    token, body: { clientRef: r1b, items: [{ productId: scarce._id, qty: 5 }] },
  });
  check('the sale is recorded and clears the shelf',
    recorded.status === 201 && await stockOf(scarce._id) === 0, await stockOf(scarce._id));

  /**
   * The exact shape of an offline queue draining late: the sale IS on the
   * server, and there is no longer stock to sell. Answering 409 here would tell
   * the operator a recorded sale had failed, and the queue would mark it
   * refused and offer to discard a receipt the shop has already issued.
   */
  const lateReplay = await api('POST', '/orders', {
    token, body: { clientRef: r1b, items: [{ productId: scarce._id, qty: 5 }] },
  });
  check('the replay still returns the receipt rather than "out of stock"',
    lateReplay.status === 200 && lateReplay.body.duplicate === true,
    { status: lateReplay.status, body: lateReplay.body });
  check('  naming the original sale',
    String(lateReplay.body.order?._id) === String(recorded.body.order._id),
    { original: recorded.body.order._id, replay: lateReplay.body.order?._id });

  /* ==================== 3. overlapping replays ==================== */
  console.log('\n=== two replays racing each other ===');
  const r2 = ref();
  const salvo = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/orders', {
    token, body: { clientRef: r2, items: [{ productId: rice._id, qty: 2 }] },
  })));
  const created = salvo.filter((r) => r.status === 201);
  const echoed = salvo.filter((r) => r.status === 200);
  check('exactly one of five created the sale', created.length === 1,
    salvo.map((r) => r.status));
  check('  the other four echoed it', echoed.length === 4, salvo.map((r) => r.status));
  check('  all five name the same receipt',
    new Set(salvo.map((r) => String(r.body.order?._id))).size === 1,
    salvo.map((r) => r.body.order?._id));
  check('  and the stock moved once, not five times',
    await stockOf(rice._id) === 95, await stockOf(rice._id));
  check('  no duplicate receipt numbers exist',
    (() => {
      const nums = salvo.map((r) => r.body.order?.orderNumber);
      return new Set(nums).size === 1;
    })(), salvo.map((r) => r.body.order?.orderNumber));

  /* ============ 4. a voided sale does not come back ============ */
  console.log('\n=== replaying a sale that was voided ===');
  const r3 = ref();
  const toVoid = await api('POST', '/orders', {
    token, body: { clientRef: r3, items: [{ productId: rice._id, qty: 4 }] },
  });
  await api('DELETE', `/orders/${toVoid.body.order._id}`, { token });
  const stockAfterVoid = await stockOf(rice._id);
  // Counted rather than hard-coded: this suite grows, and an absolute number
  // here turns every future addition into a false failure.
  const liveOrdersAfterVoid = (await api('GET', '/orders', { token })).body.orders.length;

  const replayed = await api('POST', '/orders', {
    token, body: { clientRef: r3, items: [{ productId: rice._id, qty: 4 }] },
  });
  check('replaying it does not resurrect the sale', replayed.status === 200, replayed.status);
  check('  and takes no stock', await stockOf(rice._id) === stockAfterVoid,
    { before: stockAfterVoid, after: await stockOf(rice._id) });
  check('  and the voided sale does not reappear in the list',
    (await api('GET', '/orders', { token })).body.orders.length === liveOrdersAfterVoid,
    { before: liveOrdersAfterVoid, after: (await api('GET', '/orders', { token })).body.orders.length });

  /* ==================== 5. refs are per shop ==================== */
  console.log('\n=== one shop cannot block another shop\'s ref ===');
  const other = 'Idem B ' + crypto.randomBytes(3).toString('hex');
  const tokenB = (await api('POST', '/auth/register', { body: { businessName: other, pin: '1111' } })).body.token;
  const catB = (await api('POST', '/categories', { token: tokenB, body: { name: 'G' } })).body.category;
  const riceB = (await api('POST', '/products', {
    token: tokenB, body: { name: 'Rice', categoryId: catB._id, price: 10, cost: 5, stock: 10 },
  })).body.product;

  const sameRefElsewhere = await api('POST', '/orders', {
    token: tokenB, body: { clientRef: r1, items: [{ productId: riceB._id, qty: 1 }] },
  });
  check('the same ref at another shop is a NEW sale', sameRefElsewhere.status === 201, sameRefElsewhere.body);
  check('  and it is their own', sameRefElsewhere.body.order.items[0].productId === String(riceB._id));

  /* ==================== 6. a ref is optional ==================== */
  console.log('\n=== selling without a ref still works ===');
  const a = await api('POST', '/orders', { token, body: { items: [{ productId: rice._id, qty: 1 }] } });
  const b = await api('POST', '/orders', { token, body: { items: [{ productId: rice._id, qty: 1 }] } });
  check('two ref-less sales both go through', a.status === 201 && b.status === 201, [a.status, b.status]);
  check('  and are genuinely separate',
    String(a.body.order._id) !== String(b.body.order._id));
  check('  neither carries a ref',
    !a.body.order.clientRef && !b.body.order.clientRef,
    [a.body.order.clientRef, b.body.order.clientRef]);

  /* ==================== 7. a malformed ref ==================== */
  console.log('\n=== a ref that is not one ===');
  const short = await api('POST', '/orders', {
    token, body: { clientRef: 'abc', items: [{ productId: rice._id, qty: 1 }] },
  });
  check('too short -> 400', short.status === 400, short.body);
  const nasty = await api('POST', '/orders', {
    token, body: { clientRef: '../../etc/passwd!!', items: [{ productId: rice._id, qty: 1 }] },
  });
  check('unsafe characters -> 400', nasty.status === 400, nasty.body);
  const stockBefore = await stockOf(rice._id);
  await api('POST', '/orders', {
    token, body: { clientRef: 'x'.repeat(200), items: [{ productId: rice._id, qty: 1 }] },
  });
  check('  and none of them moved stock', await stockOf(rice._id) === stockBefore,
    { before: stockBefore, after: await stockOf(rice._id) });

  /* ============ 8. a replay the server will always refuse ============ */
  console.log('\n=== a queued sale for stock that is gone ===');
  const salt = await mk('Salt', 2);
  const r4 = ref();
  // Sell the shelf out from under the queued sale, the way a second phone or a
  // later correction would.
  await api('PATCH', `/products/${salt._id}/stock`, { token, body: { set: 0 } });
  const refused = await api('POST', '/orders', {
    token, body: { clientRef: r4, items: [{ productId: salt._id, qty: 2 }] },
  });
  check('it is refused, not queued forever by the server', refused.status === 409, refused.body);
  check('  and the ref stays free for a genuine retry later',
    (await api('POST', '/orders', {
      token, body: { clientRef: r4, items: [{ productId: rice._id, qty: 1 }] },
    })).status === 201);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message, err.stack?.split('\n')[1] ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
