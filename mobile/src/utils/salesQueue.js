/**
 * The rules a sale rung up with no signal has to follow, kept out of the store
 * so they can be tested without a network or a renderer.
 *
 * THE ONE THING THAT MAKES THIS SAFE
 * ----------------------------------
 * Every queued sale carries a `clientRef` generated before the first attempt.
 * The server treats a second arrival of the same ref as the same sale and
 * returns the original receipt. Without that, a reply lost on the way back is
 * indistinguishable from a request that never arrived, and the only safe policy
 * is to never retry -- which is exactly why checkout could not be retried
 * before this existed.
 *
 * WHAT IS AND IS NOT WORTH RETRYING
 * ---------------------------------
 * A sale that failed because the phone had no signal is worth retrying forever;
 * nothing about it is wrong. A sale the server REFUSED -- not enough stock, a
 * product deleted since -- will be refused identically every time, and retrying
 * it silently would hide a sale that never happened behind a spinner that never
 * stops. Those stop, keep the reason, and wait for a person.
 */

/** Distinct enough for one shop's phone; it only has to be unique per business. */
export function makeClientRef() {
  const now = Date.now().toString(36);
  let random = '';
  for (let i = 0; i < 10; i += 1) {
    random += Math.floor(Math.random() * 36).toString(36);
  }
  return `q${now}${random}`;
}

export const QUEUE_LIMIT = 500;

/** A queue entry from a cart payload, ready to be stored. */
export function makeEntry(payload, { now = Date.now(), total = 0 } = {}) {
  const clientRef = payload?.clientRef || makeClientRef();
  return {
    id: clientRef,
    clientRef,
    payload: { ...payload, clientRef },
    createdAt: now,
    attempts: 0,
    status: 'pending',
    error: null,
    total,
  };
}

/**
 * What to do with a failure.
 *
 *   'queue'  -- the phone could not reach the server. Keep it and try later.
 *   'stop'   -- the server refused it. Keep it, but stop trying.
 *   'reject' -- not the queue's problem at all (an expired session): let the
 *               normal error path handle it, and do not pretend a sale was made.
 */
export function classifyFailure(err) {
  if (!err) return 'queue';
  if (err.isNetwork) return 'queue';

  const status = Number(err.status) || 0;
  if (status === 0) return 'queue';
  if (status === 401 || status === 403) return 'reject';
  // 5xx is the server having a bad moment, not a verdict on this sale.
  if (status >= 500) return 'queue';
  // 4xx is a verdict: not enough stock, a product that no longer exists.
  return 'stop';
}

/** Entries the syncer should attempt, oldest first — a queue, not a stack. */
export function dueEntries(entries = []) {
  return entries
    .filter((e) => e.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
}

export const pendingCount = (entries = []) => entries.filter((e) => e.status === 'pending').length;
export const failedCount = (entries = []) => entries.filter((e) => e.status === 'failed').length;

/** Total money sitting in the queue — what has been taken but not recorded. */
export function queuedValue(entries = []) {
  const sum = entries
    .filter((e) => e.status === 'pending')
    .reduce((s, e) => s + (Number(e.total) || 0), 0);
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

/**
 * Applies the result of one attempt.
 *
 * Returns the entry as it should now be stored, or null to drop it — a sale the
 * server has accepted, including one it recognised as a duplicate, is done and
 * has no business staying in a queue.
 */
export function afterAttempt(entry, { ok, err } = {}) {
  if (ok) return null;

  const verdict = classifyFailure(err);
  if (verdict === 'reject') return entry; // untouched; the caller surfaces it

  return {
    ...entry,
    attempts: (entry.attempts || 0) + 1,
    status: verdict === 'stop' ? 'failed' : 'pending',
    error: err?.message ?? null,
  };
}
