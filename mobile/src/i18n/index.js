import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import hi from './hi';
import gu from './gu';
import { useSettingsStore } from '../store/settingsStore';

/**
 * No plural keys are used anywhere in these files on purpose: Hermes ships
 * without full Intl.PluralRules on some Android builds, and i18next would
 * silently fall back to the English rule. Counts are interpolated instead.
 */
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    hi: { translation: hi },
    gu: { translation: gu },
  },
  lng: useSettingsStore.getState().language || 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React Native already escapes
  returnNull: false,
});

/** Single entry point so the store and i18next can never disagree. */
export function setAppLanguage(code) {
  useSettingsStore.getState().setLanguage(code);
  i18n.changeLanguage(code);
}

// Language chosen on a previous run is restored asynchronously by AsyncStorage.
useSettingsStore.persist?.onFinishHydration?.((state) => {
  if (state?.language && state.language !== i18n.language) {
    i18n.changeLanguage(state.language);
  }
});

export default i18n;
