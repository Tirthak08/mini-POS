/**
 * Waiting for persisted zustand stores to be read back off disk.
 *
 * Deliberately free of imports -- no stores, no React. That is what lets it be
 * tested directly with fake stores, which matters here more than usual: the bug
 * this guards against is NATIVE-only. On a device AsyncStorage is genuinely
 * asynchronous, so a cold start briefly has no session and the navigator paints
 * the sign-in screen to a shopkeeper who is already signed in. On web,
 * AsyncStorage is backed by synchronous localStorage, hydration finishes before
 * the first paint, and the symptom never appears -- so the browser suites
 * cannot observe it, and a browser assertion about it would pass whether the
 * fix were present or not.
 */

/** Never hold the splash longer than this, whatever storage does. */
export const FAILSAFE_MS = 3000;

const hydrated = (store) => store?.persist?.hasHydrated?.() ?? true;

/**
 * Resolves when every store reports hydrated, or when `timeoutMs` elapses.
 *
 * The timeout is not a nicety: a storage read that never resolves would
 * otherwise strand the app on the splash screen forever, and an app that never
 * opens is far worse than a flash of the login screen. So the wait is bounded
 * and failure degrades to the previous behaviour.
 *
 * Returns `{ promise, cancel }` so a caller unmounting mid-wait can drop the
 * listeners instead of leaking them. The resolved value carries `timedOut` so
 * the caller can tell a real load from the failsafe firing.
 *
 * The timer functions are injectable purely so tests can control time.
 */
export function awaitHydration(stores, {
  timeoutMs = FAILSAFE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });

  const allDone = () => stores.every(hydrated);

  if (allDone()) {
    settle({ timedOut: false });
    return { promise, cancel: () => {} };
  }

  let finished = false;
  let unsubscribes = [];
  let timer;

  const cleanup = () => {
    unsubscribes.forEach((u) => u());
    unsubscribes = [];
    clearTimeoutFn(timer);
  };

  const finish = (timedOut) => {
    if (finished) return;
    finished = true;
    cleanup();
    settle({ timedOut });
  };

  const check = () => { if (allDone()) finish(false); };

  unsubscribes = stores
    .map((s) => s?.persist?.onFinishHydration?.(check))
    .filter((u) => typeof u === 'function');
  timer = setTimeoutFn(() => finish(true), timeoutMs);

  // A store may have finished between the check above and the listeners being
  // attached.
  check();

  return {
    promise,
    cancel: () => { finished = true; cleanup(); },
  };
}
