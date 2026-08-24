/**
 * Detects "this deployment cannot do transactions".
 *
 * The driver often reports a *different* top-level message ("does not support
 * retryable writes") and buries the real cause in errorResponse.originalError,
 * so matching err.message alone silently misses the case. Walk the chain.
 */
const UNSUPPORTED = /Transaction numbers are only allowed|Transactions? (are|is) not supported|does not support retryable writes|does not support transactions|replica set member or mongos|Illegal ?Operation/i;

export function isTransactionUnsupported(err) {
  const texts = [];
  const seen = new Set();

  (function walk(e, depth = 0) {
    if (!e || typeof e !== 'object' || depth > 5 || seen.has(e)) return;
    seen.add(e);
    for (const key of ['message', 'errmsg', 'codeName']) {
      if (e[key]) texts.push(String(e[key]));
    }
    walk(e.errorResponse, depth + 1);
    walk(e.originalError, depth + 1);
    walk(e.cause, depth + 1);
  })(err);

  return UNSUPPORTED.test(texts.join(' | '));
}
