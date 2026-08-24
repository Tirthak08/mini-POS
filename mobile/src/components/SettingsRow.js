import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

/**
 * One tappable line in a settings list: icon, label, optional current value,
 * chevron.
 *
 * The value sits on the RIGHT of the label rather than under it. A settings
 * list is read by scanning down the labels for the one you want; a second line
 * of text per row doubles the distance the eye travels and halves how many rows
 * fit on a phone. On the right, the values form their own column that is easy
 * to ignore until you need it.
 *
 * `value` is capped to a third of the row so a long shop name pushes the label
 * around instead of wrapping under it.
 */
export default function SettingsRow({
  icon, label, value, onPress, tone = 'default', last = false, badge,
}) {
  const danger = tone === 'danger';
  const iconTint = danger ? '#DC2626' : colors.brand;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      className={`flex-row items-center bg-white px-4 py-3.5 active:bg-slate-50 ${
        last ? '' : 'border-b border-slate-100'
      }`}
    >
      <View
        className={`mr-3 h-9 w-9 items-center justify-center rounded-xl ${
          danger ? 'bg-red-50' : 'bg-blue-50'
        }`}
      >
        <Ionicons name={icon} size={18} color={iconTint} />
      </View>

      <Text
        className={`flex-1 pr-2 text-[15px] font-semibold ${danger ? 'text-red-600' : 'text-slate-800'}`}
        numberOfLines={1}
      >
        {label}
      </Text>

      {badge}

      {value ? (
        <Text className="max-w-[38%] pr-1.5 text-right text-sm text-slate-500" numberOfLines={1}>
          {value}
        </Text>
      ) : null}

      {onPress ? <Ionicons name="chevron-forward" size={17} color="#CBD5E1" /> : null}
    </Pressable>
  );
}

/** A titled group of rows. The title is outside the card, as in iOS/Android settings. */
export function SettingsGroup({ title, children, className = '' }) {
  return (
    <View className={`px-4 ${className}`}>
      {title ? (
        <Text className="mb-1.5 ml-1 text-xs font-bold uppercase tracking-wide text-slate-400">
          {title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-2xl border border-slate-200">{children}</View>
    </View>
  );
}
