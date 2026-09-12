/**
 * Chart tooltip placement and labelling.
 *
 * SCOPE, and the reason this file exists: the tooltip cannot be exercised in
 * the browser harness AT ALL. react-native-chart-kit attaches its handler as
 * `{ onPressIn, onClick }` on an SVG <Circle>, and react-native-svg's web build
 * forwards neither to the DOM node -- a click, a real mouse press and a full
 * pointer sequence on the hit target were all tried and none fired it. So an
 * end-to-end assertion there would pass with the feature deleted.
 *
 * These assertions can fail, and they cover what would actually go wrong: a
 * callout clipped off the edge of the chart, or a heading that is blank
 * because the axis label it copied was blank.
 */
import { load } from './_paths.mjs';

const money = await load('utils/money.js', [
  ["import { APP_CONFIG } from '../config';", "const APP_CONFIG = { currencySymbol: '₹' };"],
]);
const T = await load('utils/chartTooltip.js');

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

const W = T.TOOLTIP_WIDTH;
const CHART = 334; // what the report renders at 390px wide

console.log('a point in the middle centres the callout on it');
const mid = T.tooltipBox({ x: 160, y: 120, chartWidth: CHART });
eq(mid.left, Math.round(160 - W / 2), 'centred horizontally');
ok(mid.top < 120, 'and sits above the point', mid);
eq(mid.flipped, false, 'no need to flip');

console.log('\nthe edges are where a naive tooltip breaks');
const first = T.tooltipBox({ x: 8, y: 120, chartWidth: CHART });
ok(first.left >= 0, 'the first bucket does not push the callout off the left edge', first);
const last = T.tooltipBox({ x: CHART - 6, y: 120, chartWidth: CHART });
ok(last.left + W <= CHART, 'and the last one stays inside the right edge', {
  ...last, right: last.left + W, chart: CHART,
});

console.log('\na point near the top flips below instead of being clipped');
const high = T.tooltipBox({ x: 160, y: 10, chartWidth: CHART });
eq(high.flipped, true, 'flagged as flipped');
ok(high.top > 10, 'and positioned below the point', high);
ok(high.top >= 0, 'never above the chart', high);

console.log('\na chart narrower than the callout still yields a usable box');
const tiny = T.tooltipBox({ x: 20, y: 40, chartWidth: 60 });
ok(tiny.left >= 0, 'left stays on screen', tiny);
ok(Number.isFinite(tiny.top), 'top is a number', tiny);

console.log('\nmissing coordinates mean no tooltip, not a crash');
eq(T.tooltipBox({ x: null, y: 10 }), null, 'a null x yields nothing to render');
eq(T.tooltipBox({ x: 10, y: undefined }), null, 'so does a missing y');
eq(T.tooltipBox(), null, 'and no arguments at all');
eq(T.tooltipBox({ x: NaN, y: 5 }), null, 'NaN is not a position');

console.log('\nthe heading names the bucket, which the axis often cannot');
eq(T.bucketLabel({ period: '2026-09-12' }, money.formatDate), '12 Sep 2026',
  'a day bucket reads as a full date');
eq(T.bucketLabel('2026-09-12', money.formatDate), '12 Sep 2026',
  'a bare period string works too');
eq(T.bucketLabel({ period: '2026-09' }, money.formatDate), 'Sep 2026',
  'a month bucket names the month, not the 1st -- it would invent precision');
eq(T.bucketLabel({ period: '2026-09-12' }), '12 Sep 2026',
  'and it does not depend on a formatter being passed');

console.log('\nand it never renders an empty heading for real data');
eq(T.bucketLabel({}), '', 'a bucket with no period yields an empty string, not "undefined"');
eq(T.bucketLabel(null), '', 'so does no bucket at all');
eq(T.bucketLabel({ period: 'garbage' }), 'garbage', 'an unparseable period is shown as-is rather than dropped');
for (const m of ['01', '06', '12']) {
  ok(/^[A-Z][a-z]{2} 2026$/.test(T.bucketLabel({ period: `2026-${m}` })),
    `month ${m} maps to a real month name`, T.bucketLabel({ period: `2026-${m}` }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
