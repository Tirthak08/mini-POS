import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from './authStore';

/**
 * A count in progress, held on disk.
 *
 * Counting a shop takes longer than a phone stays awake. The operator will put
 * the phone in a pocket, answer a customer, take a call, and come back -- and on
 * Android that can mean the app was killed outright. Keeping the half-finished
 * count only in component state would throw away an hour of walking the shelves
 * for no reason the operator could see, which is precisely how a feature like
 * this stops being used.
 *
 * Raw text is stored, not numbers: "" is a field nobody has reached yet and
 * "0" is a shelf somebody looked at and found empty. Coercing on the way in
 * would lose that difference permanently (see utils/stocktake.js).
 *
 * The draft is tagged with the tenant that owns it, for the same reason the
 * catalogue cache is: on a shared phone, a count started by one shop must never
 * reappear inside another's.
 */
export const useStocktakeStore = create()(
  persist(
    (set, get) => ({
      counts: {},
      note: '',
      startedAt: null,
      ownerBusinessId: null,

      setCount: (productId, text) => {
        const id = String(productId);
        const counts = { ...get().counts };
        if (text === '' || text === null || text === undefined) delete counts[id];
        else counts[id] = String(text);
        set({
          counts,
          startedAt: get().startedAt ?? Date.now(),
          ownerBusinessId: get().ownerBusinessId
            ?? useAuthStore.getState().business?.businessId
            ?? null,
        });
      },

      setNote: (note) => set({ note: String(note ?? '') }),

      reset: () => set({ counts: {}, note: '', startedAt: null, ownerBusinessId: null }),

      /** Drops a draft that belongs to a different shop. */
      ensureOwner: () => {
        const signedIn = useAuthStore.getState().business?.businessId ?? null;
        const owner = get().ownerBusinessId;
        if (owner && signedIn && owner !== signedIn) get().reset();
      },
    }),
    {
      name: 'vyapaar-stocktake-draft',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        counts: s.counts, note: s.note, startedAt: s.startedAt, ownerBusinessId: s.ownerBusinessId,
      }),
      onRehydrateStorage: () => (state) => { state?.ensureOwner?.(); },
    }
  )
);
