/**
 * The keyboard-overlap arithmetic.
 *
 * SCOPE, stated up front: this is the whole of what can honestly be tested off
 * a real device. There is no soft keyboard on web, so the browser suite cannot
 * see this bug -- it would pass whether or not the fix existed. These
 * assertions can fail, which is the point.
 */
import { load } from './_paths.mjs';

const { dialogBox, isCramped, MAX_HEIGHT_RATIO, MIN_CREDIBLE_KEYBOARD } =
  await load('utils/dialogLayout.js');

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

console.log('no keyboard: the dialog uses the whole window');
const closed = dialogBox(844, 0);
eq(closed.available, 844, 'all 844px are available');
eq(closed.paddingBottom, 0, 'nothing is padded away');
eq(closed.maxHeight, Math.round(844 * MAX_HEIGHT_RATIO), 'the cap is the usual share of the window');

console.log('\nkeyboard up: the card is centred in what remains');
const open = dialogBox(844, 336);
eq(open.available, 508, 'the visible box is the window minus the keyboard');
eq(open.paddingBottom, 336, 'the container is padded by exactly the keyboard height');
eq(open.maxHeight, Math.round(508 * MAX_HEIGHT_RATIO), 'and the cap follows the smaller box');
ok(open.maxHeight < closed.maxHeight, 'a raised keyboard always shrinks the cap', {
  closed: closed.maxHeight, open: open.maxHeight,
});
// The regression this exists to stop: a card that stays 726px tall while only
// 508px are visible has its lower half -- the action row -- under the keyboard.
ok(open.maxHeight <= open.available, 'the card can never be taller than the visible area', open);

console.log('\nbad readings are ignored rather than acted on');
eq(dialogBox(844, 0).paddingBottom, 0, 'zero is closed');
eq(dialogBox(844, MIN_CREDIBLE_KEYBOARD - 1).paddingBottom, 0,
  'a few stray pixels are not a keyboard');
eq(dialogBox(844, MIN_CREDIBLE_KEYBOARD).paddingBottom, MIN_CREDIBLE_KEYBOARD,
  'but the threshold itself counts');
eq(dialogBox(844, NaN).paddingBottom, 0, 'NaN is treated as closed, not as a crash');
eq(dialogBox(844, undefined).paddingBottom, 0, 'so is a missing value');
eq(dialogBox(844, -50).paddingBottom, 0, 'and a negative one');

console.log('\ndegenerate cases cannot collapse the dialog to nothing');
const absurd = dialogBox(844, 2000);
ok(absurd.available === 0 && absurd.maxHeight === 0,
  'a keyboard taller than the window clamps to zero rather than going negative', absurd);
ok(absurd.paddingBottom <= 844, 'and the padding never exceeds the window', absurd);
eq(dialogBox(0, 0).available, 0, 'a zero-height window does not produce NaN');
ok(Number.isFinite(dialogBox(undefined, undefined).maxHeight),
  'a missing window height still yields a number');

console.log('\ncramped detection, for the small-phone-in-landscape case');
ok(!isCramped(844, 0), 'a tall phone with no keyboard is not cramped');
ok(!isCramped(844, 336), 'nor with a keyboard up');
ok(isCramped(640, 336), 'a short window with a keyboard IS cramped', dialogBox(640, 336));
ok(isCramped(360, 0), 'so is a very short window on its own');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
