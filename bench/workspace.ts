import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { FileEdit } from '../server/githost/host.ts';
import { type RunResult, runBinary } from '../server/sandbox/engine.ts';
import { type Change, type TaskA, TaskRefused } from './model.ts';
import { isTestSide, normal, protectedReason } from './protected.ts';
import type { Runner } from './runner.ts';

const INSTALL_TIMEOUT_MS = 900_000;

export interface Prepared {
  readonly prepareMs: number;
  readonly dir: string;
  readonly source: string;
  readonly hidden: string;
  readonly installed: string;
  readonly baseSha: string;
  readonly mirror: string;
}

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

const git = async (cwd: string, args: readonly string[], input?: string): Promise<RunResult> =>
  runBinary('git', ['-C', cwd, ...args], { env: GIT_ENV, ...(input === undefined ? {} : { input }) });

const must = async (cwd: string, args: readonly string[]): Promise<string> => {
  const ran = await git(cwd, args);
  if (ran.code !== 0) throw new TaskRefused(`git ${args.join(' ')} failed: ${ran.err.trim().slice(-300)}`);
  return ran.out;
};

export const insideOf = (root: string, rel: string): string => {
  const full = resolve(root, rel);
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep))
    throw new TaskRefused(`${rel} leaves the workspace`);
  if (rel.split(/[\\/]/).includes('.git')) throw new TaskRefused(`${rel} is inside .git`);
  return full;
};

export const readTree = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return readTree(full, base);
    return entry.isFile() ? [full.slice(base.length + 1)] : [];
  });

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export const sealedProblems = (tree: string, hidden: string, hiddenPaths: readonly string[]): string[] => {
  const problems: string[] = [];
  const seen = new Map(readTree(tree).map((rel) => [digest(join(tree, rel)), rel]));
  for (const rel of hiddenPaths) {
    const copy = join(hidden, rel);
    if (!existsSync(copy)) {
      problems.push(`the hidden copy of ${rel} is missing`);
      continue;
    }
    const twin = seen.get(digest(copy));
    if (twin !== undefined) problems.push(`hidden test ${rel} is present in the cage tree as ${twin}`);
  }
  return problems;
};

export const gitProblems = async (source: string, fixSha: string): Promise<string[]> => {
  const problems: string[] = [];
  const count = (await git(source, ['rev-list', '--all', '--count'])).out.trim();
  if (count !== '1') problems.push(`the cage source has ${count} commits, not 1`);
  if ((await git(source, ['cat-file', '-e', `${fixSha}^{commit}`])).code === 0)
    problems.push('the fix commit is reachable from the cage source');
  const refs = (await git(source, ['for-each-ref', '--format=%(refname)'])).out.trim().split('\n').filter(Boolean);
  if (refs.some((ref) => ref.startsWith('refs/remotes/') || ref.startsWith('refs/tags/')))
    problems.push('the cage source keeps remote or tag refs');
  return problems;
};

const UPSTREAM_FIELDS = ['repository', 'homepage', 'bugs'];

export const neutralisePackage = (dir: string): void => {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return;
  const meta = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  for (const key of UPSTREAM_FIELDS) delete meta[key];
  writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
};

const versionOf = (text: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};

