import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import LanguagePicker from './LanguagePicker';
import { useAuthStore } from '../store/authStore';
import { confirm } from '../store/confirmStore';

/**
 * Standard chrome for every tab: safe-area top inset (notches/status bars, PRD
 * section 6) plus the language switcher and sign-out control.
 *
 * Sign-out lives HERE rather than in each screen -- when it was per-screen it
 * only ever got added to Stock, so there was no way out from POS or Reports.
 */
export default function Screen({
  title, subtitle, right, children,
  showLanguagePicker = true, showLogout = true,
  // React Navigation supplies the bottom inset for the four tab screens, so
  // claiming it here would double it. Screens rendered OUTSIDE the tab
  // navigator (Admin) have no tab bar to sit behind the gesture bar and must
  // ask for it.
  includeBottomInset = false,
}) {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = async () => {
    const ok = await confirm({
      title: t('auth.logout'),
      message: t('auth.logoutConfirm'),
      confirmLabel: t('auth.logout'),
      destructive: true,
    });
    if (ok) logout();
  };

  return (
    <SafeAreaView
      className="flex-1 bg-slate-50"
      edges={includeBottomInset ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']}
    >
      <View className="flex-row items-center border-b border-slate-200 bg-white px-4 pb-3 pt-2">
        <View className="flex-1 pr-2">
          <Text className="text-xl font-bold text-slate-900" numberOfLines={1}>{title}</Text>
          {subtitle ? (
            <Text className="mt-0.5 text-xs text-slate-500" numberOfLines={1}>{subtitle}</Text>
          ) : null}
        </View>

        {right}

        {showLanguagePicker ? <View className="ml-2"><LanguagePicker /></View> : null}

        {showLogout && token ? (
          <Pressable
            onPress={handleLogout}
            hitSlop={8}
            className="ml-1 p-2"
            accessibilityRole="button"
            accessibilityLabel={t('auth.logout')}
          >
            <Ionicons name="log-out-outline" size={20} color="#64748B" />
          </Pressable>
        ) : null}
      </View>
      {children}
    </SafeAreaView>
  );
}
