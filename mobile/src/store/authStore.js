import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authApi } from '../api/endpoints';
import { configureApi } from '../api/client';

/**
 * Holds the JWT. The token is the only thing that identifies a tenant to the
 * backend -- there is no businessId anywhere in a request body -- so signing
 * out is genuinely just discarding it.
 */
export const useAuthStore = create()(
  persist(
    (set, get) => ({
      token: null,
      role: null, // 'business' | 'admin'
      business: null, // { businessId, name, createdAt }
      adminUsername: null,
      counts: null,
      loading: false,
      error: null,

      clearError: () => set({ error: null }),

      /**
       * One call for both account types. The server decides whether these
       * credentials belong to a shop or the super admin, so the login screen
       * never has to ask the user to classify themselves first.
       */
      signIn: async (identifier, secret) => {
        set({ loading: true, error: null });
        try {
          const res = await authApi.signIn(identifier, secret);
          if (res.role === 'admin') {
            set({ token: res.token, adminUsername: res.admin.username, role: 'admin', business: null, loading: false });
          } else {
            set({ token: res.token, business: res.business, role: 'business', adminUsername: null, loading: false });
          }
          return { ok: true, role: res.role };
        } catch (err) {
          set({ loading: false, error: err.message });
          return { ok: false, error: err };
        }
      },

      register: async (businessName, pin) => {
        set({ loading: true, error: null });
        try {
          const res = await authApi.register(businessName, pin);
          set({ token: res.token, business: res.business, role: 'business', loading: false });
          return { ok: true };
        } catch (err) {
          set({ loading: false, error: err.message });
          return { ok: false, error: err };
        }
      },

      login: async (businessName, pin) => {
        set({ loading: true, error: null });
        try {
          const res = await authApi.login(businessName, pin);
          set({ token: res.token, business: res.business, role: 'business', loading: false });
          return { ok: true };
        } catch (err) {
          set({ loading: false, error: err.message });
          return { ok: false, error: err };
        }
      },

      adminLogin: async (username, password) => {
        set({ loading: true, error: null });
        try {
          const res = await authApi.adminLogin(username, password);
          set({ token: res.token, adminUsername: res.admin.username, role: 'admin', loading: false });
          return { ok: true };
        } catch (err) {
          set({ loading: false, error: err.message });
          return { ok: false, error: err };
        }
      },

      /** Confirms a restored token is still valid, and refreshes the counts. */
      refreshMe: async () => {
        if (get().role !== 'business' || !get().token) return;
        try {
          const res = await authApi.me();
          set({ business: res.business, counts: res.counts });
        } catch (err) {
          // A 401 already triggered logout via the interceptor.
          if (err.status !== 401) set({ error: err.message });
        }
      },

      /**
       * Signing out must also drop the cached catalogue. Without this, the next
       * person to sign in on the same phone would see the previous shop's
       * products before their own first fetch landed -- a tenant leak that the
       * API could not prevent, because it never sees a read of local cache.
       *
       * Imported lazily to avoid an import cycle: the catalogue store reads
       * this one to stamp cache ownership.
       */
      logout: () => {
        set({ token: null, role: null, business: null, adminUsername: null, counts: null, error: null });
        import('./inventoryStore').then((m) => m.useInventoryStore.getState().clearCache());
      },
    }),
    {
      name: 'minipos-auth',
      storage: createJSONStorage(() => AsyncStorage),
      // Never persist transient UI state -- a crash mid-request would restore
      // the app stuck in a loading state.
      partialize: (s) => ({
        token: s.token,
        role: s.role,
        business: s.business,
        adminUsername: s.adminUsername,
      }),
    }
  )
);

/** Wire the api layer to this store exactly once, at import time. */
configureApi({
  tokenGetter: () => useAuthStore.getState().token,
  onUnauthorized: () => {
    // Only bounce to login if we thought we were signed in.
    if (useAuthStore.getState().token) {
      useAuthStore.setState({
        token: null, role: null, business: null, adminUsername: null, counts: null,
        error: 'Your session expired. Please sign in again.',
      });
      // An expired session is a sign-out by another name -- the cached
      // catalogue has to go with it, or whoever signs in next inherits it.
      import('./inventoryStore').then((m) => m.useInventoryStore.getState().clearCache());
    }
  },
});

export const selectIsSignedIn = (s) => Boolean(s.token);
export const selectIsAdmin = (s) => s.role === 'admin';
