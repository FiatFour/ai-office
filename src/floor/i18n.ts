import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import th from '../locales/th.json';

export const LANGS = ['en', 'th'] as const;
export type Lang = (typeof LANGS)[number];
export const STORAGE_KEY = 'agent-works.lang';

export const langFromLocale = (locale: string | undefined): Lang =>
  locale?.toLowerCase().startsWith('th') ? 'th' : 'en';

export const pickLang = (asked: string | null, saved: string | null, locale: string | undefined): Lang =>
  [asked, saved].find((value): value is Lang => LANGS.includes(value as Lang)) ?? langFromLocale(locale);

export const persistLang = (lang: Lang, root: { lang: string }, store: Pick<Storage, 'setItem'>): void => {
  root.lang = lang;
  store.setItem(STORAGE_KEY, lang);
};

export const initI18n = (lang: Lang) =>
  i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, th: { translation: th } },
    lng: lang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export { i18n };
