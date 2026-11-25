import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runBinary } from '../../server/sandbox/engine.ts';
import { TaskRefused } from '../model.ts';
import { type Packet, renderPrompt, type Unreadable } from './packet.ts';
import { type Judgement, JudgeUnparseable, parseVerdict } from './rubric.ts';

export type Model = (prompt: string) => Promise<string>;

export interface Clock {
  now(): number;
}

export interface Judged extends Judgement {
  readonly label: string;
  readonly headSha: string;
  readonly judgeMinutes: number;
  readonly attempts?: number;
}

export const CALIBRATION_SIZE = 2;
/** Calls per packet: the first and two reruns. A packet still unreadable after that is recorded as unreadable. */
export const MAX_ATTEMPTS = 3;
/** Voided judge runs that end Set B: the third void is final, no fourth run is made. */
export const MAX_VOIDS = 3;

/**
 * One voids log per frozen run, named by the sha of the frozen task list, so no `--out` can start the count again. It is a
 * tracked `.jsonl` (not a gitignored `.log`): commit it with the run, so deleting it shows in `git status`.
 */
export const JUDGED_DIR = 'judged';

/** The only directories whose voided outputs count: the run directory and its fixed `judged` folder. */
export const voidScanDirs = (dir: string): string[] => [dir, join(dir, JUDGED_DIR)];

/** `--out` must sit in the fixed `judged` folder of the run directory, so no new directory can reset the count. */
export const judgedOutPath = (dir: string, out: string): string => {
  const folder = resolve(dir, JUDGED_DIR);
  const target = resolve(out);
  if (!target.endsWith('.json')) throw new TaskRefused(`--out must be a .json file, got ${out}`);
  if (dirname(target) !== folder) throw new TaskRefused(`--out must be a file directly inside ${folder}`);
  mkdirSync(folder, { recursive: true });
  return target;
};

export const voidsLogPath = (dir: string, frozenSha: string): string => join(dir, 'voids', `${frozenSha}.jsonl`);

const logLines = (file: string): number =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l !== '').length
    : 0;

/** The `--out` files of voided runs in these directories: a second record of the count, which `rm -rf voids` does not reach. */
const voidedOuts = (dirs: readonly string[]): number => {
  let n = 0;
  for (const dir of new Set(dirs.map((d) => resolve(d)))) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      try {
        const body = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { voided?: unknown; judged?: unknown } | null;
        if (body !== null && typeof body === 'object' && Array.isArray(body.judged) && typeof body.voided === 'string')
          n += 1;
      } catch {
        // not a judge output
      }
    }
  }
  return n;
};

/** The larger of the log's lines and the voided `--out` files found in `dirs`. */
export const countVoids = (file: string, dirs: readonly string[] = [dirname(dirname(file))]): number =>
  Math.max(logLines(file), voidedOuts(dirs));

export const recordVoid = (file: string, reason: string): number => {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, `${JSON.stringify({ reason })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return logLines(file);
};

export const refuseAfterVoids = (file: string, dirs?: readonly string[]): void => {
  const n = countVoids(file, dirs);
  if (n >= MAX_VOIDS)
    throw new TaskRefused(`${n} judge runs were void (the limit is ${MAX_VOIDS}), Set B is not run again`);
};

export interface JudgeRun {
  readonly voided: string | null;
  readonly judged: readonly Judged[];
  readonly unreadable: readonly Unreadable[];
}

export const judgeOne = async (model: Model, packet: Packet, clock: Clock = Date): Promise<Judged> => {
  const started = clock.now();
  const reply = await model(renderPrompt(packet));
  if (reply.trim() === '') throw new TaskRefused('the judge call returned nothing, which is a failed call');
  return {
    ...parseVerdict(reply, packet.diff),
    label: packet.label,
    headSha: packet.headSha,
    judgeMinutes: (clock.now() - started) / 60_000,
  };
};

export const runJudge = async (
  model: Model,
  real: readonly Packet[],
  seeded: readonly Packet[],
  clock: Clock = Date,
  unreadable: readonly Unreadable[] = [],
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<JudgeRun> => {
  if (seeded.length !== CALIBRATION_SIZE)
    throw new TaskRefused(`calibration needs exactly ${CALIBRATION_SIZE} seeded-bad PRs, got ${seeded.length}`);
  const labels = new Set([...real, ...seeded, ...unreadable].map((p) => p.label));
  if (labels.size !== real.length + seeded.length + unreadable.length)
    throw new TaskRefused('two packets share a label');
  const batch = [...real, ...seeded].sort((a, b) => (a.label < b.label ? -1 : 1));
  const bad = new Set(seeded.map((p) => p.label));
  const all: Judged[] = [];
  const lost: Unreadable[] = [];
  for (const packet of batch) {
    const failures: string[] = [];
    let sawUnreadable = false;
    let done = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const judged = { ...(await judgeOne(model, packet, clock)), attempts: attempt };
        done = true;
        if (sawUnreadable && judged.verdict === 'MERGE AS IS' && !bad.has(packet.label))
          lost.push({
            label: packet.label,
            reason: `unreadable by judge: MERGE AS IS came only after an unreadable reply, so it counts as a fail (${attempt} attempts)`,
            attempts: attempt,
          });
        else all.push(judged);
        break;
      } catch (error) {
        sawUnreadable ||= error instanceof JudgeUnparseable;
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (done) continue;
    const why = `${failures.length} attempts failed, last: ${failures.at(-1)}`;
    if (bad.has(packet.label))
      return { voided: `the judge could not be read on a seeded-bad PR: ${why}`, judged: [], unreadable: [] };
    lost.push({ label: packet.label, reason: `unreadable by judge: ${why}`, attempts: failures.length });
  }
  const passed = all.filter((j) => bad.has(j.label) && j.verdict !== 'REJECT');
  if (passed.length > 0)
    return {
      voided: `the judge did not reject ${passed.length} seeded-bad PR(s): ${passed.map((j) => `${j.label} (${j.verdict})`).join(', ')}`,
      judged: [],
      unreadable: [],
    };
  return { voided: null, judged: all.filter((j) => !bad.has(j.label)), unreadable: [...unreadable, ...lost] };
};

export interface ClaudeOptions {
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly configDir?: string;
  readonly timeoutMs?: number;
}

export const claudeArgs = (o: ClaudeOptions): string[] => [
  '-p',
  '--model',
  o.model ?? 'opus',
  '--effort',
  o.effort ?? 'xhigh',
  '--tools',
  '',
  '--no-session-persistence',
  '--output-format',
  'text',
];

export const claudeModel =
  (o: ClaudeOptions = {}): Model =>
  async (prompt) => {
    const env = { ...process.env, ...(o.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: o.configDir }) };
    const ran = await runBinary(o.bin ?? 'claude', claudeArgs(o), {
      input: prompt,
      env,
      timeoutMs: o.timeoutMs ?? 900_000,
    });
    if (ran.code !== 0) throw new TaskRefused(`the judge call failed: ${(ran.err || ran.out).trim().slice(-300)}`);
    return ran.out;
  };
