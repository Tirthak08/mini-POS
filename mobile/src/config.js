import Constants from 'expo-constants';

/** Backend port from backend/.env */
const API_PORT = 5000;

/**
 * A phone cannot reach "localhost" -- that would be the phone itself.
 * In development, Expo already knows the LAN IP of the machine running Metro
 * (it is in the QR code), so we reuse it instead of asking you to hard-code an
 * IP that changes every time your router hands out a new lease.
 */
function inferLanApiUrl() {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.expoGoConfig?.debuggerHost ||
    Constants.manifest2?.extra?.expoGo?.debuggerHost ||
    '';
  const host = String(hostUri).split(':')[0];
  return host ? `http://${host}:${API_PORT}/api` : null;
}

/**
 * Override order:
 *   1. EXPO_PUBLIC_API_URL in mobile/.env  (use this for a deployed backend)
 *   2. The LAN IP Expo is already serving from  (normal development)
 *   3. localhost  (web/simulator only)
 */
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || inferLanApiUrl() || `http://localhost:${API_PORT}/api`;

export const APP_CONFIG = {
  currencySymbol: '₹',
  lowStockThreshold: 5,
  defaultCustomerName: 'Walk-in',
  requestTimeoutMs: 15000,
};
