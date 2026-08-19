import './global.css';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import './src/i18n';
import RootNavigator from './src/navigation/RootNavigator';
import Toast from './src/components/Toast';
import ConfirmDialog from './src/components/ConfirmDialog';
import { wakeServer } from './src/api/client';

export default function App() {
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

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <RootNavigator />
      <ConfirmDialog />
      <Toast />
    </SafeAreaProvider>
  );
}
