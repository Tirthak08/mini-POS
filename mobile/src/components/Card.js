import { Text, View } from 'react-native';

export function Card({ children, className = '' }) {
  return (
    <View className={`rounded-2xl border border-slate-200 bg-white p-4 ${className}`}>
      {children}
    </View>
  );
}

/** One KPI tile. `tone` colours only the value, keeping the grid calm. */
export function StatTile({ label, value, sub, tone = 'default', className = '' }) {
  const toneClass = {
    default: 'text-slate-900',
    positive: 'text-green-600',
    negative: 'text-red-600',
    brand: 'text-blue-600',
  }[tone] ?? 'text-slate-900';

  return (
    <View className={`rounded-2xl border border-slate-200 bg-white p-3 ${className}`}>
      <Text className="text-xs font-medium text-slate-500" numberOfLines={1}>{label}</Text>
      <Text className={`mt-1 text-xl font-bold ${toneClass}`} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text className="mt-0.5 text-xs text-slate-400" numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-600',
    success: 'bg-green-100 text-green-700',
    warning: 'bg-amber-100 text-amber-700',
    danger: 'bg-red-100 text-red-700',
    brand: 'bg-blue-100 text-blue-700',
  };
  const [bg, text] = (tones[tone] ?? tones.neutral).split(' ');
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${bg}`}>
      <Text className={`text-xs font-semibold ${text}`}>{label}</Text>
    </View>
  );
}
