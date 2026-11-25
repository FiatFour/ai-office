import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The repository that holds the frozen commit: `root` when it has it, otherwise a fresh repo at `scratch()` that
 * fetched that one commit from origin (`--depth=1`, which GitHub allows for a reachable sha). A failed fetch throws:
 * there is no fall back to the working tree.
 */
export const frozenBaseRepo = (root: string, sha: string, git: Git, scratch: () => string): string => {
  if (git(root, ['cat-file', '-e', `${sha}^{commit}`]).status === 0) return root;
  const origin = git(root, ['remote', 'get-url', 'origin']);
  if (origin.status !== 0)
    throw new Error(`the frozen commit ${sha} is not in this clone and it has no origin to fetch it from`);
  const dir = scratch();
  for (const args of [
    ['init', '-q'],
    ['fetch', '-q', '--depth=1', origin.stdout.trim(), sha],
  ]) {
    const ran = git(dir, args);
    if (ran.status !== 0)
      throw new Error(`the frozen commit ${sha} is not in this clone and git ${args[0]} failed: ${ran.stderr.trim()}`);
  }
  return dir;
};
