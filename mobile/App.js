import './global.css';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import './src/i18n';
import RootNavigator from './src/navigation/RootNavigator';
import Toast from './src/components/Toast';
import ConfirmDialog from './src/components/ConfirmDialog';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <RootNavigator />
      <ConfirmDialog />
      <Toast />
    </SafeAreaProvider>
  );
}
