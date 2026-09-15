import { create } from 'zustand';
import { customerApi } from '../api/endpoints';

/**
 * The customer ledger.
 *
 * Deliberately NOT persisted, unlike the catalogue. A cached balance is the one
 * number in this app that must never be shown stale: "Ramesh owes 300" from
 * yesterday, after he paid this morning, is worse than showing nothing at all --
 * it is the figure a shopkeeper would act on in front of the person it is
 * about. The catalogue can be served from disk because a slightly old price is
 * recoverable; a wrong debt is an argument.
 */
export const useCustomerStore = create((set, get) => ({
  customers: [],
  totals: { owed: 0, inCredit: 0, owing: 0 },
  loading: false,
  refreshing: false,
  error: null,
  loadedAt: null,

  load: async ({ silent = false, search = '', owing = false } = {}) => {
    set(silent ? { refreshing: true } : { loading: true, error: null });
    try {
      const params = {};
      if (search) params.search = search;
      if (owing) params.owing = 1;
      const res = await customerApi.list(params);
      set({
        customers: res.customers ?? [],
        totals: res.totals ?? { owed: 0, inCredit: 0, owing: 0 },
        loading: false,
        refreshing: false,
        error: null,
        loadedAt: Date.now(),
      });
      return { ok: true };
    } catch (err) {
      set({ loading: false, refreshing: false, error: err.message });
      return { ok: false, error: err };
    }
  },

  create: async (payload) => {
    try {
      const res = await customerApi.create(payload);
      await get().load({ silent: true });
      return { ok: true, customer: res.customer };
    } catch (err) { return { ok: false, error: err }; }
  },

  update: async (id, patch) => {
    try {
      await customerApi.update(id, patch);
      await get().load({ silent: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  remove: async (id, opts) => {
    try {
      await customerApi.remove(id, opts);
      await get().load({ silent: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err }; }
  },

  clear: () => set({ customers: [], totals: { owed: 0, inCredit: 0, owing: 0 }, loadedAt: null }),
}));

/** Only the people who actually owe, worst first — the daily question. */
export const selectDebtors = (s) =>
  s.customers.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance);
