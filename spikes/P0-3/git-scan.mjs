import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

const GIT_SHAPE = ['HEAD', 'objects', 'refs'];
const HEX2 = /^[0-9a-f]{2}$/;
const HEX38 = /^[0-9a-f]{38}$/;
const TMP_NAME = /^tmp_(obj|pack|idx|rev|bitmap|mtimes)_\w+$/;
const PACK_NAME = /^pack-[0-9a-f]{40,64}\.(pack|idx|rev|bitmap|mtimes|keep|promisor)$/;
const TOP_FILES = new Set([
  'HEAD',
  'config',
  'config.worktree',
  'description',
  'packed-refs',
  'index',
  'commondir',
  'gitdir',
  'shallow',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'AUTO_MERGE',
  'COMMIT_EDITMSG',
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'SQUASH_MSG',
  'TAG_EDITMSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'NOTES_MERGE_REF',
  'BISECT_LOG',
  'BISECT_START',
  'BISECT_TERMS',
  'BISECT_EXPECTED_REV',
  'BISECT_ANCESTORS_OK',
  'BISECT_NAMES',
]);
const TOP_FILE_PATTERNS = [/\.lock$/, /^sharedindex\.[0-9a-f]+$/];
const TOP_DIRS = new Set([
  'hooks',
  'info',
  'objects',
  'refs',
  'logs',
  'branches',
  'modules',
  'worktrees',
  'rr-cache',
  'sequencer',
  'rebase-merge',
  'rebase-apply',
  'lost-found',
]);
const REFS_DIRS = new Set(['heads', 'tags', 'remotes', 'notes', 'replace', 'original', 'bisect', 'rewritten']);
const INFO_FILES = new Set(['exclude', 'refs', 'attributes', 'sparse-checkout', 'grafts']);
const OBJECT_INFO_FILES = new Set(['packs', 'commit-graph', 'alternates', 'http-alternates']);
const OBJECT_INFO_GRAPH_FILE = /^(commit-graph-chain|graph-[0-9a-f]+\.graph|commit-graph-chain\.lock)$/;
const MIDX_FILE = /^multi-pack-index(-[0-9a-f]+\.(midx|rev)|-chain)?$/;

/** @param {import('node:fs').Dirent[]} entries @param {string} name @param {'file' | 'dir'} kind */
const has = (entries, name, kind) =>
  entries.some((entry) => entry.name === name && (kind === 'dir' ? entry.isDirectory() : entry.isFile()));

/** @param {string} path */
const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT';
  }
};

/**
 * Lists a git dir by name only, never reading file contents, and returns what in it is not a known git dir entry.
 * objects/ holds 2-hex dirs of 38-hex files, pack and info; pack/ holds pack-<hex> files and git's tmp names; no
 * other subdirectory or file name is tolerated there, nor in the other fixed dirs of a git dir.
 * @param {string} gitDir
 * @param {(path: string) => import('node:fs').Dirent[] | null} list
 * @returns {string[]}
 */
const unknownEntries = (gitDir, list) => {
  /** @type {string[]} */
  const unknown = [];
  /** @param {string} path @param {import('node:fs').Dirent[] | null} entries @param {(entry: import('node:fs').Dirent) => boolean} accepts */
  const check = (path, entries, accepts) => {
    for (const entry of entries ?? []) {
      if (!accepts(entry)) unknown.push(`${relative(gitDir, join(path, entry.name))}`);
    }
  };
  const file = (/** @type {import('node:fs').Dirent} */ entry) => entry.isFile();
  check(gitDir, list(gitDir), (entry) =>
    entry.isDirectory()
      ? TOP_DIRS.has(entry.name)
      : file(entry) && (TOP_FILES.has(entry.name) || TOP_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))),
  );
  const sub = (/** @type {string[]} */ ...parts) => join(gitDir, ...parts);
  check(sub('objects'), list(sub('objects')), (entry) =>
    entry.isDirectory()
      ? HEX2.test(entry.name) || entry.name === 'pack' || entry.name === 'info'
      : file(entry) && TMP_NAME.test(entry.name),
  );
  for (const dir of (list(sub('objects')) ?? []).filter((entry) => entry.isDirectory() && HEX2.test(entry.name))) {
    check(
      sub('objects', dir.name),
      list(sub('objects', dir.name)),
      (entry) => file(entry) && (HEX38.test(entry.name) || TMP_NAME.test(entry.name)),
    );
  }
  check(sub('objects', 'pack'), list(sub('objects', 'pack')), (entry) =>
    entry.isDirectory()
      ? entry.name === 'multi-pack-index.d'
      : file(entry) && (PACK_NAME.test(entry.name) || TMP_NAME.test(entry.name) || MIDX_FILE.test(entry.name)),
  );
  check(
    sub('objects', 'pack', 'multi-pack-index.d'),
    list(sub('objects', 'pack', 'multi-pack-index.d')),
    (entry) => file(entry) && MIDX_FILE.test(entry.name),
  );
  check(sub('objects', 'info'), list(sub('objects', 'info')), (entry) =>
    entry.isDirectory() ? entry.name === 'commit-graphs' : file(entry) && OBJECT_INFO_FILES.has(entry.name),
  );
  check(
    sub('objects', 'info', 'commit-graphs'),
    list(sub('objects', 'info', 'commit-graphs')),
    (entry) => file(entry) && OBJECT_INFO_GRAPH_FILE.test(entry.name),
  );
  check(sub('info'), list(sub('info')), (entry) => file(entry) && INFO_FILES.has(entry.name));
  check(sub('hooks'), list(sub('hooks')), file);
  check(sub('branches'), list(sub('branches')), file);
  check(sub('logs'), list(sub('logs')), (entry) =>
    entry.name === 'HEAD' ? file(entry) : entry.name === 'refs' && entry.isDirectory(),
  );
  check(sub('refs'), list(sub('refs')), (entry) =>
    entry.isDirectory() ? REFS_DIRS.has(entry.name) : file(entry) && entry.name === 'stash',
  );
  return unknown;
};

