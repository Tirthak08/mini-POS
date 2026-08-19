import { Pressable, Text, View } from 'react-native';
import { useSettingsStore, LANGUAGES } from '../store/settingsStore';
import { setAppLanguage } from '../i18n';

/**
 * A three-way segmented control rather than a dropdown: it is always visible,
 * needs one tap, and works for an operator who cannot read the current label.
 */
export default function LanguagePicker() {
  const language = useSettingsStore((s) => s.language);

  return (
    <View className="flex-row overflow-hidden rounded-lg border border-slate-300">
      {LANGUAGES.map((lang, index) => {
        const active = lang.code === language;
        return (
          <Pressable
            key={lang.code}
            onPress={() => setAppLanguage(lang.code)}
            accessibilityRole="button"
            accessibilityLabel={lang.label}
            accessibilityState={{ selected: active }}
            className={`px-2.5 py-1.5 ${active ? 'bg-blue-600' : 'bg-white'} ${index > 0 ? 'border-l border-slate-300' : ''}`}
          >
            <Text className={`text-xs font-bold ${active ? 'text-white' : 'text-slate-500'}`}>
              {lang.short}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
