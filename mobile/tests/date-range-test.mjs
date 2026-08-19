// The preset arithmetic decides which sales a shopkeeper sees. An off-by-one
// day here silently hides yesterday's takings, so every boundary is asserted
// against a fixed "now" rather than the day the suite happens to run.
import fs from 'fs';
const load = async (p, subs = []) => {
  let src = fs.readFileSync(p, 'utf8');
  for (const [from, to] of subs) src = src.replace(from, to);
  return import('data:text/javascript,' + encodeURIComponent(src));
};
const money = await load('/root/posapp/src/utils/money.js', [
  ["import { APP_CONFIG } from '../config';", "const APP_CONFIG = { currencySymbol: '₹' };"],
]);
const R = await load('/root/posapp/src/utils/dateRange.js', [
  ["import { toApiDate } from './money';", `const toApiDate = ${money.toApiDate.toString()};`],
]);

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  PASS  ${label}`)) : (fail++, console.log(`  FAIL  ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

// Tuesday 18 Aug 2026, 14:30 local -- mid-month, mid-year, mid-afternoon.
const now = new Date(2026, 7, 18, 14, 30, 0);
const api = (key, custom) => R.resolveRange(key, { now, custom }).apiRange;

console.log('presets against a fixed Tue 18 Aug 2026');
eq(api('today'), { from: '2026-08-18', to: '2026-08-18' }, 'today is a single day');
eq(api('yesterday'), { from: '2026-08-17', to: '2026-08-17' }, 'yesterday is a single day, not two');
eq(api('thisWeek'), { from: '2026-08-16', to: '2026-08-18' }, 'this week runs from Sunday to today');
eq(api('lastWeek'), { from: '2026-08-09', to: '2026-08-15' }, 'last week is the seven days Sun-Sat before it');
eq(api('thisMonth'), { from: '2026-08-01', to: '2026-08-18' }, 'this month runs 1st to today, not to the 31st');
eq(api('lastMonth'), { from: '2026-07-01', to: '2026-07-31' }, 'last month is the whole of July');
eq(api('thisYear'), { from: '2026-01-01', to: '2026-08-18' }, 'this year runs Jan 1 to today');
eq(api('lastYear'), { from: '2025-01-01', to: '2025-12-31' }, 'last year is the whole of 2025');
eq(api('all').to, '2026-08-18', 'all time ends today');
eq(R.resolveRange('all', { now }).from.getFullYear() <= 1970, true, 'all time starts before any shop existed');

console.log('\nwhole-day boundaries (a sale at 23:59 must count)');
const today = R.resolveRange('today', { now });
eq([today.from.getHours(), today.from.getMinutes(), today.from.getSeconds()], [0, 0, 0], 'from is midnight');
eq([today.to.getHours(), today.to.getMinutes(), today.to.getSeconds(), today.to.getMilliseconds()], [23, 59, 59, 999], 'to is the last instant of the day');

console.log('\nmonth-end and year-end edges');
const jan31 = new Date(2026, 0, 31, 9, 0);
eq(R.resolveRange('lastMonth', { now: jan31 }).apiRange, { from: '2025-12-01', to: '2025-12-31' }, 'last month from January reaches back into December');
eq(R.resolveRange('thisMonth', { now: jan31 }).apiRange, { from: '2026-01-01', to: '2026-01-31' }, 'this month on the 31st ends on the 31st');
const mar1 = new Date(2024, 2, 1, 9, 0); // 2024 is a leap year
eq(R.resolveRange('lastMonth', { now: mar1 }).apiRange, { from: '2024-02-01', to: '2024-02-29' }, 'February in a leap year ends on the 29th');
const nonLeap = new Date(2026, 2, 1, 9, 0);
eq(R.resolveRange('lastMonth', { now: nonLeap }).apiRange, { from: '2026-02-01', to: '2026-02-28' }, 'February in a normal year ends on the 28th');
const dec31 = new Date(2026, 11, 31, 23, 0);
eq(R.resolveRange('thisYear', { now: dec31 }).apiRange, { from: '2026-01-01', to: '2026-12-31' }, 'this year on Dec 31 covers the full year');

console.log('\nweek edges (Sunday-start, matching the calendar grid)');
// 16 Aug 2026 is itself a Sunday.
const onSunday = new Date(2026, 7, 16, 10, 0);
eq(R.resolveRange('thisWeek', { now: onSunday }).apiRange, { from: '2026-08-16', to: '2026-08-16' },
   'on a Sunday, this week is just that one day so far');
