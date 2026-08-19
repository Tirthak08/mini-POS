import { create } from 'zustand';

/**
 * Promise-based confirmation, replacing React Native's `Alert`.
 *
 * Why not Alert: `Alert.alert` is a no-op on react-native-web, so every
 * destructive action silently did nothing there -- a delete looked like it had
 * been cancelled while the record survived. It is also untestable and its
 * buttons cannot be styled or laid out consistently across platforms.
 *
 *   if (await confirm({ title: 'Delete this?', destructive: true })) { ... }
 *   const qty = await promptNumber({ title: 'Add stock', label: 'How many?' });
 */
export const useConfirmStore = create((set, get) => ({
  request: null,

  /** Resolves true when confirmed, false when cancelled or dismissed. */
  confirm: (options) =>
    new Promise((resolve) => {
      set({ request: { kind: 'confirm', ...options, resolve } });
    }),

  /** Resolves a positive number, or null when cancelled / left blank. */
  promptNumber: (options) =>
    new Promise((resolve) => {
      set({ request: { kind: 'number', ...options, resolve } });
    }),

  respond: (value) => {
    const { request } = get();
    set({ request: null });
    request?.resolve(value);
  },
}));

export const confirm = (options) => useConfirmStore.getState().confirm(options);
export const promptNumber = (options) => useConfirmStore.getState().promptNumber(options);
