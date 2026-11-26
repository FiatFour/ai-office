import { describe, expect, it } from 'vitest';
import { TaskRefused } from '../model.ts';
import { canonical } from '../protected.ts';

describe('canonical drive paths', () => {
  it.each([['C:/x'], ['C:\\x'], ['c:/x.md'], ['C:\\dir\\x'], ['C:\\\\x']])('refuses the drive path %j', (path) => {
    expect(() => canonical(path)).toThrow(TaskRefused);
  });

  it.each([
    ['a:b.md', 'a:b.md'],
    ['c:notes.md', 'c:notes.md'],
    ['docs/c:notes.md', 'docs/c:notes.md'],
  ])('accepts the Linux-legal name %j', (path, expected) => {
    expect(canonical(path)).toBe(expected);
  });
});
