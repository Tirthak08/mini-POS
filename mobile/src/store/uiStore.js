import { create } from 'zustand';

/** Lightweight toast queue -- avoids a modal Alert for non-blocking feedback. */
export const useUiStore = create((set, get) => ({
  toast: null, // { message, type: 'success' | 'error' | 'info' }
  _timer: null,

  showToast: (message, type = 'info', duration = 2600) => {
    const existing = get()._timer;
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => set({ toast: null, _timer: null }), duration);
    set({ toast: { message, type }, _timer: timer });
  },

  hideToast: () => {
    const existing = get()._timer;
    if (existing) clearTimeout(existing);
    set({ toast: null, _timer: null });
  },
}));

export const toast = {
  success: (m) => useUiStore.getState().showToast(m, 'success'),
  error: (m) => useUiStore.getState().showToast(m, 'error'),
  info: (m) => useUiStore.getState().showToast(m, 'info'),
};
