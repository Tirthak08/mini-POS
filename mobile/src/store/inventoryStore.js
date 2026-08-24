import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { categoryApi, productApi } from '../api/endpoints';
import { useAuthStore } from './authStore';

/**
 * Categories and products are shared by the Stock and POS tabs, so they live in
 * one store: after a checkout, the POS grid and the stock list must agree about
 * how many units are left without either screen refetching.
 *
 * The catalogue is CACHED to disk so a vendor on patchy mobile data can still
 * open the app and see their own prices. Two rules make that safe:
 *
 *   1. The cache records which tenant it belongs to. On a shared phone, signing
 *      in as a different shop must never show the previous shop's products --
 *      so a cache whose ownerBusinessId does not match the signed-in business is
 *      discarded, not displayed. Logging out drops it outright.
 *   2. Cached stock is shown as stale, never as fact. `servingCache` drives a
 *      "last synced" line in the UI, because the number of units on the shelf is
 *      exactly the figure most likely to have moved while offline. Checkout is
 *      still server-authoritative: the backend's atomic stock guard rejects an
 *      oversell with a 409, which the POS already handles.
 */
export const useInventoryStore = create()(
  persist(
    (set, get) => ({
  categories: [],
  products: [],
  loading: false,
  refreshing: false,
  error: null,
  loadedAt: null,
  /** Which tenant the cached rows belong to. Null when there is no cache. */
  ownerBusinessId: null,
  /** True while the screens are showing disk-cached rows, not a live fetch. */
  servingCache: false,

  loadAll: async ({ silent = false } = {}) => {
    // Rule 1 again, for an in-session switch: rehydration only runs at app
    // start, so signing out and into a different shop without killing the app
    // would otherwise render the previous tenant's rows until the fetch landed.
    const signedIn = useAuthStore.getState().business?.businessId ?? null;
    const owner = get().ownerBusinessId;
    if (owner && signedIn && owner !== signedIn) get().clearCache();

    set(silent ? { refreshing: true } : { loading: true, error: null });
    try {
      // Parallel: neither call depends on the other.
      const [cats, prods] = await Promise.all([categoryApi.list(), productApi.list()]);
      set({
        categories: cats.categories ?? [],
        products: prods.products ?? [],
        loading: false,
        refreshing: false,
        error: null,
        loadedAt: Date.now(),
        ownerBusinessId: useAuthStore.getState().business?.businessId ?? null,
        servingCache: false,
      });
      return { ok: true };
    } catch (err) {
      // A network failure with a usable cache is not an empty screen: keep the
      // rows, say they are stale. Any other failure (or no cache) surfaces
      // normally so nothing is hidden.
      const hasCache = get().products.length > 0 || get().categories.length > 0;
      set({
        loading: false,
        refreshing: false,
        error: err.message,
        servingCache: hasCache && err.isNetwork === true,
      });
      return { ok: false, error: err };
    }
  },

  /**
   * Drops the cache. Called on sign-out and whenever the signed-in tenant does
   * not own the cached rows.
   */
  clearCache: () => set({
    categories: [], products: [], loadedAt: null,
    ownerBusinessId: null, servingCache: false, error: null,
  }),

  /* ---------------- categories ---------------- */

  createCategory: async (name, color) => {
    try {
      await categoryApi.create(name, color);
      await get().loadAll({ silent: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  updateCategory: async (id, patch) => {
    try {
      await categoryApi.update(id, patch);
      await get().loadAll({ silent: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  /** force=true also deletes the products inside it (backend refuses otherwise). */
  deleteCategory: async (id, { force = false } = {}) => {
    try {
      const res = await categoryApi.remove(id, { force });
      await get().loadAll({ silent: true });
      return { ok: true, deleted: res.deleted };
    } catch (err) { return { ok: false, error: err }; }
  },

  /* ---------------- products ---------------- */

  createProduct: async (payload) => {
    try {
      await productApi.create(payload);
      await get().loadAll({ silent: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  updateProduct: async (id, patch) => {
    try {
      await productApi.update(id, patch);
      await get().loadAll({ silent: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  deleteProduct: async (id) => {
    try {
      await productApi.remove(id);
      set({ products: get().products.filter((p) => p._id !== id) });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  adjustStock: async (id, body) => {
    try {
      const res = await productApi.adjustStock(id, body);
      // Patch just this row rather than refetching the whole catalogue.
      set({
        products: get().products.map((p) =>
          p._id === id ? { ...p, stock: res.product.stock } : p
        ),
      });
      return { ok: true, product: res.product };
    } catch (err) { return { ok: false, error: err }; }
  },

  /**
   * Applies the stock the server just deducted at checkout, so the POS grid
   * updates instantly without a round trip.
   */
  applySoldItems: (items = []) => {
    const sold = new Map(items.map((i) => [String(i.productId), i.qty]));
    set({
      products: get().products.map((p) =>
        sold.has(String(p._id)) ? { ...p, stock: Math.max(0, p.stock - sold.get(String(p._id))) } : p
      ),
    });
  },
    }),
    {
      name: 'minipos-catalogue',
      storage: createJSONStorage(() => AsyncStorage),
      // Only the rows and their provenance. Persisting loading/refreshing/error
      // would restore the app into a spinner or a stale error banner.
      partialize: (s) => ({
        categories: s.categories,
        products: s.products,
        loadedAt: s.loadedAt,
        ownerBusinessId: s.ownerBusinessId,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Rule 1, applied the moment the cache comes back off disk: a cache
        // belonging to another shop is dropped before any screen can render it.
        const signedIn = useAuthStore.getState().business?.businessId ?? null;
        if (state.ownerBusinessId && state.ownerBusinessId !== signedIn) {
          state.clearCache();
          return;
        }
        // Rows restored from disk are stale until loadAll proves otherwise.
        if (state.products.length || state.categories.length) {
          useInventoryStore.setState({ servingCache: true });
        }
      },
    }
  )
);

export const selectCategoryMap = (s) =>
  new Map(s.categories.map((c) => [String(c._id), c]));
