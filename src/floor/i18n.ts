import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import th from '../locales/th.json';

export const LANGS = ['en', 'th'] as const;
export type Lang = (typeof LANGS)[number];

export const langFromLocale = (locale: string | undefined): Lang =>
  locale?.toLowerCase().startsWith('th') ? 'th' : 'en';

export const initI18n = (lang: Lang) =>
  i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, th: { translation: th } },
    lng: lang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export { i18n };
