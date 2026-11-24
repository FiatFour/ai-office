import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildResources,
  i18n,
  initI18n,
  langFromLocale,
  persistLang,
  pickLang,
  STORAGE_KEY,
  type Tree,
} from '../floor/i18n.ts';
import { ACTION_KINDS, MOODS, PANEL } from '../floor/model.ts';
import en from '../locales/en/floor.json' with { type: 'json' };
import th from '../locales/th/floor.json' with { type: 'json' };

const SRC = join(import.meta.dirname, '..');
const LOCALES = join(SRC, 'locales');

export const flatten = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tree).flatMap(([key, value]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      return typeof value === 'string' ? [[path, value]] : Object.entries(flatten(value, path));
    }),
  );

export const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

export const withoutPlurals = (flat: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(flat).map(([key, text]) => [key.replace(PLURAL, '$1'), text]));

const pluralForms = (flat: Record<string, string>): Map<string, Set<string>> => {
  const forms = new Map<string, Set<string>>();
  for (const key of Object.keys(flat)) {
    const match = PLURAL.exec(key);
    if (match !== null) forms.set(match[1] ?? '', (forms.get(match[1] ?? '') ?? new Set()).add(match[2] ?? ''));
  }
  return forms;
};

const slots = (text: string): string => (text.match(/{{\w+}}/g) ?? []).sort().join(',');

export const parityProblems = (a: Tree, b: Tree, langs: readonly [string, string] = ['en', 'th']): string[] => {
  const flats = [flatten(a), flatten(b)] as const;
  const [left, right] = [withoutPlurals(flats[0]), withoutPlurals(flats[1])];
  const forms = [pluralForms(flats[0]), pluralForms(flats[1])] as const;
  const plural = ([flat, own, other, lang, where]: readonly [
    Record<string, string>,
    Map<string, Set<string>>,
    Map<string, Set<string>>,
    string,
    string,
  ]): string[] => {
    const needed = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    return [
      ...[...own].flatMap(([base, have]) => [
        ...needed
          .filter((category) => !have.has(category))
          .map((category) => `missing plural form in the ${where} file: ${base}_${category}`),
        ...[...have]
          .filter((category) => !(flat[`${base}_${category}`] ?? '').includes('{{count}}'))
          .map((category) => `plural form lost {{count}}: ${base}_${category}`),
      ]),
      ...[...other.keys()]
        .filter((base) => base in flat)
        .map((base) => `plural in one file, plain text in the ${where} one: ${base}`),
    ];
  };
  return [
    ...Object.keys(left)
      .filter((key) => !(key in right))
      .map((key) => `missing from the second file: ${key}`),
    ...Object.keys(right)
      .filter((key) => !(key in left))
      .map((key) => `missing from the first file: ${key}`),
    ...Object.keys(left)
      .filter((key) => key in right && !forms[0].has(key) && slots(left[key] ?? '') !== slots(right[key] ?? ''))
      .map((key) => `placeholders differ: ${key}`),
    ...[...Object.entries(left), ...Object.entries(right)]
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => `empty: ${key}`),
    ...plural([flats[0], forms[0], forms[1], langs[0], 'first']),
    ...plural([flats[1], forms[1], forms[0], langs[1], 'second']),
  ];
};

export type Locales = Readonly<Record<'en' | 'th', Readonly<Record<string, Tree>>>>;

export const localeProblems = (locales: Locales): string[] => {
  const [left, right] = [Object.keys(locales.en), Object.keys(locales.th)];
  return [
    ...left.filter((name) => !right.includes(name)).map((name) => `${name}: no th file`),
    ...right.filter((name) => !left.includes(name)).map((name) => `${name}: no en file`),
    ...left
      .filter((name) => right.includes(name))
      .flatMap((name) =>
        parityProblems(locales.en[name] ?? {}, locales.th[name] ?? {}).map((problem) => `${name}: ${problem}`),
      ),
  ];
};

const readLocales = (): Locales => {
  const read = (lang: string): Record<string, Tree> =>
    Object.fromEntries(
      readdirSync(join(LOCALES, lang))
        .filter((file) => file.endsWith('.json'))
        .map((file) => [file.slice(0, -5), JSON.parse(readFileSync(join(LOCALES, lang, file), 'utf8')) as Tree]),
    );
  return { en: read('en'), th: read('th') };
};

