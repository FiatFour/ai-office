import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from './engine.ts';
import { HARDENED_ARGS } from './git-scan.mjs';
import { findProtected } from './protected-paths.mjs';

const SANDBOX_DIR = dirname(fileURLToPath(import.meta.url));
export class ExportError extends Error {}

const CONTAINER_GIT = `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 git ${HARDENED_ARGS.join(' ')}`;

export const userArgs = (engine: Engine, rootless: boolean): string[] => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return [];
  return engine.name === 'podman' && rootless
    ? ['--userns=keep-id', '--user', `${uid}:${gid}`]
    : ['--user', `${uid}:${gid}`];
};

/** The one place a host path becomes a bind mount argument. The cage and the contract engine probe both build theirs here. */
export const mount = (src: string, dst: string, readonly = false): string[] => [
  '--mount',
  `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`,
];

export const exportRepo = async (
  source: string,
  dest: string,
  throwaway: (args: string[], mounts: string[]) => Promise<{ code: number; out: string; err: string }>,
): Promise<{ removed: string[] }> => {
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory())
    throw new ExportError(`${source} is not a directory`);
  mkdirSync(dest, { recursive: true });
  if (readdirSync(dest).length > 0) throw new ExportError(`${dest} is not empty, a cage export is always fresh`);
  const archived = await throwaway(
    [
      'sh',
      '-c',
      `(${CONTAINER_GIT} -C /src archive --format=tar HEAD || touch /tmp/archive-failed) | tar -xf - -C /work; test ! -e /tmp/archive-failed`,
    ],
    [...mount(source, '/src', true), ...mount(dest, '/work')],
  );
  if (archived.code !== 0) throw new ExportError(`git archive in the container failed: ${archived.err.trim()}`);
  const removed = findProtected(dest, { home: '/nonexistent', cwd: dest });
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const init = await throwaway(
    [
      'sh',
      '-c',
      'cd /work && git init -q -b main && git add -A && git -c user.name=agent-works -c user.email=agent-works@localhost -c commit.gpgsign=false commit -q --allow-empty -m export',
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
