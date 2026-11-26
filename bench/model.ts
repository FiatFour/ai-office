import type { FileEdit } from '../server/githost/host.ts';

export type ArmName = 'factory' | 'baseline';
export type Outcome = 'pass' | 'fail' | 'timeout' | 'error';
export type Flag = 'contaminated' | 'suspect';
export type Reporter = 'vitest' | 'node-test';
export const REPORTERS: readonly Reporter[] = ['vitest', 'node-test'];

export interface TaskA {
  readonly set: 'A';
  readonly id: string;
  readonly repo: string;
  readonly issue: number;
  readonly title: string;
  readonly body: string;
  readonly fixSha: string;
  readonly hiddenPaths: readonly string[];
  readonly specs: readonly string[];
  readonly installCommand: readonly string[] | null;
  readonly testCommand: readonly string[];
  readonly reporter: Reporter;
  readonly image: string;
  readonly timeoutMs: number;
  readonly confirmed: boolean;
}

export interface TaskB {
  readonly set: 'B';
  readonly id: string;
  readonly repo: string;
  readonly pr: number;
  readonly readyHeadSha: string;
  readonly confirmed: boolean;
}

export type Task = TaskA | TaskB;

export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export interface Change {
  readonly files: readonly FileEdit[];
  readonly deleted: readonly string[];
}

export interface Row {
  readonly task: string;
  readonly set: 'A' | 'B';
  readonly arm: ArmName;
  readonly scripted: boolean;
  readonly run: number;
  readonly outcome: Outcome;
  readonly reviewRounds: number | null;
  readonly wallMs: number;
  /** Set B: the part of `wallMs` during which CI of the arm's PR was running. Null or absent when unknown. */
  readonly ciWaitMs?: number | null;
  readonly agentMs: number;
  readonly prepareMs: number;
  readonly tokens: Tokens | null;
  readonly flag: Flag | null;
  readonly quotaWindows: number | null;
  readonly humanMinutes: number | null;
  readonly editLines?: number | null;
  readonly judgeMinutes?: number | null;
  readonly rootMinutes?: number | null;
  readonly judgeAttempts?: number | null;
  readonly inferredWindows?: number | null;
  readonly note: string;
}

export class TaskRefused extends Error {}

const text = (o: Record<string, unknown>, key: string, where: string): string => {
  const value = o[key];
  if (typeof value !== 'string' || value === '') throw new TaskRefused(`${where}: ${key} must be a non-empty string`);
  return value;
};

const int = (o: Record<string, unknown>, key: string, where: string): number => {
  const value = o[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TaskRefused(`${where}: ${key} must be a positive integer`);
  return value as number;
};

const argv = (o: Record<string, unknown>, key: string, where: string): string[] => {
  const value = o[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v === ''))
    throw new TaskRefused(`${where}: ${key} must be a non-empty list of strings`);
  return value as string[];
};

const SAFE_REL = /^(?![/\\])(?!.*(^|[/\\])\.\.([/\\]|$))[^\0]+$/;

export const parseTask = (raw: unknown, file: string): Task => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TaskRefused(`${file}: not an object`);
  const o = raw as Record<string, unknown>;
  const id = text(o, 'id', file);
  const where = `task ${id}`;
  const confirmed = o.confirmed === true;
  if (o.set === 'B')
    return {
      set: 'B',
      id,
      repo: text(o, 'repo', where),
      pr: int(o, 'pr', where),
      readyHeadSha: text(o, 'readyHeadSha', where),
      confirmed,
    };
  if (o.set !== 'A') throw new TaskRefused(`${where}: set must be A or B`);
  if (
    typeof o.fixSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(o.fixSha) ||
    !Array.isArray(o.hiddenPaths) ||
    o.hiddenPaths.length === 0
  )
    throw new TaskRefused(
      `${where} names no hidden-test commit: it needs a 40 hex fixSha and at least one hiddenPaths entry, so the harness cannot grade it`,
    );
  const hiddenPaths = o.hiddenPaths.map((p) => {
    if (typeof p !== 'string' || !SAFE_REL.test(p))
      throw new TaskRefused(`${where}: hiddenPaths entry ${String(p)} is not a safe relative path`);
    return p;
  });
  const specs = argv(o, 'specs', where);
  const reporter = REPORTERS.find((r) => r === o.reporter);
  if (reporter === undefined) throw new TaskRefused(`${where}: reporter must be one of ${REPORTERS.join(', ')}`);
  return {
    set: 'A',
    id,
    repo: text(o, 'repo', where),
    issue: int(o, 'issue', where),
    title: text(o, 'title', where),
    body: typeof o.body === 'string' ? o.body : '',
    fixSha: o.fixSha,
    hiddenPaths,
    specs,
    installCommand:
      o.installCommand === null || o.installCommand === undefined ? null : argv(o, 'installCommand', where),
    testCommand: argv(o, 'testCommand', where),
    reporter,
    image: text(o, 'image', where),
    timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : 1_800_000,
    confirmed,
  };
};

export const totalTokens = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheCreation;
