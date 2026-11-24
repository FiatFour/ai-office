import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
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

export type Tree = { readonly [key: string]: string | Tree };

const LOCALE_FILE = /\/locales\/([a-z]+)\/([\w-]+)\.json$/;

/** Each `locales/<lang>/<namespace>.json` becomes the subtree `<namespace>` of that language, so keys read `<namespace>.<key>`. */
export const buildResources = (files: Readonly<Record<string, Tree>>): Record<string, { translation: Tree }> => {
  const out: Record<string, Record<string, Tree>> = {};
  for (const [path, tree] of Object.entries(files)) {
    const match = LOCALE_FILE.exec(path);
    if (match === null) throw new Error(`not a locale file: ${path}`);
    const [, lang = '', namespace = ''] = match;
    out[lang] = { ...out[lang], [namespace]: tree };
  }
  return Object.fromEntries(Object.entries(out).map(([lang, translation]) => [lang, { translation }]));
};

const files = import.meta.glob<Tree>('../locales/*/*.json', { eager: true, import: 'default' });

export const initI18n = (lang: Lang) =>
  i18n.use(initReactI18next).init({
    resources: buildResources(files),
    lng: lang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export { i18n };
