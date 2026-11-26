import { describe, expect, it } from 'vitest';
import { TaskRefused } from '../model.ts';
import { canonical } from '../protected.ts';

describe('canonical drive paths', () => {
  it('refuses real drive paths', () => {
    for (const bad of ['C:/x', 'C:\\x', 'c:/x/y', 'z:\\a\\b']) expect(() => canonical(bad), bad).toThrow(TaskRefused);
  });

  it('accepts Linux-legal names that merely look like drive paths', () => {
    expect(canonical('a:b.md')).toBe('a:b.md');
    expect(canonical('c:notes.md')).toBe('c:notes.md');
    expect(canonical('dir/C:x')).toBe('dir/C:x');
  });
});
