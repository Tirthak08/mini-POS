// Cart maths must match the server's, or the operator sees one total and the
// customer is charged another.
// Paths resolve against this file (see tests/_paths.mjs) so the suite runs from
// any checkout, not only the machine it was written on.
import { load } from './_paths.mjs';
const money = await load('utils/money.js', [
  ["import { APP_CONFIG } from '../config';", "const APP_CONFIG = { currencySymbol: '₹' };"],
]);
const cart = await load('store/cartStore.js', [
  ["import { round2 } from '../utils/money';", `const round2 = ${money.round2.toString()};`],
  ["import { create } from 'zustand';", `
const create = (fn) => { let state; const set = (partial) => { state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }; }; const get = () => state; state = fn(set, get); return { getState: get, setState: set }; };`],
]);

const { round2 } = money;
const store = cart.useCartStore;
const s = () => store.getState();
let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  PASS  ${label}`)) : (fail++, console.log(`  FAIL  ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

const tea = { _id: 'p1', name: 'Chai', price: 15, cost: 6, stock: 3 };
const chips = { _id: 'p2', name: 'Chips', price: 20.5, cost: 12, stock: 10 };
const gone = { _id: 'p3', name: 'Sold Out', price: 5, cost: 1, stock: 0 };

s().addItem(tea);
eq(s().items.length, 1, 'first tap adds a line');
s().addItem(tea);
eq(s().items[0].qty, 2, 'second tap bumps quantity, no duplicate line');
eq(cart.selectGross(s()), 30, 'gross subtotal 2 x 15 = 30');

s().addItem(chips);
eq(cart.selectGross(s()), 50.5, 'mixed cart gross subtotal');
eq(cart.selectItemCount(s()), 3, 'item count sums quantities');

eq(s().addItem(gone), { ok: false, reason: 'stock' }, 'cannot add a zero-stock product');
s().increment('p1');
eq(s().items[0].qty, 3, 'increment up to stock works');
eq(s().increment('p1'), { ok: false, reason: 'stock' }, 'increment beyond stock refused');

s().setDiscount('p1', 9999);
eq(s().items[0].discount, 45, 'discount clamped to the line gross (3 x 15)');
eq(cart.selectGross(s()), 65.5, 'gross is unchanged by a discount (45 + 20.50)');
eq(cart.selectTotalDiscount(s()), 45, 'the discount is reported on its own, not folded in');
eq(cart.selectNet(s()), 20.5, 'net: clamped line contributes zero, never negative');
eq(cart.selectGrandTotal(s()), 20.5, 'gross - discount = grand total, no double deduction');

s().setDiscount('p1', 30);
s().decrement('p1');
eq(s().items[0].qty, 2, 'decrement lowers quantity');
eq(s().items[0].discount, 30, 'discount still valid at qty 2 (30 <= 30)');
s().decrement('p1');
eq(s().items[0].discount, 15, 'discount re-clamped when quantity drops to 1');

s().setExtraCharges(10);
eq(cart.selectGrandTotal(s()), 30.5, 'extra charges added (0 + 20.50 + 10)');
s().setExtraCharges(-50);
eq(s().extraCharges, 0, 'negative extra charges refused');

s().setDiscount('p2', 20.5);
eq(cart.selectGrandTotal(s()), 0, 'grand total floors at zero, never negative');

const payload = s().toOrderPayload();
eq(payload.items.length, 2, 'payload carries both lines');
eq(Object.keys(payload.items[0]), ['productId', 'qty', 'discount'], 'payload sends no prices -- server decides');

s().decrement('p1');
eq(s().items.length, 1, 'decrementing to zero removes the line');

s().clear();
eq([s().items.length, s().customerName, s().extraCharges], [0, '', 0], 'clear resets everything');

// The exact case the operator reported: one 50-rupee item, 10 off.
console.log('\n  the reported receipt: one 50 item with 10 off');
s().addItem({ _id: 'p9', name: 'Ring', price: 50, cost: 30, stock: 5 });
s().setDiscount('p9', 10);
eq(cart.selectGross(s()), 50, 'subtotal reads 50 -- the item price is untouched');
eq(cart.selectTotalDiscount(s()), 10, 'discount reads 10 on its own line');
eq(cart.selectGrandTotal(s()), 40, 'grand total reads 40');
eq(
  round2(cart.selectGross(s()) - cart.selectTotalDiscount(s()) + s().extraCharges),
  cart.selectGrandTotal(s()),
  'the three numbers add up as printed: 50 - 10 + 0 = 40'
);
eq(cart.lineGross(s().items[0]), 50, 'the cart line still shows 50, not 40');
s().clear();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
