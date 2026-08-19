import axios from 'axios';
import { API_BASE_URL, APP_CONFIG } from '../config';

/**
 * The token lives in the auth store, but importing the store here would create
 * a cycle (store -> api -> store). Instead the store registers a getter once,
 * at startup.
 */
let getToken = () => null;
let handleUnauthorized = () => {};

export function configureApi({ tokenGetter, onUnauthorized }) {
  if (tokenGetter) getToken = tokenGetter;
  if (onUnauthorized) handleUnauthorized = onUnauthorized;
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

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    // No response at all: server down, wrong IP, phone on a different network.
    if (!error.response) {
      const timedOut = error.code === 'ECONNABORTED';
      return Promise.reject(
        new ApiError({
          isNetwork: true,
          status: 0,
          message: timedOut
            ? 'The server took too long to answer. Is the backend still running?'
            : `Cannot reach the server at ${API_BASE_URL}. Check that "npm run dev" is running and that your phone is on the same Wi-Fi.`,
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
