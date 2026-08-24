import { ScrollView, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';

import Screen from '../components/Screen';
import SettingsRow, { SettingsGroup } from '../components/SettingsRow';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore, LANGUAGES } from '../store/settingsStore';
import { confirm } from '../store/confirmStore';
import { formatDate } from '../utils/money';

/**
 * The one place that is not about selling.
 *
 * Everything here was previously either crammed into the header (the language
 * picker, sign-out) or simply unreachable from the app at all (the shop's name
 * and its PIN could only be changed by calling the API directly). Collecting
 * them costs one tap from any tab and gives each one room to explain itself.
 *
 * Rows lead to their own screens rather than expanding inline. Changing a PIN
 * needs three fields and a validation message; a language needs a list of three
 * with the current one marked. Both are jobs with a beginning and an end, and a
 * screen you leave when you are done says that more clearly than an accordion.
 */
export default function SettingsScreen({ navigation }) {
  const { t } = useTranslation();
  const business = useAuthStore((s) => s.business);
  const counts = useAuthStore((s) => s.counts);
  const logout = useAuthStore((s) => s.logout);
  const language = useSettingsStore((s) => s.language);

  const languageLabel = LANGUAGES.find((l) => l.code === language)?.label ?? language;

  const handleLogout = async () => {
    const ok = await confirm({
      title: t('auth.logout'),
      message: t('auth.logoutConfirm'),
      confirmLabel: t('auth.logout'),
      destructive: true,
    });
    // No navigation.goBack() afterwards: dropping the token swaps the whole
    // stack for the sign-in screen, so this screen unmounts under its own feet.
    if (ok) logout();
  };

  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen
      title={t('settings.title')}
      onBack={() => navigation.goBack()}
      showSettings={false}
      showLogout={false}
      includeBottomInset
    >
      <ScrollView contentContainerStyle={{ paddingTop: 16, paddingBottom: 32 }}>
        {/* The shop's own identity card. It repeats the name that is now in the
            header on purpose -- this is the screen where you come to change it,
            and a settings screen that does not show what it is about feels
            like the wrong screen. */}
        <View className="mx-4 mb-5 flex-row items-center rounded-2xl border border-slate-200 bg-white p-4">
          <View className="mr-3 h-12 w-12 items-center justify-center rounded-2xl bg-blue-600">
            <Text className="text-lg font-bold text-white">
              {(business?.name ?? '?').trim().charAt(0).toUpperCase()}
            </Text>
          </View>
          <View className="flex-1">
            <Text className="text-base font-bold text-slate-900" numberOfLines={1}>
              {business?.name}
            </Text>
            <Text className="mt-0.5 text-xs text-slate-500">
              {/* Interpolated, not concatenated: Hindi and Gujarati put the
                  postposition AFTER the date ("12 Aug 2026 से"), so the date
                  cannot be glued onto the end of a translated prefix. */}
              {business?.createdAt
                ? t('settings.since', { date: formatDate(business.createdAt) })
                : t('settings.subtitle')}
            </Text>
          </View>
        </View>

        <SettingsGroup title={t('settings.accountGroup')} className="mb-5">
          {/* No trailing values on these two. The shop name is already on the
              card above and in the header chip, and a "PIN" value next to
              "Security & login" reads as though the PIN itself were the word
              PIN. The chevron is enough to say the row leads somewhere. */}
          <SettingsRow
            icon="storefront-outline"
            label={t('settings.business')}
            onPress={() => navigation.navigate('BusinessInfo')}
          />
          <SettingsRow
            icon="shield-checkmark-outline"
            label={t('settings.security')}
            onPress={() => navigation.navigate('Security')}
            last
          />
        </SettingsGroup>

        <SettingsGroup title={t('settings.appGroup')} className="mb-5">
          <SettingsRow
            icon="language-outline"
            label={t('settings.language')}
            value={languageLabel}
            onPress={() => navigation.navigate('Language')}
            last
          />
        </SettingsGroup>

        <SettingsGroup title={t('settings.aboutGroup')} className="mb-5">
          {/* Not a link: these are the numbers a shopkeeper quotes when
              something has gone wrong, so they are shown, not hidden. */}
          <SettingsRow icon="cube-outline" label={t('settings.products')} value={String(counts?.products ?? 0)} />
          <SettingsRow icon="receipt-outline" label={t('settings.orders')} value={String(counts?.orders ?? 0)} />
          <SettingsRow icon="information-circle-outline" label={t('settings.version')} value={version} last />
        </SettingsGroup>

        <SettingsGroup className="mb-4">
          <SettingsRow
            icon="log-out-outline"
            label={t('auth.logout')}
            tone="danger"
            onPress={handleLogout}
            last
          />
        </SettingsGroup>

        <Text className="px-6 text-center text-xs text-slate-400">{t('settings.footer')}</Text>
      </ScrollView>
    </Screen>
  );
}