eq(R.resolveRange('lastWeek', { now: onSunday }).apiRange, { from: '2026-08-09', to: '2026-08-15' },
   'and last week is the full week that just ended');
// 15 Aug 2026 is a Saturday -- the last day of its week.
const onSaturday = new Date(2026, 7, 15, 22, 0);
eq(R.resolveRange('thisWeek', { now: onSaturday }).apiRange, { from: '2026-08-09', to: '2026-08-15' },
   'on a Saturday, this week is the complete seven days');
eq(R.resolveRange('thisWeek', { now: onSaturday }).spanDays, 7, 'a finished week spans 7 days');
eq(R.resolveRange('lastWeek', { now: onSaturday }).spanDays, 7, 'last week always spans exactly 7 days');
// A week that straddles the end of a month.
const tueSep1 = new Date(2026, 8, 1, 9, 0);
eq(R.resolveRange('thisWeek', { now: tueSep1 }).apiRange, { from: '2026-08-30', to: '2026-09-01' },
   'a week straddling a month boundary reaches back into August');
eq(R.resolveRange('lastWeek', { now: tueSep1 }).apiRange, { from: '2026-08-23', to: '2026-08-29' },
   'and last week stays wholly in August');
// A week that straddles new year.
const friJan1 = new Date(2027, 0, 1, 9, 0);
eq(R.resolveRange('thisWeek', { now: friJan1 }).apiRange, { from: '2026-12-27', to: '2027-01-01' },
   'a week straddling new year reaches back into the previous year');
eq(R.resolveRange('lastWeek', { now: friJan1 }).apiRange, { from: '2026-12-20', to: '2026-12-26' },
   'and last week is wholly in the old year');
eq(R.WEEK_STARTS_ON, 0, 'the week starts on Sunday, as the calendar grid shows it');
eq(R.startOfWeek(new Date(2026, 7, 18)).getDay(), 0, 'startOfWeek always lands on a Sunday');
eq([0, 1, 2, 3, 4, 5, 6].map((d) => R.startOfWeek(new Date(2026, 7, 16 + d)).getDate()),
   [16, 16, 16, 16, 16, 16, 16], 'every day of one week resolves to the same week start');

console.log('\ncustom ranges');
eq(api('custom', { from: new Date(2026, 5, 3), to: new Date(2026, 5, 9) }),
   { from: '2026-06-03', to: '2026-06-09' }, 'custom range keeps both ends');
eq(api('custom', { from: new Date(2026, 5, 9), to: new Date(2026, 5, 3) }),
   { from: '2026-06-03', to: '2026-06-09' }, 'a backwards custom range is swapped, not rejected');
eq(api('custom', { from: new Date(2026, 5, 3) }),
   { from: '2026-06-03', to: '2026-06-03' }, 'one tapped day is a valid one-day range');

console.log('\nchart bucket size follows the span, not the preset name');
eq(R.resolveRange('today', { now }).groupBy, 'day', 'a single day is bucketed by day');
eq(R.resolveRange('thisMonth', { now }).groupBy, 'day', '18 days of buckets stay daily');
eq(R.resolveRange('lastMonth', { now }).groupBy, 'day', '31 days stay daily');
eq(R.resolveRange('thisYear', { now }).groupBy, 'month', 'year-to-date is past 62 days, so it rolls up to months');
eq(R.resolveRange('custom', { now, custom: { from: new Date(2026, 5, 1), to: new Date(2026, 6, 31) } }).groupBy, 'day', '61 days is still daily');
eq(R.resolveRange('custom', { now, custom: { from: new Date(2026, 5, 1), to: new Date(2026, 7, 2) } }).groupBy, 'month', '63 days crosses over to monthly');
eq(R.resolveRange('lastYear', { now }).groupBy, 'month', 'a full year rolls up to months');
eq(R.resolveRange('all', { now }).groupBy, 'month', 'all time rolls up to months');
eq(R.resolveRange('today', { now }).spanDays, 1, 'today spans one day');
eq(R.resolveRange('lastMonth', { now }).spanDays, 31, 'July spans 31 days');

console.log('\nfallbacks');
eq(R.resolveRange('nonsense', { now }).apiRange, api('thisMonth'), 'an unknown key falls back to this month rather than crashing');
eq(R.PRESET_KEYS,
   ['today','yesterday','thisWeek','lastWeek','thisMonth','lastMonth','thisYear','lastYear','all','custom'],
   'the options are listed shortest range first, weeks between days and months');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
