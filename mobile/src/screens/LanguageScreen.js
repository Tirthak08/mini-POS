import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import { useSettingsStore, LANGUAGES } from '../store/settingsStore';
import { setAppLanguage } from '../i18n';
import { colors } from '../theme';

/**
 * A radio list, not a segmented control.
 *
 * The header used to hold a three-way EN/HI/GU control, which had to abbreviate
 * every language to two Latin letters -- so the one operator who most needs the
 * switch, the one who cannot read Latin script, could not identify their own
 * language in it. Here each row is written IN that language, at full size.
 *
 * The change applies on tap with no Save button. It is instantly visible and
 * instantly reversible, which is exactly the case where confirmation is friction
 * rather than safety.
 */
export default function LanguageScreen({ navigation }) {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);

  return (
    <Screen
      title={t('settings.language')}
      onBack={() => navigation.goBack()}
      showSettings={false}
      showLogout={false}
      includeBottomInset
    >
      <ScrollView contentContainerStyle={{ paddingTop: 16, paddingBottom: 32 }}>
        <View className="mx-4 overflow-hidden rounded-2xl border border-slate-200">
          {LANGUAGES.map((lang, i) => {
            const active = lang.code === language;
            return (
              <Pressable
                key={lang.code}
                onPress={() => setAppLanguage(lang.code)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={lang.label}
                className={`flex-row items-center bg-white px-4 py-4 active:bg-slate-50 ${
                  i < LANGUAGES.length - 1 ? 'border-b border-slate-100' : ''
                }`}
              >
                <View className="flex-1">
                  <Text className={`text-base ${active ? 'font-bold text-blue-700' : 'font-semibold text-slate-800'}`}>
                    {lang.label}
                  </Text>
                  <Text className="mt-0.5 text-xs text-slate-400">{lang.short}</Text>
                </View>
                {active ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.brand} />
                ) : (
                  <View className="h-[22px] w-[22px] rounded-full border-2 border-slate-300" />
                )}
              </Pressable>
            );
          })}
        </View>

        <Text className="mt-3 px-6 text-xs text-slate-400">{t('settings.languageHint')}</Text>
      </ScrollView>
    </Screen>
  );
}
