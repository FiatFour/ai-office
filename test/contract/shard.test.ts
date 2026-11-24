import { describe, expect, it } from 'vitest';
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
