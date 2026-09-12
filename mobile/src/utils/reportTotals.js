/**
 * The totals row for each table in an exported report.
 *
 * These are pure on purpose. The same numbers appear in four places -- the CSV,
 * three Excel sheets, the PDF, and the on-screen preview -- and computing them
 * separately in each is how a report ends up disagreeing with itself. Here they
 * are computed once and formatted four ways.
 *
 * Everything rounds at the END, not per row. Summing pre-rounded values drifts:
 * a hundred lines each off by half a paisa is fifty paise the shopkeeper cannot
 * account for, and the totals row is precisely where that becomes visible.
 */

const sum = (rows, pick) => rows.reduce((acc, r) => acc + (Number(pick(r)) || 0), 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Orders sheet. `profit` is gross for the goods on the receipt -- expenses are
 * a separate table and must not be netted off here, or the column stops
 * matching the per-row figures above it.
 */
export function orderTotals(orders = []) {
  const cogs = sum(orders, (o) => o.cogs);
  const grandTotal = sum(orders, (o) => o.grandTotal);
  return {
    count: orders.length,
    units: sum(orders, (o) => o.unitsSold),
    items: sum(orders, (o) => o.itemCount),
    subtotal: round2(sum(orders, (o) => o.subtotal)),
    discount: round2(sum(orders, (o) => o.discount)),
    extraCharges: round2(sum(orders, (o) => o.extraCharges)),
    grandTotal: round2(grandTotal),
    cogs: round2(cogs),
    profit: round2(grandTotal - cogs),
  };
}

/** Line-items sheet: one row per product sold, so quantities are meaningful. */
export function itemTotals(items = []) {
  return {
    count: items.length,
    qty: sum(items, (i) => i.qty),
    discount: round2(sum(items, (i) => i.discount)),
    lineTotal: round2(sum(items, (i) => i.lineTotal)),
    lineProfit: round2(sum(items, (i) => i.lineProfit)),
  };
}

export function expenseTotals(expenses = []) {
  return {
    count: expenses.length,
    amount: round2(sum(expenses, (e) => e.amount)),
  };
}

export function topProductTotals(products = []) {
  return {
    count: products.length,
    qty: sum(products, (p) => p.qty),
    revenue: round2(sum(products, (p) => p.revenue)),
    profit: round2(sum(products, (p) => p.profit)),
  };
}

export function categoryTotals(categories = []) {
  return {
    count: categories.length,
    qty: sum(categories, (c) => c.qty),
    revenue: round2(sum(categories, (c) => c.revenue)),
    profit: round2(sum(categories, (c) => c.profit)),
    // Shares are already percentages of the same whole, so they should land on
    // 100. Summing them rather than asserting 100 is deliberate: if the figure
    // reads 99.98 that is real rounding, and hiding it would be a lie.
    sharePercent: round2(sum(categories, (c) => c.sharePercent)),
  };
}

/**
 * The bottom line for the summary block.
 *
 * `profit` from the API means GROSS. Net is what is left after expenses, and it
 * is NOT floored at zero -- a month where the rent outran the margin is a loss,
 * and that is the number worth acting on.
 */
export function summaryTotals({ totals = {}, expenses = [] } = {}) {
  const gross = Number(totals.grossProfit ?? totals.profit ?? 0);
  const spent = totals.expenses != null
    ? Number(totals.expenses)
    : expenseTotals(expenses).amount;
  return {
    revenue: round2(Number(totals.revenue ?? 0)),
    grossProfit: round2(gross),
    expenses: round2(spent),
    netProfit: round2(gross - spent),
    orders: Number(totals.orders ?? 0),
  };
}
