/**
 * The security property: brute-forcing ONE account gets blocked, while other
 * accounts on the same IP keep working. Runs with NODE_ENV unset so the limiter
 * is active (the test suite skips it deliberately).
 */
import { spawn } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 120000 }] });
const PORT = 5301, BASE = `http://127.0.0.1:${PORT}/api`;
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', MONGODB_URI: rs.getUri(), MONGODB_DB: 'rl',
    JWT_SECRET: 'x'.repeat(40), ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'adminpass' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }

let pass = 0, fail = 0;
const check = (l, ok, extra) => { ok ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}  ${JSON.stringify(extra ?? '')}`)); };
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

await post('/auth/register', { businessName: 'Victim Shop', pin: '1234' });
await post('/auth/register', { businessName: 'Bystander Shop', pin: '5678' });

console.log('Hammering ONE account with wrong PINs from a single IP:');
const codes = [];
for (let i = 0; i < 13; i++) {
  const r = await post('/auth/signin', { identifier: 'Victim Shop', secret: '0000' });
  codes.push(r.status);
}
console.log('  statuses:', codes.join(','));
check('the first attempts are ordinary 401s', codes.slice(0, 9).every((c) => c === 401), codes);
check('the account gets locked with 429 after ~10 tries', codes.includes(429), codes);

const victimRight = await post('/auth/signin', { identifier: 'Victim Shop', secret: '1234' });
check('even the CORRECT PIN is refused while locked', victimRight.status === 429, victimRight.status);

console.log('\nA different account from the SAME IP:');
const bystander = await post('/auth/signin', { identifier: 'Bystander Shop', secret: '5678' });
check('another shop on the same Wi-Fi still signs in fine', bystander.status === 200 && bystander.body?.role === 'business', bystander.status);

const admin = await post('/auth/signin', { identifier: 'superadmin', secret: 'adminpass' });
check('the super admin is unaffected too', admin.status === 200 && admin.body?.role === 'admin', admin.status);

console.log('\nCase and spacing must not sidestep the lock:');
const sneaky = await post('/auth/signin', { identifier: '  VICTIM   shop ', secret: '0000' });
check('a differently-cased identifier hits the same bucket -> 429', sneaky.status === 429, sneaky.status);

console.log(`\n${pass} passed, ${fail} failed`);
server.kill('SIGTERM');
await rs.stop();
process.exit(fail ? 1 : 0);
