import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TaskRefused } from '../model.ts';
import { ownerOf } from './owned.ts';

export const SET_B_REPO = 'FiatFour/ai-office';
export const SET_B_SIZE = 10;
const ISSUES = new Set([...Array.from({ length: 18 }, (_, i) => i + 7), 29, 30]);
const CHECKS = ['reproduced', 'read'] as const;
export type Check = (typeof CHECKS)[number];

export interface SetBTask {
  readonly id: string;
  readonly issue: number;
  readonly item: string;
  readonly title: string;
  readonly body: string;
  readonly files: readonly string[];
  readonly testCommand: readonly string[];
  readonly check: Check;
}

export interface TaskList {
  readonly repo: string;
  readonly frozenAtSha: string;
  readonly tasks: readonly SetBTask[];
}

const text = (o: Record<string, unknown>, key: string, where: string): string => {
  const value = o[key];
  if (typeof value !== 'string' || value.trim() === '')
    throw new TaskRefused(`${where}: ${key} must be non-empty text`);
  return value;
};

const strings = (o: Record<string, unknown>, key: string, where: string): string[] => {
  const value = o[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v === ''))
    throw new TaskRefused(`${where}: ${key} must be a non-empty list of strings`);
  return value as string[];
};

const DOCKER = /(^|[/\s])(docker|podman)(\.exe)?($|\s)/i;

const parseTask = (raw: unknown): SetBTask => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TaskRefused('a task is not an object');
  const o = raw as Record<string, unknown>;
  const id = text(o, 'id', 'a task');
  const where = `task ${id}`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new TaskRefused(`${where}: id must be lowercase letters, digits, dashes`);
  const issue = o.issue;
  if (typeof issue !== 'number' || !ISSUES.has(issue))
    throw new TaskRefused(`${where}: issue must be one of #7 to #24, #29, #30`);
  const files = strings(o, 'files', where);
  const testCommand = strings(o, 'testCommand', where);
  for (const file of [...files, ...testCommand]) {
    const owner = ownerOf(file);
    if (owner !== null) throw new TaskRefused(`${where}: ${file} is owned by ${owner}, a wave 2 ticket`);
  }
  if (DOCKER.test(testCommand.join(' '))) throw new TaskRefused(`${where}: the test command needs a container engine`);
  const check = CHECKS.find((c) => c === o.check);
  if (check === undefined) throw new TaskRefused(`${where}: check must be ${CHECKS.join(' or ')}`);
  return {
    id,
    issue,
    item: text(o, 'item', where),
    title: text(o, 'title', where),
    body: text(o, 'body', where),
    files,
    testCommand,
    check,
  };
};

export const parseTaskList = (raw: unknown): TaskList => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new TaskRefused('tasks.json is not an object');
  const o = raw as Record<string, unknown>;
  if (o.repo !== SET_B_REPO) throw new TaskRefused(`Set B targets ${SET_B_REPO}, not ${String(o.repo)}`);
  const frozenAtSha = text(o, 'frozenAtSha', 'tasks.json');
  if (!/^[0-9a-f]{40}$/.test(frozenAtSha)) throw new TaskRefused('frozenAtSha must be 40 hex characters');
  if (!Array.isArray(o.tasks)) throw new TaskRefused('tasks must be a list');
  const tasks = o.tasks.map(parseTask);
  if (tasks.length !== SET_B_SIZE) throw new TaskRefused(`Set B has exactly ${SET_B_SIZE} tasks, got ${tasks.length}`);
  const seen = new Set<string>();
  for (const t of tasks) {
    const key = `${t.issue}/${t.item}`;
    if (seen.has(t.id) || seen.has(key)) throw new TaskRefused(`task ${t.id} repeats an id or an issue item`);
    seen.add(t.id);
    seen.add(key);
  }
  return { repo: o.repo, frozenAtSha, tasks };
};

export const shaOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export const TASKS_FILE = 'tasks.json';
export const SHA_FILE = 'tasks.sha256';

export const loadFrozen = (dir: string): TaskList => {
  const bytes = readFileSync(join(dir, TASKS_FILE));
  const frozen = readFileSync(join(dir, SHA_FILE), 'utf8').trim();
  if (shaOf(bytes) !== frozen)
    throw new TaskRefused(
      `${TASKS_FILE} changed after it was frozen: its sha is ${shaOf(bytes)}, the record says ${frozen}`,
    );
  return parseTaskList(JSON.parse(bytes.toString('utf8')));
};

export interface GitRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type Git = (cwd: string, args: readonly string[]) => GitRun;

const LOCAL_URL = /^(file:|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/;
/** A remote that is a path or a file URL: a clone of a clone, which may itself be shallow. */
export const isLocalRemote = (url: string): boolean => LOCAL_URL.test(url);

/**
 * The repository that holds the frozen commit: `root` when it has it, otherwise a fresh repo at `scratch()` that
 * fetched that one commit (`--depth=1`, which GitHub allows for a reachable sha). Where it fetches from, in order:
 * `AW_FROZEN_REMOTE` when set (and only that); else origin when origin is not a local path; else, when origin is a
 * local path (a CI clone of the shallow checkout, which cannot serve a sha it lacks), the public repository named by
 * `GITHUB_SERVER_URL` and `GITHUB_REPOSITORY`, then origin's own origin up the chain, then origin itself. A failed fetch
 * from every candidate throws with each reason: there is no fall back to the working tree.
 */
export const frozenBaseRepo = (
  root: string,
  sha: string,
  git: Git,
  scratch: () => string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  if (git(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0) return root;
  const candidates: string[] = [];
  const forced = env.AW_FROZEN_REMOTE?.trim();
  if (forced !== undefined && forced !== '') candidates.push(forced);
  else {
    const origin = git(root, ['remote', 'get-url', 'origin']);
    if (origin.status !== 0)
      throw new Error(`the frozen commit ${sha} is not in this clone and it has no origin to fetch it from`);
    let url = origin.stdout.trim();
    const chain: string[] = [url];
    for (let hop = 0; isLocalRemote(url) && hop < 5; hop += 1) {
      const up = git(resolve(root, url.replace(/^file:\/\//, '')), ['remote', 'get-url', 'origin']);
      if (up.status !== 0 || up.stdout.trim() === '') break;
      url = up.stdout.trim();
      chain.push(url);
    }
    const server = env.GITHUB_SERVER_URL?.trim();
    const repo = env.GITHUB_REPOSITORY?.trim();
    const github = server && repo ? [`${server.replace(/\/+$/, '')}/${repo}.git`] : [];
    const first = chain[0] ?? '';
    candidates.push(...(isLocalRemote(first) ? [...github, ...chain.slice(1), first] : [first]));
  }
  const dir = scratch();
  const init = git(dir, ['init', '-q']);
  if (init.status !== 0)
    throw new Error(`the frozen commit ${sha} is not in this clone and git init failed: ${init.stderr.trim()}`);
  const reasons: string[] = [];
  for (const remote of [...new Set(candidates)]) {
    const ran = git(dir, ['fetch', '-q', '--depth=1', remote, sha]);
    if (ran.status === 0) return dir;
    reasons.push(`${remote}: ${ran.stderr.trim()}`);
  }
  throw new Error(`the frozen commit ${sha} is not in this clone and git fetch failed: ${reasons.join('; ')}`);
};
