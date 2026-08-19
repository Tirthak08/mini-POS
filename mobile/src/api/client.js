import axios from 'axios';
import i18n from '../i18n';
import { API_BASE_URL, APP_CONFIG, IS_REMOTE_API } from '../config';

/**
 * The token lives in the auth store, but importing the store here would create
 * a cycle (store -> api -> store). Instead the store registers a getter once,
 * at startup.
 */
let getToken = () => null;
let handleUnauthorized = () => {};
let handleServerWaking = () => {};

export function configureApi({ tokenGetter, onUnauthorized, onServerWaking }) {
  if (tokenGetter) getToken = tokenGetter;
  if (onUnauthorized) handleUnauthorized = onUnauthorized;
  if (onServerWaking) handleServerWaking = onServerWaking;
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: APP_CONFIG.requestTimeoutMs,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Every failure the UI sees is one of these, so screens never touch axios internals. */
export class ApiError extends Error {
  constructor({ message, status, details, isNetwork = false }) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.details = details;
    this.isNetwork = isNetwork;
  }
  /** First field-level message, for showing under an input. */
  get firstDetail() {
    if (!this.details || typeof this.details !== 'object') return null;
    const [key, value] = Object.entries(this.details)[0] ?? [];
    return key ? `${key}: ${value}` : null;
  }
}

/**
 * Wakes a sleeping host without touching a real endpoint.
 *
 * /api/health needs no auth and writes nothing, so it is safe to fire on app
 * start and whenever the app comes back to the foreground. By the time the
 * operator taps "Complete order", the instance is already up -- which matters
 * because a checkout must NOT be retried automatically (see below).
 */
export function wakeServer() {
  return api
    .get('/health', { timeout: APP_CONFIG.coldStartTimeoutMs, __noRetry: true })
    .then(() => true)
    .catch(() => false);
}

const networkMessage = (timedOut) => {
  if (timedOut) return i18n.t('errors.serverSlow');
  // The dev message names npm and Wi-Fi because on the LAN those really are the
  // likely causes. Against a deployed API neither is, so it would just mislead.
  return IS_REMOTE_API
    ? i18n.t('errors.networkRemote')
    : `Cannot reach the server at ${API_BASE_URL}. Check that "npm run dev" is running and that your phone is on the same Wi-Fi.`;
};

api.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    // No response at all: server down, asleep, or the phone lost its data.
    if (!error.response) {
      const config = error.config || {};
      const method = String(config.method || 'get').toLowerCase();

      /**
       * Retry reads once, with the cold-start window. Deliberately GET only:
       * a timed-out POST may well have reached the server and been applied --
       * the reply is what got lost -- so retrying a checkout could charge the
       * customer twice and take stock twice. Reads have no such hazard.
       */
      const mayRetry = method === 'get' && !config.__noRetry && !config.__retried;
      if (mayRetry) {
        handleServerWaking();
        try {
          return await api.request({
            ...config,
            __retried: true,
            timeout: APP_CONFIG.coldStartTimeoutMs,
          });
        } catch {
          // fall through and report the original failure
        }
      }

      return Promise.reject(
        new ApiError({
          isNetwork: true,
          status: 0,
          message: networkMessage(error.code === 'ECONNABORTED'),
        })
      );
    }

    const { status, data } = error.response;

    // Token expired or revoked -- let the app drop back to the login screen.
    if (status === 401) handleUnauthorized();

    return Promise.reject(
      new ApiError({
        status,
        message: data?.error || `Request failed (${status})`,
        details: data?.details,
      })
    );
  }
);

export { API_BASE_URL };
