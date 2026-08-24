import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { awaitHydration } from '../utils/hydration';

/**
 * True once the persisted stores have been read back off disk.
 *
 * The navigator decides purely on `token`, so until the session has rehydrated
 * it renders the SIGN-IN screen -- to a shopkeeper who is already signed in.
 * Holding the splash until this turns true covers that window, and the language
 * one with it: a Gujarati shop would otherwise see a flash of English.
 *
 * The waiting logic lives in utils/hydration so it can be tested with fake
 * stores; see the note there on why a browser test cannot check this.
 */
const PERSISTED = [useAuthStore, useSettingsStore];

export function useAppReady() {
  // Hydration can already be complete before the first render on a warm start.
  const [ready, setReady] = useState(
    () => PERSISTED.every((s) => s.persist?.hasHydrated?.() ?? true)
  );

  useEffect(() => {
    if (ready) return undefined;
    const { promise, cancel } = awaitHydration(PERSISTED);
    let live = true;
    promise.then(() => { if (live) setReady(true); });
    return () => { live = false; cancel(); };
  }, [ready]);

  return ready;
}
