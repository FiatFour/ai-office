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
}

export const CALIBRATION_SIZE = 2;

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
): Promise<JudgeRun> => {
  if (seeded.length !== CALIBRATION_SIZE)
    throw new TaskRefused(`calibration needs exactly ${CALIBRATION_SIZE} seeded-bad PRs, got ${seeded.length}`);
  const labels = new Set([...real, ...seeded, ...unreadable].map((p) => p.label));
  if (labels.size !== real.length + seeded.length + unreadable.length)
    throw new TaskRefused('two packets share a label');
  const batch = [...real, ...seeded].sort((a, b) => (a.label < b.label ? -1 : 1));
  const bad = new Set(seeded.map((p) => p.label));
  const all: Judged[] = [];
  for (const packet of batch) {
    try {
      all.push(await judgeOne(model, packet, clock));
    } catch (error) {
      if (bad.has(packet.label))
        return {
          voided: `the judge could not be read on a seeded-bad PR: ${(error as Error).message}`,
          judged: [],
          unreadable: [],
        };
      throw error;
    }
  }
  const passed = all.filter((j) => bad.has(j.label) && j.verdict !== 'REJECT');
  if (passed.length > 0)
    return {
      voided: `the judge did not reject ${passed.length} seeded-bad PR(s): ${passed.map((j) => `${j.label} (${j.verdict})`).join(', ')}`,
      judged: [],
      unreadable: [],
    };
  return { voided: null, judged: all.filter((j) => !bad.has(j.label)), unreadable };
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
