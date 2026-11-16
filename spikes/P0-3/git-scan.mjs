import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  GIT_NO_REPLACE_OBJECTS: '1',
  HOME: '/nonexistent',
};

export const REMEDIATION =
  'Untrack it on the host before the cage starts (git rm --cached <path>, which the in-cage hook blocks). If it was ever committed, rewrite history, then run `git reflog expire --expire=now --all` and `git gc --prune=now` so the reflog and loose objects drop it.';

const MAX_ENTRIES = 250_000;
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT = 512 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_POINTER_BYTES = 4096;
const NO_CTX = { home: '/nonexistent', cwd: '/' };
const REF_NAMESPACES = ['refs/heads/', 'refs/tags/', 'refs/remotes/'];
const FORBIDDEN_FILES = [
  ['objects', 'info', 'alternates'],
  ['objects', 'info', 'http-alternates'],
  ['shallow'],
  ['info', 'grafts'],
  ['worktrees'],
];

/**
 * @typedef {{ clean: boolean, protectedPaths: string[], unreachable: number, issues: string[], units: number }} ScanResult
 * @typedef {{ units: string[], pointers: string[], dotGit: string[], issues: string[] }} Discovery
 */

/** @param {import('node:fs').Dirent[]} entries @param {string} name @param {'file' | 'dir'} kind */
const has = (entries, name, kind) =>
  entries.some((entry) => entry.name === name && (kind === 'dir' ? entry.isDirectory() : entry.isFile()));

/**
 * Finds git dirs by structure (a dir holding a HEAD file, an objects dir and a refs dir), never by name, without
 * following symlinks and without running git. Anything it cannot read or bound lands in issues.
 * @param {string} repo
 * @param {number} cap
 * @returns {Discovery}
 */
const discover = (repo, cap) => {
  /** @type {Discovery} */
  const found = { units: [], pointers: [], dotGit: [], issues: [] };
  const pending = [repo];
  let seen = 0;
  while (pending.length > 0) {
    const dir = /** @type {string} */ (pending.pop());
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      found.issues.push(`could not scan ${dir}, the directory is unreadable (${code})`);
      continue;
    }
    seen += entries.length;
    if (seen > cap) {
      found.issues.push(`${repo} is too large to scan for git dirs (cap ${cap} entries)`);
      return found;
    }
    if (has(entries, 'HEAD', 'file') && has(entries, 'objects', 'dir') && has(entries, 'refs', 'dir')) {
      found.units.push(dir);
      if (has(entries, 'modules', 'dir')) pending.push(join(dir, 'modules'));
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === '.git') {
        if (entry.isFile()) found.pointers.push(path);
        else if (entry.isDirectory()) found.dotGit.push(path);
        else
          found.issues.push(`${relative(repo, path)} is neither a git dir nor a gitdir file, so it cannot be bounded`);
      }
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return found;
};

/** @param {string} dir */
const reflogLines = (dir) => {
  /** @type {{ path: string, lines: number }[]} */
  const counts = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = /** @type {string} */ (pending.pop());
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        if (statSync(path).size > MAX_LOG_BYTES) throw new Error(`${path} is larger than ${MAX_LOG_BYTES} bytes`);
        counts.push({ path, lines: readFileSync(path, 'latin1').split('\n').filter(Boolean).length });
      } else throw new Error(`${path} is not a regular file`);
    }
  }
  return counts;
};

/**
 * Accepts a repo only when every object in every git dir is accounted for: each ref is a branch, tag or remote
 * branch that peels to a commit, and every object in the store is reachable from those commits through a path in
 * a commit tree, so no path-less blob, note, replace, stash or dangling object can hold a protected file. Paths
 * are read NUL-delimited. A scan that cannot parse, read or bound anything counts as not clean.
 * @param {string} repo
 * @param {{ maxEntries?: number, timeoutMs?: number }} [options]
 * @returns {ScanResult}
 */
