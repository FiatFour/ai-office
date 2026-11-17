import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/pixelify-sans/latin-700.css';
import '@fontsource/sarabun/thai-400.css';
import '@fontsource/sarabun/thai-700.css';
import '@fontsource/vt323/latin-400.css';
import './floor.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { i18n, initI18n, type Lang, persistLang, pickLang, STORAGE_KEY } from './i18n.ts';

const initial = pickLang(
  new URLSearchParams(location.search).get('lang'),
  localStorage.getItem(STORAGE_KEY),
  navigator.language,
);
await initI18n(initial);
document.documentElement.lang = initial;

const Root = () => {
  const [lang, setLang] = useState<Lang>(initial);
  const change = (next: Lang): void => {
    void i18n.changeLanguage(next);
    persistLang(next, document.documentElement, localStorage);
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
