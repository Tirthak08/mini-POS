/**
 * Atlas is a replica set, so checkout uses a real transaction there.
 * A plain local `mongod` is standalone and rejects transactions -- this proves
 * the compensating-writes fallback keeps stock correct anyway.
 */
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';

const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${x ? JSON.stringify(x) : ''}`)); };

const api = async (m, p, { token, body } = {}) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
console.log('Standalone mongod (no replica set) at', mongo.getUri());

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', MONGODB_URI: mongo.getUri(),
    MONGODB_DB: 'fallback_test', JWT_SECRET: 'x'.repeat(40), ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'b' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
server.stdout.on('data', (d) => log.push(d.toString()));
server.stderr.on('data', (d) => log.push(d.toString()));

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const { body: reg } = await api('POST', '/auth/register', { body: { businessName: 'Fallback Shop', pin: '1111' } });
const token = reg.token;
const cat = await api('POST', '/categories', { token, body: { name: 'Test' } });
const prod = await api('POST', '/products', { token, body: { name: 'Widget', categoryId: cat.body.category._id, price: 50, cost: 20, stock: 4 } });
const id = prod.body.product._id;

const ok = await api('POST', '/orders', { token, body: { items: [{ productId: id, qty: 2, discount: 10 }] } });
check('checkout succeeds without transactions', ok.status === 201 && ok.body.order?.grandTotal === 90, ok);
check('fallback path was actually taken', log.join('').includes('Transactions unavailable'));

const after1 = await api('GET', '/products?search=Widget', { token });
check('stock 4 -> 2', after1.body.products[0].stock === 2, after1.body.products[0]);

const over = await api('POST', '/orders', { token, body: { items: [{ productId: id, qty: 99 }] } });
check('oversell still rejected -> 409', over.status === 409, over.body);

// Two lines where the SECOND one cannot be filled: the first decrement must be
// rolled back, or the shop silently loses stock it never sold.
const p2 = await api('POST', '/products', { token, body: { name: 'Scarce', categoryId: cat.body.category._id, price: 10, stock: 1 } });
const partial = await api('POST', '/orders', {
  token, body: { items: [{ productId: id, qty: 1 }, { productId: p2.body.product._id, qty: 5 }] },
});
check('partially-fillable cart -> 409', partial.status === 409, partial.body);

const after2 = await api('GET', '/products?search=Widget', { token });
check('rollback: first item stock untouched at 2', after2.body.products[0].stock === 2, after2.body.products[0]);

console.log(`\n${pass} passed, ${fail} failed`);
server.kill('SIGTERM');
await mongo.stop();
process.exit(fail ? 1 : 0);
