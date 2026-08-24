/**
 * Expenses, and what they do to profit.
 *
 * The point of the feature is that "profit" was a half-truth: revenue minus
 * COGS reads as "what I made" while rent and wages are missing from it. So the
 * assertions here are less about CRUD and more about the arithmetic a shopkeeper
 * will act on -- including the case everyone gets wrong, which is a loss.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 5177;
const API = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 260) : ''}`));
};

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ launchTimeout: 120_000 }],
});

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'test',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'expensetest',
    JWT_SECRET: 'expense-test-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin',
    ADMIN_PASSWORD: 'expense-test-admin',
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const shutdown = async (code) => {
  server.kill();
  await replSet.stop();
  process.exit(code);
};

for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`${API}/health`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
};

const today = new Date().toISOString().slice(0, 10);
const iso = (d) => d.toISOString().slice(0, 10);

/* ------------------------------- two shops ------------------------------- */
const nameA = 'ExpA ' + crypto.randomBytes(3).toString('hex');
const nameB = 'ExpB ' + crypto.randomBytes(3).toString('hex');
const tokenA = (await api('POST', '/auth/register', { body: { businessName: nameA, pin: '1234' } })).body.token;
const tokenB = (await api('POST', '/auth/register', { body: { businessName: nameB, pin: '4321' } })).body.token;

const catA = (await api('POST', '/categories', { token: tokenA, body: { name: 'Gold' } })).body.category;
const ringA = (await api('POST', '/products', {
  token: tokenA, body: { name: 'Ring', categoryId: catA._id, price: 1000, cost: 600, stock: 10 },
})).body.product;

console.log('=== creating an expense ===');
{
  const r = await api('POST', '/expenses', { token: tokenA, body: { amount: 2500, note: 'Shop rent' } });
  check('created -> 201', r.status === 201, r.body);
  check('amount echoed', r.body?.expense?.amount === 2500, r.body?.expense);
  check('note echoed', r.body?.expense?.note === 'Shop rent', r.body?.expense);
  check('spentAt defaults to now', Boolean(r.body?.expense?.spentAt), r.body?.expense);
  check('the tenant key is never returned to the client',
    !('businessId' in (r.body?.expense || {})), Object.keys(r.body?.expense || {}));
}

console.log('\n=== the validation a fat thumb will find ===');
{
  const noAmount = await api('POST', '/expenses', { token: tokenA, body: { note: 'x' } });
  check('missing amount -> 400', noAmount.status === 400, noAmount.body);

  const noNote = await api('POST', '/expenses', { token: tokenA, body: { amount: 10 } });
  check('missing note -> 400', noNote.status === 400, noNote.body);

  const blankNote = await api('POST', '/expenses', { token: tokenA, body: { amount: 10, note: '   ' } });
  check('a whitespace-only note -> 400', blankNote.status === 400, blankNote.body);

  const zero = await api('POST', '/expenses', { token: tokenA, body: { amount: 0, note: 'nothing' } });
  check('zero rupees -> 400, it is a mis-tap not a record', zero.status === 400, zero.body);

  const negative = await api('POST', '/expenses', { token: tokenA, body: { amount: -500, note: 'refund?' } });
  check('a negative amount -> 400 (it would silently ADD to profit)', negative.status === 400, negative.body);

  const future = new Date(Date.now() + 40 * 864e5);
  const ahead = await api('POST', '/expenses', {
    token: tokenA, body: { amount: 100, note: 'next month rent', spentAt: iso(future) },
  });
  check('a far-future date -> 400', ahead.status === 400, ahead.body);

  const junkDate = await api('POST', '/expenses', {
    token: tokenA, body: { amount: 100, note: 'x', spentAt: 'not-a-date' },
  });
  check('an unparseable date -> 400', junkDate.status === 400, junkDate.body);

  const rounded = await api('POST', '/expenses', { token: tokenA, body: { amount: 10.129, note: 'Tea' } });
  check('paise are rounded to 2dp', rounded.body?.expense?.amount === 10.13, rounded.body?.expense);
  await api('DELETE', `/expenses/${rounded.body.expense._id}`, { token: tokenA });
}

console.log('\n=== a back-dated expense keeps the shop\'s own day ===');
{
  const yesterday = iso(new Date(Date.now() - 864e5));
  const r = await api('POST', '/expenses', {
    token: tokenA, body: { amount: 300, note: 'Yesterday transport', spentAt: yesterday },
  });
  check('accepted', r.status === 201, r.body);
  check('the date did not drift backwards across the timezone',
    String(r.body?.expense?.spentAt).slice(0, 10) === yesterday,
    { sent: yesterday, stored: r.body?.expense?.spentAt });
  await api('DELETE', `/expenses/${r.body.expense._id}`, { token: tokenA });
}

console.log('\n=== listing, totalling, and the date window ===');
{
  await api('POST', '/expenses', { token: tokenA, body: { amount: 500, note: 'Electricity' } });
  const list = await api('GET', `/expenses?from=${today}&to=${today}`, { token: tokenA });
  check('listed -> 200', list.status === 200, list.body);
  check('both of today\'s expenses are there', list.body?.expenses?.length === 2, list.body?.expenses?.length);
  check('the total is the sum, not the page (2500 + 500)', list.body?.total === 3000, list.body?.total);
  check('newest first', new Date(list.body.expenses[0].spentAt) >= new Date(list.body.expenses[1].spentAt));

  const old = iso(new Date(Date.now() - 40 * 864e5));
  const empty = await api('GET', `/expenses?from=${old}&to=${old}`, { token: tokenA });
  check('a window with nothing in it totals zero, not null', empty.body?.total === 0, empty.body);
  check('and returns an empty list', empty.body?.expenses?.length === 0, empty.body?.expenses);
}

