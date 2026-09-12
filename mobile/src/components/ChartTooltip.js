import { Text, View } from 'react-native';
import { tooltipBox, TOOLTIP_WIDTH } from '../utils/chartTooltip';

/**
 * The value behind a point on a line chart.
 *
 * A line chart shows shape well and exact values not at all -- "roughly two
 * thousand, some day in the middle of the month" is not an answer a shopkeeper
 * can act on. Tapping a point should say which day and how much.
 *
 * Positioned absolutely over the chart rather than drawn into it, because
 * react-native-chart-kit hands back the point's pixel coordinates and nothing
 * else; there is no hook for rendering inside the SVG.
 *
 * The clamping is the fiddly part. A callout anchored naively to the point runs
 * off the left edge for the first bucket and off the right for the last, and a
 * tooltip you cannot read is worse than none.
 */
export default function ChartTooltip({ x, y, label, value, sub, chartWidth }) {
  const box = tooltipBox({ x, y, chartWidth });
  if (!box) return null;
  const { left, top } = box;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left,
        top,
        width: TOOLTIP_WIDTH,
        shadowColor: '#00111F',
        shadowOpacity: 0.2,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
        elevation: 6,
      }}
      // Announced as one string: a screen reader reading a floating box of
      // fragments out of order is no use.
      accessible
      accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}
    >
      <View className="rounded-xl bg-slate-900 px-2.5 py-1.5">
        <Text className="text-[10px] font-medium text-white/70" numberOfLines={1}>{label}</Text>
        <Text className="text-sm font-bold text-white" numberOfLines={1}>{value}</Text>
        {sub ? <Text className="text-[10px] text-white/70" numberOfLines={1}>{sub}</Text> : null}
      </View>
    </View>
  );
}
