import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const VARIANTS = {
  primary: { box: 'bg-blue-600 active:bg-blue-700', text: 'text-white', spinner: '#fff' },
  secondary: { box: 'bg-white border border-slate-300 active:bg-slate-100', text: 'text-slate-800', spinner: '#334155' },
  danger: { box: 'bg-red-600 active:bg-red-700', text: 'text-white', spinner: '#fff' },
  ghost: { box: 'bg-transparent active:bg-slate-100', text: 'text-blue-600', spinner: '#2563EB' },
  success: { box: 'bg-green-600 active:bg-green-700', text: 'text-white', spinner: '#fff' },
};

const SIZES = {
  sm: { box: 'px-3 py-2', text: 'text-sm', icon: 15 },
  md: { box: 'px-4 py-3', text: 'text-base', icon: 18 },
  lg: { box: 'px-5 py-4', text: 'text-lg', icon: 20 },
};

export default function Button({
  title, onPress, variant = 'primary', size = 'md',
  loading = false, disabled = false, icon, fullWidth = false, className = '',
  accessibilityLabel,
}) {
  const v = VARIANTS[variant] ?? VARIANTS.primary;
  const s = SIZES[size] ?? SIZES.md;
  const isDead = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDead}
      accessibilityRole="button"
      // Falls back to the visible title, but a caller can disambiguate rows in
      // a list -- "Archive Sharma Kirana" rather than four buttons all called
      // "Archive", which is ambiguous for screen readers and for automation.
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: isDead, busy: loading }}
      className={`flex-row items-center justify-center rounded-xl ${v.box} ${s.box} ${isDead ? 'opacity-50' : ''} ${fullWidth ? 'w-full' : ''} ${className}`}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.spinner} />
      ) : (
        <View className="flex-row items-center">
          {icon ? (
            <Ionicons
              name={icon}
              size={s.icon}
              color={variant === 'secondary' ? '#334155' : variant === 'ghost' ? '#2563EB' : '#fff'}
              style={{ marginRight: title ? 6 : 0 }}
            />
          ) : null}
          {title ? <Text className={`font-semibold ${v.text} ${s.text}`}>{title}</Text> : null}
        </View>
      )}
    </Pressable>
  );
}
