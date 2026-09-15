import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'hi', label: 'हिन्दी', short: 'HI' },
  { code: 'gu', label: 'ગુજરાતી', short: 'GU' },
];

export const useSettingsStore = create()(
  persist(
    (set) => ({
      language: 'en',
      lowStockThreshold: 5,
      /**
       * When a backup was last taken, so the Settings row can say so.
       *
       * Held on the phone rather than the server on purpose: it records that a
       * FILE reached this device, which is the only thing that makes a backup a
       * backup. The server cannot know whether the download it answered ever
       * landed anywhere.
       */
      lastBackupAt: null,
      setLanguage: (language) => set({ language }),
      setLowStockThreshold: (n) => set({ lowStockThreshold: Number(n) || 5 }),
      markBackedUp: (at = Date.now()) => set({ lastBackupAt: at }),
    }),
    { name: 'minipos-settings', storage: createJSONStorage(() => AsyncStorage) }
  )
);
