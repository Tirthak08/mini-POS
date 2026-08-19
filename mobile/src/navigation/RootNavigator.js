import { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import AuthScreen from '../screens/AuthScreen';
import PosScreen from '../screens/PosScreen';
import InventoryScreen from '../screens/InventoryScreen';
import SalesScreen from '../screens/SalesScreen';
import ReportsScreen from '../screens/ReportsScreen';
import AdminScreen from '../screens/AdminScreen';
import { useAuthStore } from '../store/authStore';
import { colors } from '../theme';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const ICONS = {
  Pos: ['cart', 'cart-outline'],
  Inventory: ['cube', 'cube-outline'],
  Sales: ['receipt', 'receipt-outline'],
  Reports: ['bar-chart', 'bar-chart-outline'],
};

function MainTabs() {
  const { t } = useTranslation();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.textMuted,
        // Height and padding are left to React Navigation: it already accounts
        // for the bottom safe-area inset, and every override attempted here
        // squeezed the label box instead of growing the bar.
        tabBarStyle: { borderTopColor: colors.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ focused, color, size }) => {
          const [active, inactive] = ICONS[route.name] ?? ICONS.Pos;
          return <Ionicons name={focused ? active : inactive} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Pos" component={PosScreen} options={{ title: t('tabs.pos') }} />
      <Tab.Screen name="Inventory" component={InventoryScreen} options={{ title: t('tabs.inventory') }} />
      <Tab.Screen name="Sales" component={SalesScreen} options={{ title: t('tabs.sales') }} />
      <Tab.Screen name="Reports" component={ReportsScreen} options={{ title: t('tabs.reports') }} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const token = useAuthStore((s) => s.token);
  const role = useAuthStore((s) => s.role);
  const refreshMe = useAuthStore((s) => s.refreshMe);

  // A token restored from storage may have expired while the app was closed;
  // this proves it still works instead of failing on the first POS tap.
  useEffect(() => {
    if (token && role === 'business') refreshMe();
  }, [token, role, refreshMe]);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!token ? (
          <Stack.Screen name="Auth" component={AuthScreen} />
        ) : role === 'admin' ? (
          // PRD section 4: the admin dashboard bypasses the POS UI entirely.
          <Stack.Screen name="Admin" component={AdminScreen} />
        ) : (
          <Stack.Screen name="Main" component={MainTabs} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
