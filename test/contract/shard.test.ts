import { describe, expect, it } from 'vitest';
import { applyEdit, selectMutants } from '../../scripts/mutate.mjs';
import { inShard, parseArgs } from '../../scripts/shard.mjs';

const items = Array.from({ length: 10 }, (_, i) => `m${i}`);

describe('mutant shards', () => {
  it('cover every mutant exactly once across the shards', () => {
    for (const total of [1, 2, 3, 4, 7, 10, 11]) {
      const parts = Array.from({ length: total }, (_, i) => inShard(items, { index: i + 1, total }));
      expect(parts.flat().sort()).toEqual([...items].sort());
    }
  });

  it('keep the whole list when no shard is asked for', () => {
    expect(inShard(items, null)).toEqual(items);
  });

  it('spread the list so no shard is more than one mutant larger than another', () => {
    const sizes = [1, 2, 3].map((index) => inShard(items, { index, total: 3 }).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('reads --shard i/n next to mutant names', () => {
    expect(parseArgs(['a', '--shard', '2/3', 'b'])).toEqual({ names: ['a', 'b'], shard: { index: 2, total: 3 } });
    expect(parseArgs([])).toEqual({ names: [], shard: null });
  });

  it('refuses a shard that is missing, malformed, zero or past the end', () => {
    for (const bad of [[], ['x'], ['0/3'], ['4/3'], ['1/0'], ['a/b'], ['1-3']])
      expect(() => parseArgs(['--shard', ...bad])).toThrow(/--shard/);
  });
});

describe('mutant edits and selection', () => {
  it('refuses a find text that is missing', () => {
    expect(() => applyEdit('a.ts', 'one two', 'three', 'x')).toThrow(/pattern not found in a\.ts/);
  });
  it('refuses a find text that matches more than once, unless every match is asked for', () => {
    expect(() => applyEdit('a.ts', 'ab ab', 'ab', 'x')).toThrow(/matches 2 times in a\.ts/);
    expect(applyEdit('a.ts', 'ab ab', 'ab', 'x', true)).toBe('x x');
    expect(applyEdit('a.ts', 'ab cd', 'ab', 'x')).toBe('x cd');
  });
  it('refuses an unknown name and an empty selection', () => {
    const all = [{ name: 'a' }, { name: 'b' }];
    expect(() => selectMutants(all, ['c'], null)).toThrow(/no mutant is named c/);
    expect(() => selectMutants(all, ['a'], { index: 2, total: 2 })).toThrow(/selection is empty/);
    expect(selectMutants(all, [], null)).toEqual(all);
    expect(selectMutants(all, ['b'], { index: 1, total: 1 })).toEqual([{ name: 'b' }]);
  });
});
