import childProcess, { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import config from '../../vitest.config.ts';

const mark = Symbol.for('aw.syncChildLimit');
const limit = (childProcess as unknown as { [mark]?: { ms: number } })[mark] ?? { ms: Number.NaN };
const usual = limit.ms;

// Ignores SIGTERM and, if nothing kills it, leaves a file behind when it ends.
const hang = () => {
  const dir = tempDir('hang');
  const survived = join(dir, 'survived');
  const source = `process.on('SIGTERM', () => {});
setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, ''), 8000);`;
  const script = join(dir, 'hang.cjs');
  writeFileSync(script, source);
  return { script, source, survived };
};
type Hang = ReturnType<typeof hang>;

afterEach(() => {
  limit.ms = usual;
});

describe('the repo test limits', () => {
  it('gives a test or hook with no limit of its own 30 s', ({ task }) => {
    expect(task.timeout).toBe(30_000);
    expect(config.test?.hookTimeout).toBe(30_000);
  });

  it('gives a synchronous child 60 s', () => {
    expect(usual).toBe(60_000);
  });

  it.each<[string, (child: Hang) => unknown]>([
    ['execFileSync', ({ script }) => execFileSync(process.execPath, [script])],
    ['execFileSync with options only', ({ source }) => execFileSync(process.execPath, { input: source })],
    ['spawnSync', ({ script }) => spawnSync(process.execPath, [script])],
    [
      'spawnSync with a null argument list',
      ({ source }) => spawnSync(process.execPath, null as unknown as string[], { input: source }),
    ],
    ['execSync', ({ source }) => execSync(`"${process.execPath}" -`, { input: source })],
    ['execSync with a command only', ({ script }) => execSync(`"${process.execPath}" "${script}"`)],
  ])('kills a hung child of %s, even one that ignores SIGTERM, and throws', (_name, run) => {
    const child = hang();
    limit.ms = 1500;
    expect(() => run(child)).toThrow('ETIMEDOUT');
    expect(existsSync(child.survived)).toBe(false);
  });

  it('keeps the timeout a caller gives', () => {
    limit.ms = 100;
    const slow = 'setTimeout(() => console.log("done"), 600)';
    expect(execFileSync(process.execPath, ['-e', slow], { encoding: 'utf8', timeout: 20_000 })).toBe('done\n');
  });
});
