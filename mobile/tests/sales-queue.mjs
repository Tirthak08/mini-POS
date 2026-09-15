/**
 * The offline queue's rules, without a network or a renderer.
 *
 * The distinction everything rests on: a sale that failed because the phone had
 * no signal is worth retrying forever, and a sale the SERVER refused will be
 * refused identically every time. Retrying the second kind silently hides a
 * sale that never happened behind a spinner that never stops; giving up on the
 * first loses money.
 */
import {
  makeClientRef, makeEntry, classifyFailure, dueEntries, afterAttempt,
  pendingCount, failedCount, queuedValue, QUEUE_LIMIT,
} from '../src/utils/salesQueue.js';

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`));
};

const netErr = () => ({ isNetwork: true, status: 0, message: 'Cannot reach the server' });
const httpErr = (status, message = 'nope') => ({ status, message, isNetwork: false });

console.log('\n=== the ref that makes a retry safe ===');
const refs = new Set(Array.from({ length: 2000 }, () => makeClientRef()));
check('refs do not collide over 2000 sales', refs.size === 2000, refs.size);
check('  and every one is the shape the server accepts',
  [...refs].every((r) => /^[A-Za-z0-9._:-]{8,64}$/.test(r)),
  [...refs].slice(0, 2).concat([...refs].filter((r) => !/^[A-Za-z0-9._:-]{8,64}$/.test(r)).slice(0, 2)));

const entry = makeEntry({ items: [{ productId: 'p1', qty: 2 }] }, { now: 1000, total: 240 });
check('an entry carries its own ref', /^[A-Za-z0-9._:-]{8,64}$/.test(entry.clientRef), entry.clientRef);
check('  and the payload sent will carry the same one',
  entry.payload.clientRef === entry.clientRef, entry.payload.clientRef);
check('  it starts pending with no attempts', entry.status === 'pending' && entry.attempts === 0, entry);
check('  and remembers what it is worth', entry.total === 240, entry.total);

const preset = makeEntry({ items: [], clientRef: 'already-set-1234' });
check('a payload that already has a ref keeps it',
  preset.clientRef === 'already-set-1234', preset.clientRef);

console.log('\n=== what is worth retrying ===');
check('no signal -> keep trying', classifyFailure(netErr()) === 'queue');
check('status 0 -> keep trying', classifyFailure(httpErr(0)) === 'queue');
check('500 -> keep trying (the server is having a moment)', classifyFailure(httpErr(500)) === 'queue');
check('503 -> keep trying', classifyFailure(httpErr(503)) === 'queue');
check('409 out of stock -> STOP', classifyFailure(httpErr(409)) === 'stop');
check('400 bad request -> STOP', classifyFailure(httpErr(400)) === 'stop');
check('404 -> STOP', classifyFailure(httpErr(404)) === 'stop');
check('401 -> not the queue\'s problem', classifyFailure(httpErr(401)) === 'reject');
check('403 -> not the queue\'s problem', classifyFailure(httpErr(403)) === 'reject');
check('an error with nothing on it -> keep trying', classifyFailure(null) === 'queue');

console.log('\n=== one attempt at a time ===');
check('a sale the server accepted leaves the queue',
  afterAttempt(entry, { ok: true }) === null);

const afterNet = afterAttempt(entry, { ok: false, err: netErr() });
check('a network failure stays pending', afterNet.status === 'pending', afterNet.status);
check('  and counts the try', afterNet.attempts === 1, afterNet.attempts);
check('  keeping why', /Cannot reach/.test(afterNet.error), afterNet.error);

const afterRefusal = afterAttempt(entry, { ok: false, err: httpErr(409, 'Not enough stock') });
check('a refusal stops', afterRefusal.status === 'failed', afterRefusal.status);
check('  and keeps the reason where a person can read it',
  afterRefusal.error === 'Not enough stock', afterRefusal.error);

const afterAuth = afterAttempt(entry, { ok: false, err: httpErr(401) });
check('an expired session leaves the entry untouched', afterAuth === entry);

console.log('\n=== a queue is a queue ===');
const list = [
  { id: 'c', createdAt: 300, status: 'pending' },
  { id: 'a', createdAt: 100, status: 'pending' },
  { id: 'x', createdAt: 200, status: 'failed' },
  { id: 'b', createdAt: 200, status: 'pending' },
];
check('oldest first', dueEntries(list).map((e) => e.id).join('') === 'abc',
  dueEntries(list).map((e) => e.id));
check('  and a stopped sale is not retried on its own',
  !dueEntries(list).some((e) => e.id === 'x'), dueEntries(list).map((e) => e.id));

check('pending is counted', pendingCount(list) === 3, pendingCount(list));
check('failed is counted separately', failedCount(list) === 1, failedCount(list));

console.log('\n=== the money sitting on the phone ===');
const withMoney = [
  { status: 'pending', total: 105.5 },
  { status: 'pending', total: 30 },
  { status: 'failed', total: 900 },
];
check('only what is still going to be sent counts',
  queuedValue(withMoney) === 135.5, queuedValue(withMoney));
check('  a refused sale is not money in hand',
  !String(queuedValue(withMoney)).includes('900'));
check('an empty queue is worth nothing', queuedValue([]) === 0);
check('  and does not throw on rubbish', queuedValue([{ status: 'pending' }]) === 0);

console.log('\n=== the queue has a bottom ===');
check('there is a limit at all', Number.isInteger(QUEUE_LIMIT) && QUEUE_LIMIT > 0, QUEUE_LIMIT);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
