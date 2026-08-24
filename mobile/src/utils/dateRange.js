import { toApiDate } from './money';

/**
 * One definition of "this month" for the whole app.
 *
 * Reports and Sales used to each build their own {from,to} from a day count,
 * which meant "30 days" on one screen and "30 days" on the other could
 * disagree by a day depending on when the screen mounted. Everything now comes
 * through resolveRange() so the two tabs can never drift.
 *
 * Ranges are always whole local days: from 00:00:00.000 to 23:59:59.999. The
 * backend's parseDateRange does the same widening for YYYY-MM-DD params, so a
 * sale rung up at 11pm is inside "today" on both sides.
 */

/** Order matters -- this is the order the options are listed in. */
export const PRESET_KEYS = [
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'lastYear',
  'all',
  'custom',
];

/** Far enough back that no shop's first sale predates it. */
const ALL_TIME_FLOOR = new Date(1970, 0, 1);

export const startOfDay = (value) => {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
};

export const endOfDay = (value) => {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
};

const addDays = (value, n) => {
  const d = new Date(value);
  d.setDate(d.getDate() + n);
  return d;
};

/**
 * 0 = Sunday. Indian calendars print Sunday first and the custom-range grid in
 * DateRangePicker is laid out S M T W T F S, so "this week" has to agree with
 * the week the operator can see. Exported rather than inlined so the grid and
 * these presets cannot drift apart.
 */
export const WEEK_STARTS_ON = 0;

/** Most recent WEEK_STARTS_ON at or before `value`. */
export const startOfWeek = (value) => {
  const d = startOfDay(value);
  const shift = (d.getDay() - WEEK_STARTS_ON + 7) % 7;
  d.setDate(d.getDate() - shift);
  return d;
};

export const sameDay = (a, b) =>
  !!a && !!b &&
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Turns a preset key into a concrete range.
 *
 * `now` is injectable so the tests do not depend on the day they run, and
 * `custom` is only consulted for the 'custom' key.
 */
export function resolveRange(key, { now = new Date(), custom } = {}) {
  const today = startOfDay(now);
  const y = today.getFullYear();
  const m = today.getMonth();
  let from;
  let to;

  switch (key) {
    case 'today':
      from = today;
      to = endOfDay(today);
      break;
    case 'yesterday': {
      const d = addDays(today, -1);
      from = d;
      to = endOfDay(d);
      break;
    }
    case 'thisWeek':
      from = startOfWeek(today);
      // Capped at today, like thisMonth: a week-to-date figure should not imply
      // the remaining days were zero-sales days.
      to = endOfDay(today);
      break;
    case 'lastWeek': {
      const thisWeekStart = startOfWeek(today);
      from = addDays(thisWeekStart, -7);
      to = endOfDay(addDays(thisWeekStart, -1));
      break;
    }
    case 'thisMonth':
      from = new Date(y, m, 1);
      // Capped at today: a month-to-date figure should not imply the rest of
      // the month was a zero-sales stretch.
      to = endOfDay(today);
      break;
    case 'lastMonth':
      from = new Date(y, m - 1, 1);
      to = endOfDay(new Date(y, m, 0)); // day 0 of this month = last day of last
      break;
    case 'thisYear':
      from = new Date(y, 0, 1);
      to = endOfDay(today);
      break;
    case 'lastYear':
      from = new Date(y - 1, 0, 1);
      to = endOfDay(new Date(y - 1, 11, 31));
      break;
    case 'all':
      from = new Date(ALL_TIME_FLOOR);
      to = endOfDay(today);
      break;
    case 'custom': {
      const a = custom?.from ? startOfDay(custom.from) : today;
      const b = custom?.to ? startOfDay(custom.to) : a;
      // Tapping the end date before the start date is a normal way to pick a
      // range, so accept it rather than erroring.
      from = a <= b ? a : b;
      to = endOfDay(a <= b ? b : a);
      break;
    }
    default:
      return resolveRange('thisMonth', { now });
  }

  // Both ends normalised to midnight first: endOfDay(to) - startOfDay(from) is
  // 86399999ms for a single day, which rounds to 1 and then +1 gives 2.
  const spanDays = Math.max(
    1,
    Math.round((startOfDay(to) - startOfDay(from)) / 864e5) + 1
  );

  return {
    key,
    from,
    to,
    spanDays,
    // Two months of daily buckets is already a crowded x-axis; beyond that the
    // chart is unreadable, so roll up to months.
    groupBy: spanDays > 62 ? 'month' : 'day',
    // What actually goes on the wire.
    apiRange: { from: toApiDate(from), to: toApiDate(to) },
  };
}

/** The default a screen opens on. */
export const DEFAULT_PRESET = 'thisMonth';

/**
 * Human label for the chosen range. Presets say their own name; custom spells
 * out the dates, because "Custom" alone tells the operator nothing.
 */
export function describeRange(range, t, formatDate) {
  if (!range) return '';
  if (range.key === 'all') return t('range.all');
  if (range.key === 'today' || range.key === 'yesterday') return formatDate(range.from);
  if (sameDay(range.from, range.to)) return formatDate(range.from);
  return `${formatDate(range.from)} – ${formatDate(range.to)}`;
}