/**
 * Finds git dirs by structure (a dir holding a HEAD file, an objects dir and a refs dir), never by name, without
 * following symlinks and without running git. A HEAD, objects or refs that is a symlink, a git dir nested in another
 * git dir (outside modules/), a pack dir holding .pack files and a dir of 2-hex dirs holding 38-hex files are
 * findings. The last two are heuristics. Anything it cannot read or bound lands in issues.
 * @param {string} repo
 * @param {number} cap
 * @returns {Discovery}
 */
const discover = (repo, cap) => {
  /** @type {Discovery} */
  const found = { units: [], pointers: [], dotGit: [], issues: [] };
  const pending = [repo];
  const stores = new Set();
  let seen = 0;
  while (pending.length > 0) {
    const dir = /** @type {string} */ (pending.pop());
    const label = relative(repo, dir) || '.';
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
    const shape = entries.filter((entry) => GIT_SHAPE.includes(entry.name));
    const linked = shape.filter((entry) => entry.isSymbolicLink());
    if (shape.length >= 2 && linked.length > 0) {
      found.issues.push(
        `${label}: ${linked.map((entry) => entry.name).join(', ')} is a symlink in what looks like a git dir, so what it holds cannot be bounded`,
      );
    }
    const isUnit = has(entries, 'HEAD', 'file') && has(entries, 'objects', 'dir') && has(entries, 'refs', 'dir');
    if (isUnit) {
      found.units.push(dir);
      const unknown = unknownEntries(dir, (path) => {
        try {
          const listed = readdirSync(path, { withFileTypes: true });
          seen += listed.length;
          return listed;
        } catch (error) {
          const code = /** @type {NodeJS.ErrnoException} */ (error).code;
          if (code !== 'ENOENT') found.issues.push(`could not scan ${path}, the directory is unreadable (${code})`);
          return null;
        }
      });
      if (seen > cap) {
        found.issues.push(`${repo} is too large to scan for git dirs (cap ${cap} entries)`);
        return found;
      }
      if (unknown.length > 0) {
        found.issues.push(
          `${label}: ${unknown.length} entr${unknown.length === 1 ? 'y is' : 'ies are'} not part of a git dir's layout (${unknown.slice(0, 5).join(', ')}), so what they hold cannot be bounded`,
        );
      }
    }
    if (
      !isUnit &&
      basename(dir) === 'pack' &&
      entries.some((entry) => entry.isFile() && entry.name.endsWith('.pack'))
    ) {
      found.issues.push(`${label}: holds .pack files outside any git dir the scan identified (heuristic)`);
    }
    if (!isUnit && HEX2.test(basename(dir)) && entries.some((entry) => entry.isFile() && HEX38.test(entry.name))) {
      stores.add(dirname(dir));
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === '.git') {
        if (entry.isFile()) found.pointers.push(path);
        else if (entry.isDirectory()) found.dotGit.push(path);
        else
          found.issues.push(`${relative(repo, path)} is neither a git dir nor a gitdir file, so it cannot be bounded`);
      }
      if (!entry.isDirectory()) continue;
      if (!(isUnit && entry.name === 'objects')) pending.push(path);
    }
  }
  for (const store of stores) {
    found.issues.push(
      `${relative(repo, store) || '.'}: looks like a loose object store (2-hex dirs holding 38-hex files) outside any git dir the scan identified (heuristic)`,
    );
  }
  for (const unit of found.units) {
    const parent = found.units.find((other) => unit.startsWith(`${other}/`));
    if (parent && !relative(parent, unit).startsWith('modules/')) {
      found.issues.push(
        `${relative(repo, unit)} is a git dir nested inside the git dir ${relative(repo, parent) || '.'}`,
      );
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
        if (exists(join(gitDir, ...file))) {
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
