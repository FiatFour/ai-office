import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FILES = ['spikes/P0-3/leaks.test.ts', 'server/test/atomic.test.ts'];

const runIn = (dir: string, env: Record<string, string> = {}) => {
  const ran = spawnSync('pnpm', ['vitest', 'run', ...FILES], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: dir, AW_KEEP_TMP: '', ...env },
    timeout: 300_000,
  });
  expect(ran.status, ran.stdout.slice(-2000)).toBe(0);
  return readdirSync(dir).filter((name) => /^(aw-|p0-3-)/.test(name));
};

describe.skipIf(process.platform === 'win32')('temp directories', () => {
  it('a test run removes every directory it made, unless AW_KEEP_TMP=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmp-cleanup-'));
    try {
      expect(runIn(dir)).toEqual([]);
      const kept = runIn(dir, { AW_KEEP_TMP: '1' });
      expect(kept.some((name) => name.startsWith('aw-atomic-'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
