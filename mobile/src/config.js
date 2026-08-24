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

/**
 * True when we are talking to a deployed backend rather than a dev machine on
 * the LAN. It decides which failure message the operator sees: telling a
 * shopkeeper to "check that npm run dev is running and your phone is on the
 * same Wi-Fi" is nonsense when the API lives on the public internet.
 */
export const IS_REMOTE_API = /^https:\/\//i.test(API_BASE_URL);

export const APP_CONFIG = {
  currencySymbol: '₹',
  lowStockThreshold: 5,
  defaultCustomerName: 'Walk-in',
  requestTimeoutMs: 20000,
  /**
   * Render's free tier stops the instance after 15 minutes idle and takes
   * roughly 50 seconds to boot again. A 20-second timeout means the FIRST
   * request of every morning would always fail, so a wake-up ping and any
   * retried read get this much longer window instead.
   */
  coldStartTimeoutMs: 70000,
};
