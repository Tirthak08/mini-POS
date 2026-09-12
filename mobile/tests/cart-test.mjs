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
// An untouched line still sends no price, so the server prices it from the
// catalogue and the receipt records no override. The key's ABSENCE is the
// signal, which is why this checks the exact key set rather than the value.
eq(Object.keys(payload.items[0]), ['productId', 'qty', 'discount'],
  'an unrepriced line sends no price -- the server decides');

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

/* ------------------------- pricing a line by hand ------------------------- */
console.log('\n  selling at a price other than the catalogue one');
s().clear();
s().addItem({ _id: 'x1', name: 'Rice', price: 100, cost: 60, stock: 10 });

eq(cart.unitPrice(s().items[0]), 100, 'with no override, the catalogue price is charged');
eq(cart.isRepriced(s().items[0]), false, 'and the line is not marked as repriced');

s().setPriceOverride('x1', 130);
eq(cart.unitPrice(s().items[0]), 130, 'the override is what gets charged');
eq(s().items[0].price, 100, 'the catalogue price is kept, not overwritten');
eq(cart.isRepriced(s().items[0]), true, 'the line is marked as repriced');
eq(cart.selectGrandTotal(s()), 130, 'the total follows the override');

s().increment('x1');
eq(cart.lineGross(s().items[0]), 260, 'quantity multiplies the OVERRIDDEN price');

// Clearing has to be possible, or a mis-typed override is stuck.
s().setPriceOverride('x1', '');
eq(cart.unitPrice(s().items[0]), 100, 'clearing the field restores the catalogue price');
eq(cart.isRepriced(s().items[0]), false, 'and the line stops being marked');

// Zero is a giveaway a shop really does. `||` would swallow it.
s().setPriceOverride('x1', 0);
eq(cart.unitPrice(s().items[0]), 0, 'zero is a giveaway, not a missing value');
eq(cart.isRepriced(s().items[0]), true, 'and it counts as repriced');
eq(cart.selectGrandTotal(s()), 0, 'the total is zero, not the catalogue price');

s().setPriceOverride('x1', -5);
eq(cart.unitPrice(s().items[0]), 0, 'a negative price is floored at zero');

console.log('\n  a discount re-clamps when the price drops under it');
s().clear();
s().addItem({ _id: 'x2', name: 'Tin', price: 200, cost: 100, stock: 5 });
s().setDiscount('x2', 150);
eq(s().items[0].discount, 150, '150 off a 200 line is fine');

s().setPriceOverride('x2', 100);
eq(s().items[0].discount, 100,
  'dropping the price to 100 re-clamps the discount, so the operator never sees a figure the server would quietly reduce');
eq(cart.lineTotal(s().items[0]), 0, 'the line total is zero, never negative');
eq(cart.selectGrandTotal(s()), 0, 'and neither is the order');

console.log('\n  the payload carries the override, and only when there is one');
s().clear();
s().addItem({ _id: 'a', name: 'Plain', price: 10, cost: 5, stock: 9 });
s().addItem({ _id: 'b', name: 'Repriced', price: 20, cost: 9, stock: 9 });
s().setPriceOverride('b', 25);
const mixed = s().toOrderPayload();
eq(Object.keys(mixed.items[0]), ['productId', 'qty', 'discount'], 'the untouched line still omits price');
eq(Object.keys(mixed.items[1]), ['productId', 'qty', 'discount', 'price'], 'the repriced one includes it');
eq(mixed.items[1].price, 25, 'and sends the figure that was typed');
s().clear();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
