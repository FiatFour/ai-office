import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/pixelify-sans/latin-700.css';
import '@fontsource/vt323/latin-400.css';
import './floor.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { i18n, initI18n, LANGS, type Lang, langFromLocale } from './i18n.ts';

const STORAGE_KEY = 'agent-works.lang';

const firstLang = (): Lang => {
  const asked = new URLSearchParams(location.search).get('lang');
  const saved = localStorage.getItem(STORAGE_KEY);
  const found = [asked, saved].find((value): value is Lang => LANGS.includes(value as Lang));
  return found ?? langFromLocale(navigator.language);
};

const initial = firstLang();
await initI18n(initial);
document.documentElement.lang = initial;

const Root = () => {
  const [lang, setLang] = useState<Lang>(initial);
  const change = (next: Lang): void => {
    void i18n.changeLanguage(next);
    document.documentElement.lang = next;
    localStorage.setItem(STORAGE_KEY, next);
    setLang(next);
  };
  return <App lang={lang} onLang={change} />;
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