const newerThan = (found: string, base: string): boolean => {
  const a = versionOf(found);
  const b = versionOf(base);
  if (a === null || b === null) return true;
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;

const contentProblems = (
  where: string,
  copy: string,
  installed: string,
  hiddenDigests: ReadonlyMap<string, string>,
  sameVersion: boolean,
): string[] => {
  const problems: string[] = [];
  for (const rel of readTree(copy)) {
    const mine = digest(join(copy, rel));
    const planted = hiddenDigests.get(mine);
    if (planted !== undefined) problems.push(`${where}/${normal(rel)} is a copy of the hidden test ${planted}`);
    const own = join(installed, rel);
    if (sameVersion && SOURCE_FILE.test(rel) && existsSync(own) && digest(own) !== mine)
      problems.push(`${where}/${normal(rel)} differs from the same file in the base tree, so the copy is not the base`);
  }
  return problems;
};

export const installedProblems = (installed: string, hidden: string | null = null): string[] => {
  const file = join(installed, 'package.json');
  if (!existsSync(file)) return [];
  const own = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
  if (typeof own.name !== 'string') return [];
  const base = typeof own.version === 'string' ? own.version : '';
  const modules = join(installed, 'node_modules');
  const copies: Array<{ where: string; version: string; dir: string | null }> = [];
  const top = join(modules, ...own.name.split('/'));
  if (existsSync(join(top, 'package.json')))
    copies.push({
      where: `node_modules/${own.name}`,
      version: (JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')) as { version?: string }).version ?? '',
      dir: top,
    });
  const store = join(modules, '.pnpm');
  const prefix = `${own.name.replace('/', '+')}@`;
  if (existsSync(store))
    for (const entry of readdirSync(store))
      if (entry.startsWith(prefix)) {
        const dir = join(store, entry, 'node_modules', ...own.name.split('/'));
        copies.push({
          where: `node_modules/.pnpm/${entry}`,
          version: entry.slice(prefix.length),
          dir: existsSync(dir) ? dir : null,
        });
      }
  const hiddenDigests = new Map(hidden === null ? [] : readTree(hidden).map((rel) => [digest(join(hidden, rel)), rel]));
  return copies.flatMap(({ where, version, dir }) =>
    newerThan(version, base)
      ? [`${where} is ${version || 'of unknown version'}, newer than the base ${base}, so it may hold the fix`]
      : dir === null
        ? []
        : contentProblems(where, dir, installed, hiddenDigests, version === base),
  );
};

export interface PrepareOptions {
  readonly cache: string;
  readonly repoUrl: (repo: string) => string;
  readonly runner: Runner;
}

export const mirrorPath = (cache: string, repo: string): string =>
  join(cache, 'mirrors', `${repo.replace('/', '__')}.git`);

const mirrorOf = async (task: TaskA, options: PrepareOptions): Promise<string> => {
  const mirror = mirrorPath(options.cache, task.repo);
  if (!existsSync(mirror)) {
    mkdirSync(dirname(mirror), { recursive: true });
    const cloned = await runBinary('git', ['clone', '--quiet', '--bare', options.repoUrl(task.repo), mirror], {
      env: GIT_ENV,
    });
    if (cloned.code !== 0) throw new TaskRefused(`clone of ${task.repo} failed: ${cloned.err.trim().slice(-300)}`);
  }
  return mirror;
};

export const prepareTask = async (task: TaskA, options: PrepareOptions): Promise<Prepared> => {
  const started = performance.now();
  const dir = join(options.cache, 'tasks', task.id);
  rmSync(dir, { recursive: true, force: true });
  const source = join(dir, 'source');
  const hidden = join(dir, 'hidden');
  mkdirSync(source, { recursive: true });
  mkdirSync(hidden, { recursive: true });
  const mirror = await mirrorOf(task, options);
  if ((await git(mirror, ['cat-file', '-e', `${task.fixSha}^{commit}`])).code !== 0)
    throw new TaskRefused(`task ${task.id}: ${task.fixSha} is not a commit of ${task.repo}`);
  const parents = (await must(mirror, ['rev-list', '--parents', '-n', '1', task.fixSha])).trim().split(' ');
  if (parents.length !== 2)
    throw new TaskRefused(
      `task ${task.id}: ${task.fixSha} has ${parents.length - 1} parents, the harness needs exactly 1`,
    );
  const baseSha = parents[1] ?? '';
  const changed = new Set(
    (await must(mirror, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', baseSha, task.fixSha]))
      .split('\n')
      .filter(Boolean),
  );
  for (const rel of task.hiddenPaths) {
    if (!changed.has(rel)) throw new TaskRefused(`task ${task.id}: hidden path ${rel} is not in the fix commit`);
    const out = await runBinary('git', ['-C', mirror, 'show', `${task.fixSha}:${rel}`], { env: GIT_ENV });
    if (out.code !== 0) throw new TaskRefused(`task ${task.id}: ${rel} does not exist in the fix commit`);
    const target = insideOf(hidden, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out.out);
  }
  const archive = join(dir, 'base.tar');
  const tar = await runBinary('sh', [
    '-c',
    `git -C "$0" archive --format=tar "$1" > "$2" && tar -xf "$2" -C "$3"`,
    mirror,
    baseSha,
    archive,
    source,
  ]);
  if (tar.code !== 0) throw new TaskRefused(`task ${task.id}: archive of ${baseSha} failed: ${tar.err.trim()}`);
  rmSync(archive);
  for (const rel of task.hiddenPaths) {
    const copy = join(hidden, rel);
    const atBase = (await git(mirror, ['cat-file', '-e', `${baseSha}:${rel}`])).code === 0;
    if (!atBase) rmSync(insideOf(source, rel), { force: true });
    else if (readFileSync(insideOf(source, rel)).equals(readFileSync(copy)))
      throw new TaskRefused(`task ${task.id}: ${rel} is identical before and after the fix, so it cannot be hidden`);
  }
  neutralisePackage(source);
  await must(source, ['init', '--quiet', '-b', 'main']);
  await must(source, ['add', '-A']);
  await must(source, [
    '-c',
    'user.name=agent-works-bench',
    '-c',
    'user.email=bench@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    `task ${task.id} base`,
  ]);
  const problems = [...sealedProblems(source, hidden, task.hiddenPaths), ...(await gitProblems(source, task.fixSha))];
  if (problems.length > 0) throw new TaskRefused(`task ${task.id} is not sealed: ${problems.join('; ')}`);
  const installed = join(dir, 'installed');
  cpSync(source, installed, { recursive: true, filter: (from) => !from.split(sep).includes('.git') });
  if (task.installCommand !== null) {
    const ran = await options.runner.run({
      argv: task.installCommand,
      cwd: installed,
      image: task.image,
      network: true,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (ran.code !== 0)
      throw new TaskRefused(`task ${task.id}: install failed: ${(ran.err || ran.out).trim().slice(-300)}`);
  }
  const stale = installedProblems(installed, hidden);
  if (stale.length > 0) throw new TaskRefused(`task ${task.id} is not sealed: ${stale.join('; ')}`);
  return { dir, source, hidden, installed, baseSha, mirror, prepareMs: Math.round(performance.now() - started) };
};

const listed = async (mirror: string, task: TaskA, filter: string): Promise<string[]> =>
  (
    await must(mirror, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      `--diff-filter=${filter}`,
      '-r',
      '--no-renames',
      '-z',
      `${task.fixSha}^`,
      task.fixSha,
    ])
  )
    .split('\0')
    .filter(
      (rel) => rel !== '' && !task.hiddenPaths.includes(rel) && protectedReason(rel) === null && !isTestSide(rel),
    );

export const fixChange = async (task: TaskA, mirror: string): Promise<Change> => {
  const files: FileEdit[] = [];
  for (const rel of await listed(mirror, task, 'AM'))
    files.push({ path: rel, content: await must(mirror, ['show', `${task.fixSha}:${rel}`]) });
  return { files, deleted: await listed(mirror, task, 'D') };
};
