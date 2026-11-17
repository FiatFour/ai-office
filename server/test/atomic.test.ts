import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.ts';

const calls: string[] = [];

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    fsyncSync: (fd: number) => {
      calls.push('fsync');
      return real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      calls.push('rename');
      return real.renameSync(from, to);
    },
  };
});

const { writeAtomic } = await import('../store/atomic.ts');

describe('atomic write', () => {
  it.skipIf(process.platform === 'win32')('lets a reader that opened the old file keep a whole old version', () => {
    const path = join(tempDir('atomic'), 'x.json');
    writeFileSync(path, 'old contents');
    const fd = openSync(path, 'r');
    try {
      writeAtomic(path, 'new contents that are longer');
      const buffer = Buffer.alloc(64);
      const read = readSync(fd, buffer, 0, 64, 0);
      expect(buffer.subarray(0, read).toString()).toBe('old contents');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, 'utf8')).toBe('new contents that are longer');
  });

  it('syncs the new file, renames it, then syncs the directory', () => {
    const path = join(tempDir('atomic-order'), 'x.json');
    calls.length = 0;
    writeAtomic(path, 'data');
    expect(calls).toEqual(['fsync', 'rename', ...(process.platform === 'win32' ? [] : ['fsync'])]);
  });
});
