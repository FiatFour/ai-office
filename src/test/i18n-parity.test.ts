import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { langFromLocale } from '../floor/i18n.ts';
import { ACTION_KINDS, MOODS, STATIONS } from '../floor/model.ts';
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

const PLURAL = /_(zero|one|two|few|many|other)$/;

export const withoutPlurals = (flat: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(flat).map(([key, text]) => [key.replace(PLURAL, ''), text]));

export const parityProblems = (a: Tree, b: Tree): string[] => {
  const left = withoutPlurals(flatten(a));
  const right = withoutPlurals(flatten(b));
  const slots = (text: string): string => (text.match(/{{\w+}}/g) ?? []).sort().join(',');
  return [
    ...Object.keys(left)
      .filter((key) => !(key in right))
      .map((key) => `missing from the second file: ${key}`),
    ...Object.keys(right)
      .filter((key) => !(key in left))
      .map((key) => `missing from the first file: ${key}`),
    ...Object.keys(left)
      .filter((key) => key in right && slots(left[key] ?? '') !== slots(right[key] ?? ''))
      .map((key) => `placeholders differ: ${key}`),
    ...[...Object.entries(left), ...Object.entries(right)]
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => `empty: ${key}`),
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

  it('Thai needs one plural form where English has two, the check compares the base key', () => {
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

  it('the check fails on a placeholder one language lost, and on empty text', () => {
    expect(parityProblems({ a: '{{count}} boxes' }, { a: 'boxes' })).toEqual(['placeholders differ: a']);
    expect(parityProblems({ a: 'x' }, { a: ' ' })).toEqual(['empty: a']);
  });

  it('holds a key for every mood, station, action kind and speech line the floor can show', () => {
    const keys = Object.keys(withoutPlurals(flatten(en)));
    const wanted = [
      ...MOODS.flatMap((mood) => [`floor.mood.${mood}`, `floor.worker.says.${mood}`]),
      ...STATIONS.map((station) => `floor.station.${station}`),
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

  it('keeps technical terms in English inside Thai text', () => {
    const text = JSON.stringify(th);
    for (const term of ['Action items', 'QC', 'Merge', 'sandbox', 'PR', 'worker', 'host']) expect(text).toContain(term);
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