export const scanRepo = (repo, { maxEntries = MAX_ENTRIES, timeoutMs = GIT_TIMEOUT_MS } = {}) => {
  /** @type {string[]} */
  const issues = [];
  const found = new Set();
  let unreachable = 0;
  let isDir = false;
  try {
    isDir = statSync(repo).isDirectory();
  } catch {}
  if (!isDir) {
    issues.push(`${repo} does not exist or is not a directory, so it cannot be vouched for`);
    return { clean: false, protectedPaths: [], unreachable: 0, issues, units: 0 };
  }

  /** @param {string} gitDir @param {string[]} args @param {string} [input] */
  const git = (gitDir, args, input) =>
    execFileSync('git', [...HARDENED_ARGS, '--git-dir', gitDir, '--work-tree', dirname(gitDir), ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT,
      timeout: timeoutMs,
      cwd: dirname(gitDir),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...HARDENED_ENV },
    });
  /** @param {string} gitDir @param {string} path */
  const record = (gitDir, path) => {
    if (path && isProtectedPath(`/${path}`, NO_CTX)) found.add(join(relative(repo, dirname(gitDir)), path));
  };

  const discovery = discover(repo, maxEntries);
  issues.push(...discovery.issues);
  const units = new Set(discovery.units.map((dir) => resolve(dir)));
  for (const dir of discovery.dotGit) {
    if (!units.has(resolve(dir))) issues.push(`${relative(repo, dir)} is named .git but is not a git dir`);
  }
  for (const pointer of discovery.pointers) {
    let text = '';
    try {
      if (statSync(pointer).size <= MAX_POINTER_BYTES) text = readFileSync(pointer, 'utf8');
    } catch {}
    const target = /^gitdir:\s*(.+?)\s*$/.exec(text)?.[1];
    if (!target || !units.has(resolve(dirname(pointer), target))) {
      issues.push(`${relative(repo, pointer)} points at a git dir outside this repo or one the scan cannot read`);
    }
  }
  if (!units.has(resolve(repo, '.git')) && !units.has(resolve(repo))) {
    issues.push(`${repo} has no git dir of its own (no .git holding HEAD, objects and refs)`);
  }

  for (const gitDir of units) {
    const label = relative(repo, gitDir) || '.';
    try {
      for (const file of FORBIDDEN_FILES) {
        if (existsSync(join(gitDir, ...file))) {
          issues.push(`${label}: ${file.join('/')} is present, so objects can come from outside the scanned store`);
        }
      }
      for (const log of reflogLines(join(gitDir, 'logs'))) {
        if (log.lines > 1) {
          issues.push(`${label}: reflog ${relative(gitDir, log.path)} has ${log.lines} entries, a fresh clone has one`);
        }
      }
      const refs = git(gitDir, ['for-each-ref', '--format=%(objecttype) %(*objecttype) %(refname)']);
      for (const line of refs.split('\n')) {
        if (!line) continue;
        const match = /^(\S+) (\S*) (.+)$/.exec(line);
        const [, type = '', peeled = '', ref = line] = match ?? [];
        if (!match || !REF_NAMESPACES.some((prefix) => ref.startsWith(prefix))) {
          issues.push(
            `${label}: ref ${ref} is outside refs/heads, refs/tags and refs/remotes (notes, replace, stash, original)`,
          );
        } else if (!(type === 'commit' || (type === 'tag' && peeled === 'commit'))) {
          issues.push(
            `${label}: ref ${ref} points at a ${peeled || type}, not a commit, so its object has no path in a commit tree`,
          );
        }
      }
      const tips = ['--branches', '--tags', '--remotes'];
      const accounted = new Set(git(gitDir, ['rev-list', '--objects', '--no-object-names', ...tips]).split('\n'));
      const named = git(gitDir, ['rev-list', '--all', '--reflog']);
      if (named.trim()) {
        const diff = git(gitDir, ['diff-tree', '--stdin', '-r', '-z', '--root', '-m', '--no-renames'], named);
        let expectPath = false;
        for (const token of diff.split('\0')) {
          if (expectPath) record(gitDir, token);
          expectPath = token.startsWith(':');
        }
      }
      for (const entry of git(gitDir, ['ls-files', '-z', '--stage']).split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab >= 0) record(gitDir, entry.slice(tab + 1));
      }
      const all = git(gitDir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n');
      const loose = all.filter((oid) => oid && !accounted.has(oid)).length;
      if (loose > 0) {
        unreachable += loose;
        issues.push(
          `${label}: ${loose} object(s) with no path in any branch or tag commit tree (dangling, reflog-only, staged or path-less) that could hold a protected file`,
        );
      }
    } catch (error) {
      issues.push(`${label}: could not scan, ${String(/** @type {Error} */ (error).message).split('\n')[0]}`);
    }
  }
  const protectedPaths = [...found];
  if (protectedPaths.length > 0) {
    issues.unshift(`protected paths in git (index or any commit): ${protectedPaths.join(', ')}. ${REMEDIATION}`);
  }
  if (unreachable > 0 || issues.some((issue) => issue.includes('reflog'))) issues.push(REMEDIATION);
  return { clean: issues.length === 0, protectedPaths, unreachable, issues, units: units.size };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('usage: node git-scan.mjs <repo>');
    process.exit(2);
  }
  console.log(JSON.stringify(scanRepo(repo)));
}
