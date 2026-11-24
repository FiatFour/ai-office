import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { runBinary } from '../../server/sandbox/engine.ts';
import { TaskRefused } from '../model.ts';
import { type Packet, renderPrompt, type Unreadable } from './packet.ts';
import { type Judgement, parseVerdict } from './rubric.ts';

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

export const countVoids = (file: string): number =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l !== '').length
    : 0;

export const recordVoid = (file: string, reason: string): number => {
  appendFileSync(file, `${JSON.stringify({ reason })}\n`);
  return countVoids(file);
};

export const refuseAfterVoids = (file: string): void => {
  const n = countVoids(file);
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
    let done = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        all.push({ ...(await judgeOne(model, packet, clock)), attempts: attempt });
        done = true;
        break;
      } catch (error) {
        failures.push((error as Error).message ?? String(error));
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
