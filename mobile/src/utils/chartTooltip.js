/**
 * Where a chart tooltip sits, and what its heading says.
 *
 * Pure, because the browser harness cannot reach this feature at all.
 * react-native-chart-kit attaches its handler as `{ onPressIn, onClick }` on an
 * SVG <Circle>, and react-native-svg's WEB build does not forward either to the
 * DOM node -- so on web the point is simply not clickable and any end-to-end
 * assertion about the tooltip passes whether or not the feature works. Proved
 * by dispatching click, a real mouse press and a full pointer sequence at the
 * hit target and watching nothing happen.
 *
 * What CAN be checked is the arithmetic that decides where the callout lands
 * and what it is labelled, which is where the bugs would be anyway: a callout
 * clipped off the edge of the chart, or a heading that says nothing because the
 * axis label it copied was blank.
 */

/** Locale-independent, matching formatDate -- no ICU data required. */
export const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const TOOLTIP_WIDTH = 116;
export const TOOLTIP_HEIGHT = 46;

/**
 * @returns { left, top, flipped }
 *
 * Centred on the point, then pulled back inside the chart at both edges -- the
 * first and last buckets would otherwise put half the callout off-screen, and a
 * tooltip you cannot read is worse than none. Near the top it flips below the
 * point instead of being clipped by the chart's own bounds.
 */
export function tooltipBox({
  x, y, chartWidth = 300, width = TOOLTIP_WIDTH, height = TOOLTIP_HEIGHT, margin = 4,
} = {}) {
  // `Number(null)` is 0, which Number.isFinite happily accepts -- so checking
  // only for finiteness placed a callout at the chart's origin whenever a
  // coordinate was missing. Both guards are needed.
  const bad = (v) => v == null || !Number.isFinite(Number(v));
  if (bad(x) || bad(y)) return null;

  const maxLeft = Math.max(margin, chartWidth - width - margin);
  const left = Math.max(margin, Math.min(maxLeft, Number(x) - width / 2));

  const flipped = Number(y) < height + 8;
  const top = flipped ? Number(y) + 12 : Number(y) - height - 8;

  return { left: Math.round(left), top: Math.round(top), flipped };
}

/**
 * The heading for a trend bucket.
 *
 * It reads the date from the DATA, not from the axis, and that is the whole
 * point: the x-axis deliberately blanks most of its labels so thirty buckets do
 * not overlap into mush, which means the point you tap usually has no label at
 * all. Copying the axis would have produced an empty tooltip precisely where
 * one is most needed.
 *
 * A month bucket returns "Sep 2026" rather than the 1st of the month -- naming
 * a day the bucket does not represent invents precision the figure lacks.
 */
export function bucketLabel(bucket, formatDate) {
  const period = typeof bucket === 'string' ? bucket : bucket?.period;
  if (!period) return '';

  const parts = String(period).split('-');
  const [y, m, d] = parts.map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return String(period);

  if (parts.length === 3 && Number.isFinite(d)) {
    const date = new Date(y, m - 1, d);
    return typeof formatDate === 'function'
      ? formatDate(date)
      : `${String(d).padStart(2, '0')} ${MONTH_LABELS[m - 1] ?? ''} ${y}`;
  }
  return `${MONTH_LABELS[m - 1] ?? ''} ${y}`.trim();
}
