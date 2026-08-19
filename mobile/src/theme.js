/**
 * Chart libraries take plain JS objects, not Tailwind class names, so the
 * palette lives here as the single source of truth.
 *
 * `chartPalette` is a VALIDATED categorical ramp: every adjacent pair clears
 * the colour-vision-deficiency separation threshold. It was checked with a
 * palette validator, not chosen by eye -- an earlier hand-picked ramp put
 * orange next to olive, which deuteranopes cannot tell apart at all (deltaE 1.7).
 *
 * Rules that go with it:
 *   - assign slots in FIXED order, never cycled;
 *   - a 7th category folds into "Other" (grey) rather than inventing a hue;
 *   - identity is never colour alone -- every series also carries a text label.
 */
export const chartPalette = [
  '#2A78D6', // 1 blue
  '#EB6834', // 2 orange
  '#1BAF7A', // 3 aqua
  '#EDA100', // 4 yellow
  '#E87BA4', // 5 magenta
  '#008300', // 6 green
  '#4A3AA7', // 7 violet
  '#E34948', // 8 red
];

/** Anything beyond the fixed slots is grouped here. */
export const otherColor = '#898781';

export const colors = {
  brand: '#2563EB',
  brandDark: '#1D4ED8',
  brandLight: '#DBEAFE',
  // Status inks -- reserved, never reused as a series colour.
  success: '#006300',
  successBright: '#0CA30C',
  danger: '#D03B3B',
  warning: '#FAB219',
  // Text tokens: values and labels wear these, never a series colour.
  text: '#0B0B0B',
  textSecondary: '#52514E',
  textMuted: '#898781',
  border: '#E1E0D9',
  surface: '#FFFFFF',
  background: '#F8FAFC',
  gridline: '#E1E0D9',
};

/** The two series on the revenue-vs-profit chart, both in rupees on ONE axis. */
export const seriesColors = {
  revenue: chartPalette[0],
  profit: chartPalette[1],
};

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

/** react-native-chart-kit wants rgba factories rather than colour strings. */
export const rgba = (hex) => (opacity = 1) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
};

export const chartConfig = {
  backgroundGradientFrom: colors.surface,
  backgroundGradientTo: colors.surface,
  backgroundGradientFromOpacity: 1,
  backgroundGradientToOpacity: 1,
  decimalPlaces: 0,
  color: rgba(chartPalette[0]),
  labelColor: rgba(colors.textMuted),
  // Solid hairlines: dashed gridlines read as data and add noise.
  // strokeDasharray '' is required: chart-kit defaults to a dashed pattern,
  // and dashed gridlines read as data.
  propsForBackgroundLines: { stroke: colors.gridline, strokeWidth: 1, strokeDasharray: '' },
  propsForDots: { r: '3.5', strokeWidth: '2', stroke: colors.surface },
  propsForLabels: { fontSize: 10 },
  strokeWidth: 2,
  useShadowColorFromDataset: false,
};
