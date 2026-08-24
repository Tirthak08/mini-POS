import { Image, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useAuthStore } from '../store/authStore';
import { confirm } from '../store/confirmStore';
import { brandGradient } from '../theme';

const LOGO_MARK = require('../../assets/logo-mark.png');

/**
 * Standard chrome for every tab: the brand header, plus the one control that
 * leads everywhere else.
 *
 * The header is a navy -> teal gradient that runs up THROUGH the status-bar
 * inset rather than stopping below it. A SafeAreaView with a white background
 * would draw a pale strip above the colour, which reads as a rendering fault on
 * a notched phone; owning the inset makes the header one continuous surface.
 * That is also why the inset is applied as padding here rather than through
 * SafeAreaView's `edges`.
 *
 * The gradient's end stop is `tealDeep`, not the logo's `teal`: white text on
 * the real swoosh teal is 2.57:1, which is unreadable. Deepened, it clears AA.
 *
 * WHAT SITS ON THE RIGHT, AND WHY IT CHANGED
 * -----------------------------------------
 * It used to be a three-way EN/HI/GU segmented control plus a sign-out icon.
 * Two problems with that. The language is chosen once, on the day the shop
 * starts using the app, and then never again -- so the most permanent control
 * in the product occupied the most valuable space on every screen. And the shop
 * name could only be squeezed in as a subtitle under the screen title, where it
 * competed with the title for the same line width and truncated first in
 * Gujarati.
 *
 * Now the shop's own name is the button, and it opens Settings, where the
 * language lives alongside the account and PIN. The name is the label a
 * shopkeeper recognises instantly, which makes it a better affordance than a
 * gear alone -- and the gear beside it says the tap does something.
 *
 * Sign-out moved into Settings with everything else it belongs with. It stays
 * in the header for the SUPER ADMIN, who has no Settings screen and would
 * otherwise be stranded.
 */
export default function Screen({
  title, subtitle, right, children,
  showSettings = true, showLogout = true,
  showLogo = true,
  // React Navigation supplies the bottom inset for the four tab screens, so
  // claiming it here would double it. Screens rendered OUTSIDE the tab
  // navigator (Admin, Settings) have no tab bar to sit behind the gesture bar
  // and must ask for it.
  includeBottomInset = false,
  // Sub-screens of Settings get a back arrow where the logo tile would be.
  onBack,
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const token = useAuthStore((s) => s.token);
  const role = useAuthStore((s) => s.role);
  const business = useAuthStore((s) => s.business);
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

  // Only a shop has a Settings screen; the admin stack does not contain one, so
  // offering the chip there would navigate to a route that does not exist.
  const canOpenSettings = showSettings && role === 'business' && Boolean(business?.name);

  return (
    <View
      className="flex-1 bg-slate-50"
      style={{ paddingBottom: includeBottomInset ? insets.bottom : 0 }}
    >
      <LinearGradient
        colors={brandGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ paddingTop: insets.top }}
      >
        <View className="flex-row items-center px-4 pb-3.5 pt-2">
          {onBack ? (
            <Pressable
              onPress={onBack}
              hitSlop={10}
              className="-ml-1.5 mr-1.5 p-1.5"
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
            >
              <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
            </Pressable>
          ) : showLogo ? (
            /* The mark on a white tile -- the way the logo presents itself --
               so its navy and teal stay legible instead of muddying into the
               gradient behind them. */
            <View className="mr-2.5 h-9 w-9 items-center justify-center rounded-xl bg-white">
              <Image
                source={LOGO_MARK}
                style={{ width: 26, height: 24 }}
                resizeMode="contain"
                accessible={false}
              />
            </View>
          ) : null}

          <View className="flex-1 pr-2">
            <Text className="text-xl font-bold text-white" numberOfLines={1}>{title}</Text>
            {subtitle ? (
              <Text className="mt-0.5 text-xs text-white/75" numberOfLines={1}>{subtitle}</Text>
            ) : null}
          </View>

          {right}

          {canOpenSettings ? (
            /* maxWidth rather than flex: a long shop name must give way to the
               screen title, not the other way round -- the title is what tells
               the operator where they are. */
            <Pressable
              onPress={() => navigation.navigate('Settings')}
              className="ml-1 flex-row items-center rounded-full bg-white/15 py-1.5 pl-3 pr-2 active:bg-white/25"
              accessibilityRole="button"
              accessibilityLabel={`${t('settings.title')} — ${business.name}`}
            >
              <Text
                className="text-xs font-bold text-white"
                numberOfLines={1}
                style={{ maxWidth: 104 }}
              >
                {business.name}
              </Text>
              <Ionicons name="settings-outline" size={15} color="#FFFFFF" style={{ marginLeft: 5 }} />
            </Pressable>
          ) : null}

          {!canOpenSettings && showLogout && token ? (
            <Pressable
              onPress={handleLogout}
              hitSlop={8}
              className="ml-1 p-2"
              accessibilityRole="button"
              accessibilityLabel={t('auth.logout')}
            >
              <Ionicons name="log-out-outline" size={20} color="#FFFFFF" />
            </Pressable>
          ) : null}
        </View>
      </LinearGradient>

      {children}
    </View>
  );
}
