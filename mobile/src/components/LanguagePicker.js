import { Pressable, Text, View } from 'react-native';
import { useSettingsStore, LANGUAGES } from '../store/settingsStore';
import { setAppLanguage } from '../i18n';

/**
 * A three-way segmented control rather than a dropdown: it is always visible,
 * needs one tap, and works for an operator who cannot read the current label.
 */
/**
 * @param onDark  the picker now sits on the brand gradient in the header, where
 *                slate borders vanish and the inactive white pills glare. On
 *                dark it switches to a translucent-white treatment instead.
 */
export default function LanguagePicker({ onDark = false }) {
  const language = useSettingsStore((s) => s.language);

  return (
    <View
      className={`flex-row overflow-hidden rounded-lg border ${
        onDark ? 'border-white/40' : 'border-slate-300'
      }`}
    >
      {LANGUAGES.map((lang, index) => {
        const active = lang.code === language;
        return (
          <Pressable
            key={lang.code}
            onPress={() => setAppLanguage(lang.code)}
            accessibilityRole="button"
            accessibilityLabel={lang.label}
            accessibilityState={{ selected: active }}
            className={`px-2.5 py-1.5 ${
              onDark
                ? active ? 'bg-white' : 'bg-white/10'
                : active ? 'bg-blue-600' : 'bg-white'
            } ${index > 0 ? (onDark ? 'border-l border-white/40' : 'border-l border-slate-300') : ''}`}
          >
            <Text
              className={`text-xs font-bold ${
                onDark
                  ? active ? 'text-blue-700' : 'text-white'
                  : active ? 'text-white' : 'text-slate-500'
              }`}
            >
              {lang.short}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
