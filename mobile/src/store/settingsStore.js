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
      setLanguage: (language) => set({ language }),
      setLowStockThreshold: (n) => set({ lowStockThreshold: Number(n) || 5 }),
    }),
    { name: 'minipos-settings', storage: createJSONStorage(() => AsyncStorage) }
  )
);
