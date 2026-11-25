import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ticketOf } from '../arms-live.ts';
import { TaskRefused, type Tokens } from '../model.ts';
import { baseNameOf, branchOf, hiddenTask } from './arms.ts';
import type { SetBTask } from './task.ts';

export const ARMS = ['factory', 'baseline'] as const;
export type Arm = (typeof ARMS)[number];

/** `transient` is a provider overload or rate limit: the arm is run again, up to a cap, and it says nothing about the arm. */
export type Status = 'done' | 'failed' | 'quota' | 'transient' | 'auth' | 'aborted';

export interface RunRecord {
  readonly task: string;
  readonly arm: Arm;
  readonly status: Status;
  readonly stage: number;
  readonly branch: string | null;
  readonly pr: number | null;
  readonly readyHeadSha: string | null;
  readonly wallMs: number;
  readonly tokens: Tokens | null;
  readonly reviewRounds: number | null;
  readonly note: string;
  readonly startedAt: string;
  readonly resetAt: string | null;
  readonly baseSha: string;
}

/** The first line of the journal: the base the whole run is pinned to. It never changes after the first live PR. */
export interface Header {
  readonly kind: 'header';
  readonly baseSha: string;
  readonly createdAt: string;
}

/** Written (and fsynced) before the first remote write of an arm, so a kill at any later point leaves a record of what to find. */
export interface Intent {
  readonly kind: 'intent';
  readonly task: string;
  readonly arm: Arm;
  readonly salt: string;
  readonly branch: string;
  readonly base: string;
  readonly baseSha: string;
  readonly at: string;
}

export interface Journal {
  readonly header: Header | null;
  readonly intents: readonly Intent[];
  readonly runs: readonly RunRecord[];
  /** The text after the last newline when it is not a whole JSON line: an append that a crash cut short. */
  readonly torn: string | null;
}

const parses = (line: string): boolean => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

const textOf = (file: string): { whole: string; tail: string } => {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const end = text.lastIndexOf('\n') + 1;
  return { whole: text.slice(0, end), tail: text.slice(end) };
};

const writeDurably = (file: string, text: string): void => {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Moves a torn last line to `<file>.torn` and cuts it from the journal, so the next append does not glue onto it. Returns the
 * moved text, or null when the journal ends cleanly. An intent is on disk in full before any remote write, so a torn intent
 * line has no remote write behind it.
 */
export const setAsideTorn = (file: string): string | null => {
  const { whole, tail } = textOf(file);
  if (tail === '' || parses(tail)) return null;
  writeDurably(`${file}.torn`, `${tail}\n`);
  truncateSync(file, Buffer.byteLength(whole));
  return tail;
};

/** Appends one JSON line and forces it to disk before returning. */
export const appendLine = (file: string, value: object): void => {
  mkdirSync(dirname(file), { recursive: true });
  setAsideTorn(file);
  const gap = textOf(file).tail === '' ? '' : '\n';
  writeDurably(file, `${gap}${JSON.stringify(value)}\n`);
};

export const readJournal = (file: string): Journal => {
  const { whole, tail } = textOf(file);
  const torn = tail !== '' && !parses(tail) ? tail : null;
  const lines = `${whole}${torn === null ? tail : ''}`
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { kind?: string });
  return {
    header: (lines.find((l) => l.kind === 'header') as Header | undefined) ?? null,
    intents: lines.filter((l) => l.kind === 'intent') as unknown as Intent[],
    runs: lines.filter((l) => l.kind === undefined || l.kind === 'run') as unknown as RunRecord[],
    torn,
  };
};

export const readRuns = (file: string): RunRecord[] => [...readJournal(file).runs];

export const appendRun = (file: string, record: RunRecord): void => appendLine(file, record);

/** Refuses a base sha that differs from the header's, and a header that differs from any intent or run record. */
export const checkBase = (file: string, baseSha: string): void => {
  const { header, intents, runs } = readJournal(file);
  if (header !== null && header.baseSha !== baseSha)
    throw new TaskRefused(`${file} is pinned to base ${header.baseSha}, not ${baseSha}; the base never moves`);
  const other = [...intents, ...runs].find((r) => r.baseSha !== baseSha);
  if (header !== null && other !== undefined)
    throw new TaskRefused(
      `${file} says base ${header.baseSha} in its header, but a record for ${other.task} ${other.arm} says ${other.baseSha}`,
    );
};

/**
 * Pins the journal to one base sha. A new journal gets a header; an existing one must name the same sha, so the base is never
 * moved after the first live PR.
 */
export const pinBase = (file: string, baseSha: string, now: () => Date = () => new Date()): void => {
  const { header, intents, runs } = readJournal(file);
  if (header !== null) {
    checkBase(file, baseSha);
    return;
  }
  if (intents.length > 0 || runs.length > 0)
    throw new TaskRefused(`${file} has records but no header, so its base sha is unknown`);
  appendLine(file, { kind: 'header', baseSha, createdAt: now().toISOString() } satisfies Header);
};

export const newSalt = (): string => randomBytes(4).toString('hex');

export const intentOf = (task: SetBTask, arm: Arm, salt: string, baseSha: string, at: Date): Intent => {
  const ticket = ticketOf(hiddenTask(task, salt) as never, 1);
  return {
    kind: 'intent',
    task: task.id,
    arm,
    salt,
    branch: branchOf(ticket.id),
    base: baseNameOf(ticket.id),
    baseSha,
    at: at.toISOString(),
  };
};

/**
 * The intent of this task and arm: the one already journaled (so a resume reuses the same salt, branch and base), or a new one
 * written and fsynced before the caller makes a remote write.
 */
export const claimIntent = (
  file: string,
  task: SetBTask,
  arm: Arm,
  baseSha: string,
  mint: () => string = newSalt,
  now: () => Date = () => new Date(),
): { intent: Intent; resumed: boolean } => {
  const prior = readJournal(file).intents.findLast((i) => i.task === task.id && i.arm === arm);
  if (prior !== undefined) return { intent: prior, resumed: true };
  const intent = intentOf(task, arm, mint(), baseSha, now());
  appendLine(file, intent);
  return { intent, resumed: false };
};

/** `done` and `failed` are final: a failed arm is not retried. The other statuses say nothing about the arm and run again. */
export const isFinal = (r: RunRecord): boolean => r.status === 'done' || r.status === 'failed';

export const TRANSIENT_CAP = 3;

export const transientCount = (runs: readonly RunRecord[], task: string, arm: Arm): number =>
  runs.filter((r) => r.task === task && r.arm === arm && r.status === 'transient').length;
