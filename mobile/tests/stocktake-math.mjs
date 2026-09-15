/**
 * The count's arithmetic, without a renderer.
 *
 * The property that matters most is the one about blanks: a field nobody typed
 * into must never reach the server, and must never be read as zero.
 */
import {
  parseCount, isCounted, rowState, summarise, buildPayload, changedRows,
} from '../src/utils/stocktake.js';

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`));
};

const P = (id, stock, cost = 10) => ({ _id: id, name: `P${id}`, stock, cost });

console.log('\n=== blank is not zero ===');
check('blank -> not counted', parseCount('') === null);
check('whitespace -> not counted', parseCount('   ') === null);
check('undefined -> not counted', parseCount(undefined) === null);
check('null -> not counted', parseCount(null) === null);
check('"0" IS counted', parseCount('0') === 0);
check('  and isCounted agrees', isCounted('0') === true && isCounted('') === false);
check('a negative count is rejected', parseCount('-3') === null);
check('a fractional count is rejected', parseCount('2.5') === null);
check('letters are rejected', parseCount('abc') === null);
check('a plain number works', parseCount(7) === 7);

console.log('\n=== one row ===');
check('untouched row is pending', rowState(P('a', 10), '').status === 'pending');
check('  and contributes no variance', rowState(P('a', 10), '').variance === 0);
check('matching count -> match', rowState(P('a', 10), '10').status === 'match');
check('short count -> short', rowState(P('a', 10), '7').status === 'short');
check('  variance is -3', rowState(P('a', 10), '7').variance === -3);
check('  valued at cost, not price',
  rowState({ _id: 'a', stock: 10, cost: 40, price: 100 }, '7').value === -120,
  rowState({ _id: 'a', stock: 10, cost: 40, price: 100 }, '7').value);
check('over count -> over', rowState(P('a', 10), '12').status === 'over');
check('counting a product down to zero is a real count',
  rowState(P('a', 10), '0').status === 'short' && rowState(P('a', 10), '0').variance === -10);
check('a product with no cost is valued at 0',
  rowState({ _id: 'a', stock: 5 }, '3').value === 0);

console.log('\n=== the summary ===');
const products = [P('a', 10, 40), P('b', 5, 10), P('c', 8, 25), P('d', 2, 60)];
const counts = { a: '7', b: '5', c: '', d: '4' };
const s = summarise(products, counts);
check('counts only what was entered', s.counted === 3, s);
check('pending is the rest', s.pending === 1, s);
check('a matching row is counted but is not a difference', s.differences === 2, s);
check('units lost', s.unitsLost === 3, s);
check('units gained', s.unitsGained === 2, s);
check('variance value nets out at cost', s.varianceValue === -120 + 120, s);
check('an empty count summarises to nothing',
  summarise(products, {}).counted === 0 && summarise(products, {}).varianceValue === 0);
check('summarising no products at all does not throw',
  summarise([], {}).total === 0);

console.log('\n=== the payload ===');
const payload = buildPayload(products, counts, '  Sunday count  ');
check('only counted rows are sent', payload.counts.length === 3, payload.counts);
check('  and the blank one is absent',
  !payload.counts.some((r) => r.productId === 'c'), payload.counts);
check('  a zero IS sent', buildPayload([P('z', 4)], { z: '0' }).counts[0].counted === 0);
check('the note is trimmed', payload.note === 'Sunday count', payload.note);
check('an empty note is omitted entirely',
  buildPayload(products, counts, '   ').note === undefined);
check('a long note is clipped to what the server accepts',
  buildPayload(products, counts, 'x'.repeat(500)).note.length === 120);
check('ids are sent as strings',
  payload.counts.every((r) => typeof r.productId === 'string'));

console.log('\n=== units decide whether a fraction is a count ===');
const KG = (id, stock, cost = 10) => ({ _id: id, name: `K${id}`, stock, cost, unit: 'kg' });
check('36.25 kg is a count', parseCount('36.25', 'kg') === 36.25, parseCount('36.25', 'kg'));
check('9.5 bars of soap is not', parseCount('9.5', 'pcs') === null, parseCount('9.5', 'pcs'));
check('  nor is it with no unit given', parseCount('9.5') === null);
check('a mid-typed "36." is not a count yet', parseCount('36.', 'kg') === null, parseCount('36.', 'kg'));
check('  and neither is a lone dot', parseCount('.', 'kg') === null);
check('a kg row reports a fractional variance',
  rowState(KG('k', 40, 45), '36.25').variance === -3.75, rowState(KG('k', 40, 45), '36.25').variance);
check('  valued at cost', rowState(KG('k', 40, 40), '36.25').value === -150,
  rowState(KG('k', 40, 40), '36.25').value);
check('a fraction against pcs stays pending, not counted',
  rowState(P('p', 10), '2.5').status === 'pending', rowState(P('p', 10), '2.5').status);
check('  so it is never sent', buildPayload([P('p', 10)], { p: '2.5' }).counts.length === 0);
check('fractions survive the summary without float dust',
  summarise([KG('a', 1, 10), KG('b', 1, 10)], { a: '0.1', b: '0.2' }).unitsLost === 1.7,
  summarise([KG('a', 1, 10), KG('b', 1, 10)], { a: '0.1', b: '0.2' }));

console.log('\n=== the confirmation list ===');
const changed = changedRows(products, counts);
check('only differing rows are listed', changed.length === 2, changed.map((c) => c.product._id));
check('  shortfalls first, worst at the top',
  changed[0].variance === -3 && changed[1].variance === 2, changed.map((c) => c.variance));
check('  it carries the product for the label',
  changed[0].product.name === 'Pa', changed[0].product.name);
check('nothing changed -> empty list',
  changedRows(products, { a: '10', b: '5' }).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
