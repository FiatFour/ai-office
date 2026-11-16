import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProtectedPath } from './protected-paths.mjs';

export const HARDENED_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'core.pager=cat',
  '-c',
  'gc.auto=0',
  '-c',
  'safe.directory=*',
];
export const HARDENED_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  HOME: '/nonexistent',
};

export const REMEDIATION =
  'Untrack it on the host before the cage starts (git rm --cached <path>, which the in-cage hook blocks). If it was ever committed, rewrite history, then run `git reflog expire --expire=now --all` and `git gc --prune=now` so the reflog and loose objects drop it.';

const MAX_ENTRIES = 250_000;
const GIT_TIMEOUT_MS = 120_000;
const NO_CTX = { home: '/nonexistent', cwd: '/' };

/**
 * @typedef {{ clean: boolean, protectedPaths: string[], unreachable: number, issues: string[], units: number }} ScanResult
 * @typedef {{ dir: string, gitDir?: boolean }} Unit
 */

/**
 * Finds every git worktree and every module gitdir under a repo without following symlinks and without running git.
 * @param {string} repo
 * @param {number} cap
 * @returns {{ units: Unit[], tooLarge: boolean, unreadable: string[] }}
 */
const findUnits = (repo, cap) => {
  /** @type {Unit[]} */
  const units = [];
  /** @type {string[]} */
  const unreadable = [];
  const pending = [{ dir: repo, modules: false }];
  let seen = 0;
  while (pending.length > 0) {
    const { dir, modules } = /** @type {{ dir: string, modules: boolean }} */ (pending.pop());
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') unreadable.push(dir);
      continue;
    }
    seen += entries.length;
    if (seen > cap) return { units, tooLarge: true, unreadable };
    const names = new Set(entries.map((entry) => entry.name));
    if (modules && names.has('HEAD') && names.has('objects')) units.push({ dir, gitDir: true });
    for (const entry of entries) {
      if (entry.name === '.git' && !modules) {
        units.push({ dir });
        if (entry.isDirectory()) pending.push({ dir: join(dir, '.git', 'modules'), modules: true });
      } else if (entry.isDirectory() && entry.name !== '.git') pending.push({ dir: join(dir, entry.name), modules });
    }
  }
  return { units, tooLarge: false, unreadable };
};

/**
 * @param {string} repo
 * @param {{ maxEntries?: number, timeoutMs?: number }} [options]
 * @returns {ScanResult}
 */
export const scanRepo = (repo, { maxEntries = MAX_ENTRIES, timeoutMs = GIT_TIMEOUT_MS } = {}) => {
  /** @type {string[]} */
  const issues = [];
  const found = new Set();
  let unreachable = 0;
  /** @param {Unit} unit @param {string[]} args */
  const git = (unit, args) =>
    execFileSync('git', [...HARDENED_ARGS, ...(unit.gitDir ? ['--git-dir', unit.dir] : ['-C', unit.dir]), ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...HARDENED_ENV },
    });
  /** @param {Unit} unit @param {string} path */
  const record = (unit, path) => {
    if (path && isProtectedPath(`/${path}`, NO_CTX)) found.add(join(relative(repo, unit.dir), path));
  };

  const { units, tooLarge, unreadable } = findUnits(repo, maxEntries);
  for (const dir of unreadable) issues.push(`could not scan ${dir}, the directory is unreadable`);
  if (tooLarge) issues.push(`${repo} is too large to scan for nested repositories (cap ${maxEntries} entries)`);
  for (const unit of units) {
    const label = relative(repo, unit.dir) || '.';
    try {
      const reachable = new Set();
      if (!unit.gitDir) {
        for (const record_ of git(unit, ['ls-files', '-z', '--stage']).split('\0')) {
          const tab = record_.indexOf('\t');
          if (tab < 0) continue;
          reachable.add(record_.split(' ')[1]);
          record(unit, record_.slice(tab + 1));
        }
      }
      for (const line of git(unit, ['rev-list', '--all', '--reflog', '--objects']).split('\n')) {
        if (!line) continue;
        const space = line.indexOf(' ');
        reachable.add(space < 0 ? line : line.slice(0, space));
        if (space >= 0) record(unit, line.slice(space + 1));
      }
      const all = git(unit, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n');
      const loose = all.filter((oid) => oid && !reachable.has(oid)).length;
      if (loose > 0) {
        unreachable += loose;
        issues.push(
          `${label}: ${loose} unreachable object(s) (dangling blobs, trees or commits) that could hold a protected file`,
        );
      }
      const gitDir = unit.gitDir ? unit.dir : join(unit.dir, '.git');
      if (existsSync(join(gitDir, 'objects', 'info', 'alternates'))) {
        issues.push(`${label}: the repo borrows objects from another repo through objects/info/alternates`);
      }
    } catch (error) {
      issues.push(
        `${label}: could not scan, git failed (${String(/** @type {Error} */ (error).message).split('\n')[0]})`,
      );
    }
  }
  const protectedPaths = [...found];
  if (protectedPaths.length > 0) {
    issues.unshift(
      `protected paths in git (index, a commit, the reflog or a submodule): ${protectedPaths.join(', ')}. ${REMEDIATION}`,
    );
  }
  if (unreachable > 0) issues.push(REMEDIATION);
  return { clean: issues.length === 0, protectedPaths, unreachable, issues, units: units.length };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('usage: node git-scan.mjs <repo>');
    process.exit(2);
  }
  console.log(JSON.stringify(scanRepo(repo)));
}
