/**
 * The splash-hold decision logic.
 *
 * This is tested here, as a plain function with fake stores, for a specific
 * reason: the bug it fixes is NATIVE-only. On a device, AsyncStorage is truly
 * asynchronous, so a cold start briefly has no session and the navigator paints
 * the sign-in screen to someone who is already signed in. On web, AsyncStorage
 * is backed by synchronous localStorage, hydration completes before the first
 * paint, and the flash never occurs.
 *
 * That was proved the hard way: a browser test asserting "the sign-in screen
 * never mounts during startup" passed identically with the fix in place and
 * with it removed. A test that cannot fail is worse than no test, because it
 * reports safety it never checked. So the logic is verified directly instead --
 * every branch, including the failsafe, with time under the test's control.
 */
import { awaitHydration, FAILSAFE_MS } from '../src/utils/hydration.js';

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 200) : ''}`));
};

/** A stand-in for a zustand store with the persist middleware attached. */
function fakeStore({ startsHydrated = false } = {}) {
  let isHydrated = startsHydrated;
  const listeners = new Set();
  return {
    persist: {
      hasHydrated: () => isHydrated,
      onFinishHydration: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    finishHydration() { isHydrated = true; listeners.forEach((fn) => fn()); },
    listenerCount: () => listeners.size,
  };
}

/* ---------------- 1. already hydrated: no waiting at all ---------------- */
console.log('=== a warm start does not wait ===');
{
  const a = fakeStore({ startsHydrated: true });
  const b = fakeStore({ startsHydrated: true });
  let resolved = false;
  const { promise } = awaitHydration([a, b]);
  promise.then(() => { resolved = true; });
  await Promise.resolve();
  check('resolves immediately when both stores are already hydrated', resolved);
  check('and attaches no listeners it would have to clean up',
    a.listenerCount() === 0 && b.listenerCount() === 0);
}

/* ---------------- 2. waits for the SLOWEST store ---------------- */
console.log('\n=== a cold start waits for every store, not just the first ===');
{
  const auth = fakeStore();
  const settings = fakeStore();
  let result = null;
  const { promise } = awaitHydration([auth, settings]);
  promise.then((r) => { result = r; });

  await Promise.resolve();
  check('does not resolve while both are pending', result === null);

  auth.finishHydration();
  await Promise.resolve(); await Promise.resolve();
  check('still does not resolve when only the session has loaded', result === null,
    'this is the language-flash case: painting now shows English before Gujarati');

  settings.finishHydration();
  await Promise.resolve(); await Promise.resolve();
  check('resolves once the last store lands', result !== null, result);
  check('and reports that it was not a timeout', result?.timedOut === false, result);
  check('listeners are released afterwards',
    auth.listenerCount() === 0 && settings.listenerCount() === 0);
}

/* ---------------- 3. the failsafe: storage that never answers ---------------- */
console.log('\n=== storage that never answers must not strand the app ===');
{
  const stuck = fakeStore();
  let firedAfter = null;
  const fakeSetTimeout = (fn, ms) => { firedAfter = ms; fn(); return 1; };
  let result = null;
  const { promise } = awaitHydration([stuck], {
    setTimeoutFn: fakeSetTimeout,
    clearTimeoutFn: () => {},
  });
  promise.then((r) => { result = r; });
  await Promise.resolve(); await Promise.resolve();

  check('gives up rather than waiting forever', result !== null, result);
  check('and says so, so the caller can tell a timeout from a real load',
    result?.timedOut === true, result);
  check(`the bound is the declared ${FAILSAFE_MS}ms`, firedAfter === FAILSAFE_MS, firedAfter);
  check('and it stops listening on the way out', stuck.listenerCount() === 0);
}

/* ---------------- 4. a late arrival cannot resolve twice ---------------- */
console.log('\n=== a store that lands after the failsafe changes nothing ===');
{
  const late = fakeStore();
  let calls = 0;
  const { promise } = awaitHydration([late], {
    setTimeoutFn: (fn) => { fn(); return 1; },
    clearTimeoutFn: () => {},
  });
  promise.then(() => { calls += 1; });
  await Promise.resolve(); await Promise.resolve();
  late.finishHydration();           // arrives too late
  await Promise.resolve(); await Promise.resolve();
  check('the promise settles exactly once', calls === 1, calls);
}

/* ---------------- 5. cancellation on unmount ---------------- */
console.log('\n=== unmounting mid-wait releases everything ===');
{
  const s = fakeStore();
  const { promise, cancel } = awaitHydration([s]);
  let resolved = false;
  promise.then(() => { resolved = true; });
  check('a listener is attached while waiting', s.listenerCount() === 1);
  cancel();
  check('cancel detaches it', s.listenerCount() === 0);
  s.finishHydration();
  await Promise.resolve(); await Promise.resolve();
  check('and a post-cancel hydration does not resolve the abandoned wait', resolved === false);
}

/* ---------------- 6. a store without persist is not waited on ---------------- */
console.log('\n=== a store with no persist middleware counts as ready ===');
{
  let resolved = false;
  const { promise } = awaitHydration([{}, fakeStore({ startsHydrated: true })]);
  promise.then(() => { resolved = true; });
  await Promise.resolve();
  check('treated as hydrated rather than hanging the splash', resolved);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
