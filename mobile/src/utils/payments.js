/**
 * How the money came in. Mirrors the server's closed set.
 *
 * Four is the whole list on purpose: cash, UPI and card are what a shop
 * actually sees, and "other" is the escape hatch that stops a fifth from being
 * quietly recorded as cash and wrecking the drawer count.
 */
export const PAYMENT_METHODS = Object.freeze(['cash', 'upi', 'card', 'other']);

export const DEFAULT_PAYMENT_METHOD = 'cash';
