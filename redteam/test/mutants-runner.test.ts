import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';

const REPO = join(import.meta.dirname, '../..');
const TARGET = 'redteam/outcome.ts';
const MUTANT = 'caged-hit-passes';

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

/** A throw-away repo holding the one file the mutant edits, a clean tree, and a `pnpm` that hangs like a slow suite. */
const fixture = () => {
  const root = tempDir('mutants-root');
  mkdirSync(join(root, 'redteam'), { recursive: true });
  copyFileSync(join(REPO, TARGET), join(root, TARGET));
  const bin = tempDir('mutants-bin');
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexec sleep 60\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const run = (): ChildProcess =>
    spawn(process.execPath, [join(REPO, 'redteam/test/mutants.mjs'), MUTANT], {
      env: {
        ...process.env,
        MUTANTS_ROOT: root,
        PATH: `${bin}:${process.env.PATH}`,
        MUTANT_OUT: join(root, '..', 'out.txt'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return { root, run, original: readFileSync(join(root, TARGET), 'utf8') };
};

const closed = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string }>((resolve) => {
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('close', (code, signal) => resolve({ code, signal, err }));
  });

describe.skipIf(process.platform === 'win32')('the mutant runner', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'leaves the tree clean when %s kills it mid-mutant',
    async (signal) => {
      const { root, run, original } = fixture();
      const child = run();
      const done = closed(child);
      let mutated = false;
      for (let i = 0; i < 200 && !mutated; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        mutated = readFileSync(join(root, TARGET), 'utf8') !== original;
      }
      expect(mutated).toBe(true);
      child.kill(signal);
      const result = await done;
      expect(result.code).not.toBe(0);
      expect(readFileSync(join(root, TARGET), 'utf8')).toBe(original);
      expect(git(root, 'status', '--porcelain', '--untracked-files=all').stdout).toBe('');
    },
    30_000,
  );

  it('refuses to start when a tracked file is modified', async () => {
    const { root, run, original } = fixture();
    writeFileSync(join(root, TARGET), `${original}// edit\n`);
    const result = await closed(run());
    expect(result.code).toBe(2);
    expect(result.err).toContain('dirty tree');
    expect(readFileSync(join(root, TARGET), 'utf8')).toBe(`${original}// edit\n`);
  }, 30_000);

  it('refuses to start when an untracked file is present', async () => {
    const { root, run } = fixture();
    writeFileSync(join(root, 'redteam/new.ts'), 'export {};\n');
    const result = await closed(run());
    expect(result.code).toBe(2);
    expect(result.err).toContain('redteam/new.ts');
  }, 30_000);
});
