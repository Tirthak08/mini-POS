import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { orderApi } from '../api/endpoints';
import { useAuthStore } from './authStore';
import {
  makeEntry, dueEntries, afterAttempt, pendingCount, failedCount, queuedValue, QUEUE_LIMIT,
} from '../utils/salesQueue';

/**
 * Sales rung up while the phone could not reach the server.
 *
 * This is the difference between a till and a toy. A shop with a customer at
 * the counter and no signal still has to complete the sale; an app that refuses
 * is one the shopkeeper stops using that afternoon. On top of ordinary patchy
 * data, the backend sleeps after fifteen minutes idle and takes the better part
 * of a minute to wake -- so the FIRST sale of every morning is the one most
 * likely to need this.
 *
 * Persisted to disk, because the whole point is surviving the thing that made
 * the sale fail: a dead network, a killed app, a flat battery.
 *
 * Tagged with the tenant that owns it, like the catalogue cache. A queued sale
 * belonging to another shop must never be replayed into this one -- it would
 * post a stranger's receipt into the accounts.
 */
export const useQueueStore = create()(
  persist(
    (set, get) => ({
      entries: [],
      syncing: false,
      lastSyncAt: null,
      ownerBusinessId: null,

      /** Called when checkout could not reach the server. Returns the entry. */
      enqueue: (payload, { total = 0 } = {}) => {
        const entries = get().entries;
        if (entries.length >= QUEUE_LIMIT) {
          return { ok: false, reason: 'full' };
        }
        const entry = makeEntry(payload, { total });
        set({
          entries: [...entries, entry],
          ownerBusinessId: get().ownerBusinessId
            ?? useAuthStore.getState().business?.businessId
            ?? null,
        });
        return { ok: true, entry };
      },

      remove: (id) => set({ entries: get().entries.filter((e) => e.id !== id) }),

      /** Puts a stopped sale back in the queue — after the stock was restocked, say. */
      retry: (id) => set({
        entries: get().entries.map((e) =>
          (e.id === id ? { ...e, status: 'pending', error: null } : e)),
      }),

      clearFailed: () => set({ entries: get().entries.filter((e) => e.status !== 'failed') }),

      reset: () => set({ entries: [], ownerBusinessId: null, lastSyncAt: null }),

      ensureOwner: () => {
        const signedIn = useAuthStore.getState().business?.businessId ?? null;
        const owner = get().ownerBusinessId;
        if (owner && signedIn && owner !== signedIn) get().reset();
      },

      /**
       * Replays what is waiting, oldest first.
       *
       * Sequentially, not in parallel: these are stock-consuming writes, and
       * firing twenty at once at a server that has just woken up is the fastest
       * way to have half of them fail for reasons that have nothing to do with
       * the sales themselves.
       *
       * Stops at the first network failure. If the connection is still down,
       * the second attempt will fail for the same reason as the first, and
       * walking the whole queue to learn that wastes the operator's battery and
       * fills the log with noise.
       */
      sync: async () => {
        if (get().syncing) return { ok: false, reason: 'busy' };
        get().ensureOwner();

        const due = dueEntries(get().entries);
        if (!due.length) return { ok: true, synced: 0, failed: 0 };

        set({ syncing: true });
        let synced = 0;
        let failed = 0;
        let stoppedEarly = false;

        try {
          for (const entry of due) {
            let result;
            try {
              await orderApi.checkout(entry.payload);
              result = afterAttempt(entry, { ok: true });
              synced += 1;
            } catch (err) {
              result = afterAttempt(entry, { ok: false, err });
              if (result && result.status === 'failed') failed += 1;
              // Same entry back unchanged means "not the queue's problem".
              if (result === entry) { stoppedEarly = true; }
              else if (result.status === 'pending') { stoppedEarly = true; }
            }

            set({
              entries: result === null
                ? get().entries.filter((e) => e.id !== entry.id)
                : get().entries.map((e) => (e.id === entry.id ? result : e)),
            });

            if (stoppedEarly) break;
          }
        } finally {
          set({ syncing: false, lastSyncAt: Date.now() });
        }

        return { ok: true, synced, failed, remaining: pendingCount(get().entries) };
      },
    }),
    {
      name: 'vyapaar-sales-queue',
      storage: createJSONStorage(() => AsyncStorage),
      // `syncing` is deliberately absent: restoring it true would leave the app
      // believing a sync that died with the process is still running, and no
      // later sync could ever start.
      partialize: (s) => ({
        entries: s.entries, ownerBusinessId: s.ownerBusinessId, lastSyncAt: s.lastSyncAt,
      }),
      onRehydrateStorage: () => (state) => { state?.ensureOwner?.(); },
    }
  )
);

export const selectPending = (s) => pendingCount(s.entries);
export const selectFailed = (s) => failedCount(s.entries);
export const selectQueuedValue = (s) => queuedValue(s.entries);