console.log('\n=== one shop can never see or touch another\'s expenses ===');
{
  const mine = (await api('GET', `/expenses?from=${today}&to=${today}`, { token: tokenA })).body.expenses[0];
  const theirs = await api('GET', `/expenses?from=${today}&to=${today}`, { token: tokenB });
  check('B sees none of A\'s', theirs.body?.expenses?.length === 0, theirs.body?.expenses);
  check('B\'s total is zero', theirs.body?.total === 0, theirs.body);

  const steal = await api('PATCH', `/expenses/${mine._id}`, { token: tokenB, body: { amount: 1 } });
  check('B cannot edit A\'s expense -> 404 (not 403, which would confirm it exists)',
    steal.status === 404, steal.status);

  const wipe = await api('DELETE', `/expenses/${mine._id}`, { token: tokenB });
  check('B cannot delete A\'s expense -> 404', wipe.status === 404, wipe.status);

  const still = await api('GET', `/expenses?from=${today}&to=${today}`, { token: tokenA });
  check('and A\'s expense is untouched', still.body?.expenses?.some((e) => e._id === mine._id));

  const noToken = await api('GET', '/expenses');
  check('no token at all -> 401', noToken.status === 401, noToken.status);
}

console.log('\n=== editing and deleting ===');
{
  const created = (await api('POST', '/expenses', { token: tokenA, body: { amount: 100, note: 'Typo' } })).body.expense;
  const edited = await api('PATCH', `/expenses/${created._id}`, {
    token: tokenA, body: { amount: 250, note: 'Packing material' },
  });
  check('edit applies both fields', edited.body?.expense?.amount === 250 && edited.body?.expense?.note === 'Packing material', edited.body?.expense);

  const bad = await api('PATCH', `/expenses/${created._id}`, { token: tokenA, body: { amount: 0 } });
  check('editing to zero is refused -> 400', bad.status === 400, bad.status);

  const gone = await api('DELETE', `/expenses/${created._id}`, { token: tokenA });
  check('delete -> 200', gone.status === 200, gone.body);
  const after = await api('GET', `/expenses?from=${today}&to=${today}`, { token: tokenA });
  check('it disappears from the list', !after.body?.expenses?.some((e) => e._id === created._id));
  check('and stops counting toward the total', after.body?.total === 3000, after.body?.total);

  const twice = await api('DELETE', `/expenses/${created._id}`, { token: tokenA });
  check('deleting it again -> 404 rather than pretending', twice.status === 404, twice.status);

  const junkId = await api('DELETE', '/expenses/not-an-objectid', { token: tokenA });
  check('a malformed id -> 400, not a 500', junkId.status === 400, junkId.status);
}

console.log('\n=== what expenses do to profit ===');
{
  // One sale: 2 rings at 1000, cost 600 each. Revenue 2000, COGS 1200.
  await api('POST', '/orders', { token: tokenA, body: { items: [{ productId: ringA._id, qty: 2 }] } });
  const r = await api('GET', `/reports/summary?from=${today}&to=${today}`, { token: tokenA });
  const s = r.body?.sales;

  check('revenue is 2000', s?.revenue === 2000, s);
  check('COGS is 1200', s?.cogs === 1200, s);
  check('gross profit is revenue - COGS = 800', s?.grossProfit === 800, s);
  check('expenses for the window are reported (2500 + 500)', s?.expenses === 3000, s);
  check('`profit` still means GROSS, so nothing reading it silently changed',
    s?.profit === 800, s);
  check('net profit is gross - expenses = -2200', s?.netProfit === -2200, s);
  check('a loss is reported as a loss, NOT floored at zero', s?.netProfit < 0, s?.netProfit);
  check('gross - expenses = net, exactly',
    Math.round((s.grossProfit - s.expenses) * 100) === Math.round(s.netProfit * 100), s);
  check('the gross margin still divides by revenue', s?.marginPercent === 40, s?.marginPercent);
  check('and there is a separate net margin', s?.netMarginPercent === -110, s?.netMarginPercent);
}

console.log('\n=== an expense outside the window does not move that window\'s profit ===');
{
  const old = iso(new Date(Date.now() - 20 * 864e5));
  await api('POST', '/expenses', { token: tokenA, body: { amount: 9999, note: 'Old bill', spentAt: old } });
  const r = await api('GET', `/reports/summary?from=${today}&to=${today}`, { token: tokenA });
  check('today\'s expenses are unchanged by a 20-day-old bill', r.body?.sales?.expenses === 3000, r.body?.sales);
  check('and today\'s net profit is unchanged', r.body?.sales?.netProfit === -2200, r.body?.sales?.netProfit);

  const wide = await api('GET', `/reports/summary?from=${old}&to=${today}`, { token: tokenA });
  check('a window that includes it does count it', wide.body?.sales?.expenses === 12999, wide.body?.sales?.expenses);
}

console.log('\n=== a shop with no expenses reads exactly as before ===');
{
  const r = await api('GET', `/reports/summary?from=${today}&to=${today}`, { token: tokenB });
  check('expenses are 0', r.body?.sales?.expenses === 0, r.body?.sales);
  check('net profit equals gross profit', r.body?.sales?.netProfit === r.body?.sales?.grossProfit, r.body?.sales);
}

console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
