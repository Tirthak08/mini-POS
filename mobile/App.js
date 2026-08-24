import './global.css';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import './src/i18n';
import RootNavigator from './src/navigation/RootNavigator';
import Toast from './src/components/Toast';
import ConfirmDialog from './src/components/ConfirmDialog';
import { wakeServer } from './src/api/client';
import { useAppReady } from './src/hooks/useAppReady';

/**
 * Keep the splash up past the first frame.
 *
 * By default Expo hides it the moment anything renders -- which here is the
 * moment the app is at its least ready: the persisted session has not come back
 * off disk yet, so the navigator briefly shows the SIGN-IN screen to a
 * shopkeeper who is already signed in. Holding the splash until `useAppReady`
 * turns true means the logo covers that window instead.
 *
 * Called at module scope so it takes effect before the first render. The catch
 * matters: on web this is a no-op that can reject, and a failure here must
 * never stop the app from starting.
 */
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const ready = useAppReady();

  /**
   * Nudge the backend awake as early as possible.
   *
   * A free-tier host stops its instance after ~15 minutes idle and needs about
   * 50 seconds to come back. Without this, the first real action of the day --
   * signing in, or worse, a checkout with a customer waiting -- is the request
   * that absorbs that delay and fails.
   *
   * /api/health needs no auth and writes nothing, so it is safe to fire before
   * anyone has signed in, and again whenever the app returns to the foreground
   * (the shop closing the app over lunch is exactly how the host falls asleep).
   * Fire-and-forget: it never blocks the UI and never raises an error of its own.
   */
  useEffect(() => {
    wakeServer();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') wakeServer();
    });
    return () => sub.remove();
  }, []);

  /**
   * Hide from an effect, not inline: effects run after the commit, so the real
   * screen is already painted underneath before the splash lifts. Hiding during
   * render would uncover a blank frame first.
   */
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Splash is still covering the screen, so render nothing rather than the
  // wrong thing.
  if (!ready) return null;

  return (
    <SafeAreaProvider>
      {/* The header is a dark brand gradient on every screen, so status-bar
          glyphs must be light to stay visible. */}
      <StatusBar style="light" />
      <RootNavigator />
      <ConfirmDialog />
      <Toast />
    </SafeAreaProvider>
  );
}
