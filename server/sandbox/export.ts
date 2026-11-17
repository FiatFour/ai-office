import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from './engine.ts';
import { HARDENED_ARGS } from './git-scan.mjs';
import { findProtected } from './protected-paths.mjs';

const SANDBOX_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_ARCHIVE = 1024 * 1024 * 1024;

export class ExportError extends Error {}

const exec = (
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ out: string; err: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, env, maxBuffer: MAX_ARCHIVE, encoding: 'buffer', timeout: 300_000 },
      (error, out, err) => {
        if (error !== null)
          reject(new ExportError(`${bin} ${args[0]} failed: ${err.toString().trim() || error.message}`));
        else resolve({ out: out.toString(), err: err.toString() });
      },
    );
  });

const HOST_GIT_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
});

export const userArgs = (engine: Engine, rootless: boolean): string[] => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return [];
  return engine.name === 'podman' && rootless
    ? ['--userns=keep-id', '--user', `${uid}:${gid}`]
    : ['--user', `${uid}:${gid}`];
};

const mount = (src: string, dst: string, readonly = false): string[] => [
  '--mount',
  `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`,
];

/**
 * Host git runs only against `source`, the operator's clone, which no cage can write.
 * It reads objects with `git archive` and never checks anything out in a directory a cage can reach.
 * The new repo's `.git` is created inside a throwaway container with no network.
 */
export const exportRepo = async (
  source: string,
  dest: string,
  throwaway: (args: string[], mounts: string[]) => Promise<{ code: number; out: string; err: string }>,
): Promise<{ removed: string[] }> => {
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory())
    throw new ExportError(`${source} is not a directory`);
  mkdirSync(dest, { recursive: true });
  if (readdirSync(dest).length > 0) throw new ExportError(`${dest} is not empty, a cage export is always fresh`);
  const archive = `${dest}.tar`;
  const git = (args: string[]) => exec('git', [...HARDENED_ARGS, '-C', source, ...args], source, HOST_GIT_ENV());
  await git(['archive', '--format=tar', '-o', archive, 'HEAD']);
  await exec('tar', ['-xf', archive, '-C', dest], dest, { PATH: process.env.PATH ?? '' });
  rmSync(archive, { force: true });
  const removed = findProtected(dest, { home: '/nonexistent', cwd: dest });
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const init = await throwaway(
    [
      'sh',
      '-c',
      'git init -q -b main && git add -A && git -c user.name=agent-works -c user.email=agent-works@localhost -c commit.gpgsign=false commit -q --allow-empty -m export',
    ],
    mount(dest, '/work'),
  );
  if (init.code !== 0) throw new ExportError(`git init in the export failed: ${init.err.trim()}`);
  return { removed };
};

export const scanInContainer = async (
  dest: string,
  throwaway: (args: string[], mounts: string[]) => Promise<{ code: number; out: string; err: string }>,
): Promise<{ clean: boolean; issues: string[] }> => {
  const result = await throwaway(
    ['node', '/scan/git-scan.mjs', '/repo'],
    [...mount(dest, '/repo', true), ...mount(SANDBOX_DIR, '/scan', true)],
  );
  try {
    return JSON.parse(result.out) as { clean: boolean; issues: string[] };
  } catch {
    return {
      clean: false,
      issues: [`the contained scan failed (exit ${result.code}): ${result.err.trim().slice(-300)}`],
    };
  }
};

export const exportPath = (cagesDir: string, id: string): string => join(cagesDir, id, 'repo');
