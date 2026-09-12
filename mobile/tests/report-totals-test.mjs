/**
 * The totals rows on every exported table.
 *
 * The assertions that matter are about ROUNDING and about what a total must
 * refuse to do. Summing pre-rounded values drifts, a total that quietly floors
 * a loss at zero hides the one figure worth acting on, and a totals row that
 * disagrees with the rows above it makes the whole export untrustworthy.
 */
import { load } from './_paths.mjs';

const T = await load('utils/reportTotals.js');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  PASS  ${label}`))
     : (fail++, console.log(`  FAIL  ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};
const ok = (cond, label, extra) => {
  cond ? (pass++, console.log(`  PASS  ${label}`))
       : (fail++, console.log(`  FAIL  ${label}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`));
};

console.log('orders');
const orders = [
  { itemCount: 2, unitsSold: 3, subtotal: 500, discount: 50, extraCharges: 10, grandTotal: 460, cogs: 300 },
  { itemCount: 1, unitsSold: 1, subtotal: 200, discount: 0, extraCharges: 0, grandTotal: 200, cogs: 120 },
];
const ot = T.orderTotals(orders);
eq(ot.count, 2, 'counts the receipts');
eq(ot.units, 4, 'sums units across them');
eq(ot.subtotal, 700, 'sums the gross subtotal');
eq(ot.discount, 50, 'sums discounts');
eq(ot.grandTotal, 660, 'sums what was actually charged');
eq(ot.cogs, 420, 'sums cost of goods');
eq(ot.profit, 240, 'profit is total charged minus total cost');
ok(ot.profit === ot.grandTotal - ot.cogs, 'and the three agree with each other', ot);

console.log('\nempty tables still produce a row');
eq(T.orderTotals([]).grandTotal, 0, 'no orders totals zero, not NaN');
eq(T.orderTotals().count, 0, 'a missing array is treated as empty');
eq(T.itemTotals().qty, 0, 'same for line items');
eq(T.expenseTotals().amount, 0, 'and expenses');
ok(Number.isFinite(T.topProductTotals().revenue), 'and top products yields a number');

console.log('\nrounding happens once, at the end');
// Three lines that each round DOWN individually but sum to a clean figure.
const drifty = [
  { qty: 1, discount: 0, lineTotal: 33.333, lineProfit: 10.005 },
  { qty: 1, discount: 0, lineTotal: 33.333, lineProfit: 10.005 },
  { qty: 1, discount: 0, lineTotal: 33.334, lineProfit: 10.005 },
];
eq(T.itemTotals(drifty).lineTotal, 100,
  'three thirds of a hundred total exactly 100, not 99.99');
eq(T.itemTotals(drifty).lineProfit, 30.02,
  'and the profit column rounds the SUM, not each row');

console.log('\nmalformed rows do not poison a total');
const messy = [
  { qty: 2, lineTotal: 10, lineProfit: 4 },
  { qty: undefined, lineTotal: null, lineProfit: 'x' },
  { qty: 3, lineTotal: 5, lineProfit: 1 },
];
const it = T.itemTotals(messy);
eq(it.qty, 5, 'a missing quantity counts as zero rather than making the total NaN');
eq(it.lineTotal, 15, 'so does a null amount');
eq(it.lineProfit, 5, 'and an unparseable one');

console.log('\ncategories');
const cats = [
  { qty: 4, revenue: 600, profit: 200, sharePercent: 60 },
  { qty: 2, revenue: 400, profit: 100, sharePercent: 40 },
];
const ct = T.categoryTotals(cats);
eq(ct.revenue, 1000, 'category revenue sums');
eq(ct.sharePercent, 100, 'and the shares add to 100');
// Real data rounds; the total should show that honestly rather than assert 100.
eq(T.categoryTotals([{ sharePercent: 33.33 }, { sharePercent: 33.33 }, { sharePercent: 33.33 }]).sharePercent,
  99.99, 'a share total that does not reach 100 is shown as it is, not fudged');

console.log('\nthe summary bottom line');
eq(T.summaryTotals({ totals: { revenue: 2000, grossProfit: 800, expenses: 300, orders: 4 } }),
  { revenue: 2000, grossProfit: 800, expenses: 300, netProfit: 500, orders: 4 },
  'net is gross minus expenses');

// The case everyone gets wrong.
const loss = T.summaryTotals({ totals: { revenue: 2000, grossProfit: 800, expenses: 3000 } });
eq(loss.netProfit, -2200, 'a month where expenses outran the margin reports a LOSS');
ok(loss.netProfit < 0, 'it is not floored at zero', loss);

// An older export payload has `profit` but no `grossProfit`.
eq(T.summaryTotals({ totals: { revenue: 100, profit: 40 }, expenses: [{ amount: 15 }] }).netProfit, 25,
  'falls back to `profit` and to summing the expense rows when the totals block is older');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