const screenIds = (): string[] => {
  const dir = join(SRC, 'screens');
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, 'screen.tsx'))) : [];
};

const sourceFiles = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.tsx') ? [join(dir, entry.name)] : [],
    );
  return [join(SRC, 'floor'), join(SRC, 'screens')].filter(existsSync).flatMap(walk);
};

describe('locale files', () => {
  it('every namespace has the same keys, the same placeholders and no empty text in en and th', () => {
    expect(localeProblems(readLocales())).toEqual([]);
  });

  it('floor.json is a namespace of both languages', () => {
    expect(parityProblems(en, th)).toEqual([]);
    expect(Object.keys(readLocales().en)).toContain('floor');
  });

  it('fails on a key dropped from one namespace, and on a namespace with only one language', () => {
    const full = { en: { floor: en, orders: { a: 'x' } }, th: { floor: th, orders: { a: 'ก' } } };
    expect(localeProblems(full)).toEqual([]);
    expect(localeProblems({ ...full, th: { ...full.th, orders: {} } })).toEqual([
      'orders: missing from the second file: a',
    ]);
    expect(localeProblems({ ...full, en: { floor: en } })).toEqual(['orders: no en file']);
    expect(localeProblems({ ...full, th: { floor: th } })).toEqual(['orders: no th file']);
  });

  it('every screen has a locale namespace of its own name in both languages', () => {
    const locales = readLocales();
    for (const id of screenIds()) {
      expect(Object.keys(locales.en)).toContain(id);
      expect(Object.keys(locales.th)).toContain(id);
    }
  });

  it('builds resources as <namespace>.<key> from locales/<lang>/<namespace>.json', () => {
    expect(buildResources({ '../locales/en/floor.json': { a: 'x' }, '../locales/th/orders.json': { b: 'y' } })).toEqual(
      { en: { translation: { floor: { a: 'x' } } }, th: { translation: { orders: { b: 'y' } } } },
    );
    expect(() => buildResources({ '../locales/en.json': {} })).toThrow('not a locale file');
  });

  it('the check fails on a key missing from either file', () => {
    expect(parityProblems({ a: { b: 'x' } }, { a: {} })).toEqual(['missing from the second file: a.b']);
    expect(parityProblems({ a: {} }, { a: { b: 'x' } })).toEqual(['missing from the first file: a.b']);
  });

  it('Thai needs one plural form where English has two', () => {
    expect(
      parityProblems(
        { a: { n_one: '{{count}} box', n_other: '{{count}} boxes' } },
        { a: { n_other: '{{count}} กล่อง' } },
      ),
    ).toEqual([]);
    expect(parityProblems({ a: { n_one: '{{count}} box', n_other: '{{count}} boxes' } }, { a: {} })).toEqual([
      'missing from the second file: a.n',
    ]);
  });

  it('fails when a plural form is missing from either file', () => {
    const both = { a: { n_one: '{{count}} box', n_other: '{{count}} boxes' } };
    const thai = { a: { n_other: '{{count}} กล่อง' } };
    expect(parityProblems({ a: { n_one: '{{count}} box' } }, thai)).toEqual([
      'missing plural form in the first file: a.n_other',
    ]);
    expect(parityProblems({ a: { n_other: '{{count}} boxes' } }, thai)).toEqual([
      'missing plural form in the first file: a.n_one',
    ]);
    expect(parityProblems(both, { a: { n_one: '{{count}} กล่อง' } })).toEqual([
      'missing plural form in the second file: a.n_other',
    ]);
  });

  it('fails when a plural form loses {{count}} or one file keeps plain text where the other has plural forms', () => {
    const thai = { a: { n_other: '{{count}} กล่อง' } };
    expect(parityProblems({ a: { n_one: 'a box', n_other: '{{count}} boxes' } }, thai)).toEqual([
      'plural form lost {{count}}: a.n_one',
    ]);
    expect(parityProblems({ a: { n_one: '{{count}} box', n_other: '{{count}} boxes' } }, { a: { n: 'กล่อง' } })).toEqual(
      expect.arrayContaining(['plural in one file, plain text in the second one: a.n']),
    );
  });

  it('the shipped locale files hold the plural forms their language needs', () => {
    const forms = (tree: Tree) => Object.keys(flatten(tree)).filter((key) => PLURAL.test(key));
    expect(forms(en)).toContain('hud.boxesTotal_other');
    expect(forms(en)).toContain('hud.boxesTotal_one');
    expect(forms(th)).toContain('hud.boxesTotal_other');
  });

  it('the check fails on a placeholder one language lost, and on empty text', () => {
    expect(parityProblems({ a: '{{count}} boxes' }, { a: 'boxes' })).toEqual(['placeholders differ: a']);
    expect(parityProblems({ a: 'x' }, { a: ' ' })).toEqual(['empty: a']);
  });

  it('holds a key for every mood, station, action kind and speech line the floor can show', () => {
    const keys = Object.keys(withoutPlurals(flatten(en)));
    const wanted = [
      ...MOODS.flatMap((mood) => [`floor.mood.${mood}`, `floor.worker.says.${mood}`]),
      ...PANEL.map((station) => `floor.station.${station}`),
      ...ACTION_KINDS.map((kind) => `floor.actions.kind.${kind}`),
    ];
    expect(wanted.filter((key) => !keys.includes(key.replace(/^floor\./, '')))).toEqual([]);
  });

  it('every key a component asks for exists in both files of its namespace', () => {
    const source = sourceFiles()
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const asked = [...source.matchAll(/\bt\('([\w-]+)\.([\w.]+)'/g)].map((match) => [match[1] ?? '', match[2] ?? '']);
    expect(asked.filter(([namespace]) => namespace === 'floor').length).toBeGreaterThan(20);
    const locales = readLocales();
    const missing = (lang: 'en' | 'th') =>
      asked
        .filter(([namespace, key]) => !((key ?? '') in withoutPlurals(flatten(locales[lang][namespace ?? ''] ?? {}))))
        .map(([namespace, key]) => `${lang}: ${namespace}.${key}`);
    expect([...missing('en'), ...missing('th')]).toEqual([]);
  });

  it('says Demo data in the chip and the Debug mode line, as the canvas does', () => {
    expect(en.hud.demo).toBe('Demo data');
    expect(en.debug.modeDemo).toBe(en.hud.demo);
  });

  it('keeps technical terms in English inside Thai text', () => {
    const text = JSON.stringify(th);
    for (const term of ['Action items', 'QC', 'merge', 'sandbox', 'PR', 'worker', 'host']) expect(text).toContain(term);
  });

  it('does not put the English floor stamps in the locale files', () => {
    const text = JSON.stringify(en);
    for (const stamp of ['SHIPPED', 'SCRAPPED', 'CHANGES']) expect(text).not.toContain(stamp);
  });

  it('picks Thai from a th locale and English from everything else', () => {
    expect(langFromLocale('th-TH')).toBe('th');
    expect(langFromLocale('TH')).toBe('th');
    expect(langFromLocale('en-US')).toBe('en');
    expect(langFromLocale(undefined)).toBe('en');
  });
});

describe('language choice', () => {
  it('takes the ?lang= ask first, then the saved choice, then the browser locale', () => {
    expect(pickLang('th', 'en', 'en-US')).toBe('th');
    expect(pickLang(null, 'th', 'en-US')).toBe('th');
    expect(pickLang(null, 'en', 'th-TH')).toBe('en');
    expect(pickLang(null, null, 'th-TH')).toBe('th');
    expect(pickLang('fr', 'de', 'en-US')).toBe('en');
  });

  it('writes the language to the page and to storage', () => {
    const root = { lang: 'en' };
    const saved: [string, string][] = [];
    persistLang('th', root, { setItem: (key, value) => saved.push([key, value]) });
    expect(root.lang).toBe('th');
    expect(saved).toEqual([[STORAGE_KEY, 'th']]);
  });

  it('falls back to English, not Thai, for a key one file lacks', async () => {
    await initI18n('th');
    i18n.addResourceBundle('en', 'translation', { probe: 'english only' });
    expect(i18n.t('probe', { lng: 'th' })).toBe('english only');
    expect(i18n.t('floor.hud.demo', { lng: 'th' })).toBe(th.hud.demo);
  });
});
