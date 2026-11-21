import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { i18n, initI18n, langFromLocale, persistLang, pickLang, STORAGE_KEY } from '../floor/i18n.ts';
import { ACTION_KINDS, MOODS, PANEL } from '../floor/model.ts';
import en from '../locales/en.json' with { type: 'json' };
import th from '../locales/th.json' with { type: 'json' };

type Tree = { readonly [key: string]: string | Tree };

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

describe('locale files', () => {
  it('en.json and th.json have the same keys, the same placeholders and no empty text', () => {
    expect(parityProblems(en, th)).toEqual([]);
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
    expect(forms(en)).toContain('floor.hud.boxesTotal_other');
    expect(forms(en)).toContain('floor.hud.boxesTotal_one');
    expect(forms(th)).toContain('floor.hud.boxesTotal_other');
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
    expect(wanted.filter((key) => !keys.includes(key))).toEqual([]);
  });

  it('every key a component asks for exists in both files', () => {
    const dir = join(import.meta.dirname, '../floor');
    const source = readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    const asked = [...source.matchAll(/\bt\('(floor\.[\w.]+)'/g)].map((match) => match[1] ?? '');
    expect(asked.length).toBeGreaterThan(20);
    const have = Object.keys(withoutPlurals(flatten(en)));
    expect(asked.filter((key) => !have.includes(key))).toEqual([]);
    expect(asked.filter((key) => !(key in withoutPlurals(flatten(th))))).toEqual([]);
  });

  it('says Demo data in the chip and the Debug mode line, as the canvas does', () => {
    expect(en.floor.hud.demo).toBe('Demo data');
    expect(en.floor.debug.modeDemo).toBe(en.floor.hud.demo);
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
    expect(i18n.t('floor.hud.demo', { lng: 'th' })).toBe(th.floor.hud.demo);
  });
});
