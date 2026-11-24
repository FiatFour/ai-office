import { readFileSync } from 'node:fs';
import { runBinary } from '../../server/sandbox/engine.ts';
import type { HostPull } from '../merge-state.ts';
import { type Row, TaskRefused, type Tokens, totalTokens } from '../model.ts';
import { workflowPaths } from './guard.ts';
import type { Judged } from './judge.ts';
import type { Entry } from './labels.ts';
import type { Ci } from './packet.ts';

export interface CheckRun {
  readonly status: string;
  readonly conclusion: string | null;
}

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);

export const ciFrom = (sha: string, runs: readonly CheckRun[]): Ci => {
  if (runs.length === 0) return { sha, state: 'none', note: 'no check runs on this head' };
  if (runs.some((r) => r.status !== 'completed'))
    return { sha, state: 'pending', note: 'some checks have not finished' };
  const bad = runs.filter((r) => r.conclusion === null || BAD.has(r.conclusion)).length;
  if (bad > 0) return { sha, state: 'red', note: `${bad} of ${runs.length} checks did not pass` };
  if (!runs.some((r) => r.conclusion === 'success')) return { sha, state: 'none', note: 'no check succeeded' };
  return { sha, state: 'green', note: `${runs.length} checks passed or were skipped` };
};

export const ghReadCi = async (repo: string, sha: string): Promise<Ci> => {
  const ran = await runBinary('gh', ['api', '-X', 'GET', `repos/${repo}/commits/${sha}/check-runs?per_page=100`], {
    timeoutMs: 60_000,
  });
  if (ran.code !== 0) throw new TaskRefused(`gh could not read the checks of ${sha}: ${ran.err.trim().slice(-200)}`);
  return ciFrom(sha, (JSON.parse(ran.out) as { check_runs: CheckRun[] }).check_runs);
};

export interface WindowCalibration {
  readonly tokensPerWindow: number | null;
  readonly source: string;
}

export const readWindow = (file: string): WindowCalibration => {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowCalibration>;
  const n = raw.tokensPerWindow;
  if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n <= 0))
    throw new TaskRefused(`${file}: tokensPerWindow must be null or a positive number`);
  return { tokensPerWindow: n ?? null, source: typeof raw.source === 'string' ? raw.source : '' };
};

export const inferWindows = (tokens: Tokens | null, calibration: WindowCalibration): number | null =>
  tokens === null || calibration.tokensPerWindow === null ? null : totalTokens(tokens) / calibration.tokensPerWindow;

export interface Grading {
  readonly entry: Entry & { readonly arm: 'factory' | 'baseline' };
  readonly judged: Judged;
  readonly pull: Pick<HostPull, 'head'>;
  readonly ci: Ci;
  readonly paths: readonly string[];
  readonly wallMs: number;
  readonly tokens: Tokens | null;
  readonly operatorMinutes: number | null;
  readonly rootMinutes: number | null;
  readonly calibration: WindowCalibration;
}

export const failures = (g: Grading): string[] => {
  const ready = g.entry.readyHeadSha;
  const out: string[] = [];
  const flows = workflowPaths(g.paths);
  if (flows.length > 0) out.push(`touches .github (${flows.join(', ')})`);
  if (g.pull.head.sha !== ready) out.push(`head moved from ${ready.slice(0, 7)} to ${g.pull.head.sha.slice(0, 7)}`);
  if (g.judged.headSha !== ready) out.push(`judged ${g.judged.headSha.slice(0, 7)}, not the ready head`);
  if (g.ci.sha !== ready) out.push(`CI read at ${g.ci.sha.slice(0, 7)}, not the ready head`);
  if (g.ci.state !== 'green') out.push(`CI ${g.ci.state}: ${g.ci.note}`);
  if (g.judged.verdict === 'MERGE AFTER EDITS') out.push(`judge wants edits (${g.judged.editLines} lines)`);
  if (g.judged.verdict === 'REJECT') out.push('judge rejects');
  return out;
};

export const gradeSetB = (g: Grading): Row => {
  const failed = failures(g);
  return {
    task: g.entry.task,
    set: 'B',
    arm: g.entry.arm,
    scripted: false,
    run: 1,
    outcome: failed.length === 0 ? 'pass' : 'fail',
    reviewRounds: null,
    wallMs: g.wallMs,
    agentMs: 0,
    prepareMs: 0,
    tokens: g.tokens,
    flag: null,
    quotaWindows: null,
    humanMinutes: g.operatorMinutes,
    editLines: g.judged.verdict === 'MERGE AFTER EDITS' ? g.judged.editLines : 0,
    judgeMinutes: g.judged.judgeMinutes,
    rootMinutes: g.rootMinutes,
    inferredWindows: inferWindows(g.tokens, g.calibration),
    note:
      failed.length === 0
        ? `PR #${g.entry.pr}: CI green, MERGE AS IS at ${g.entry.readyHeadSha.slice(0, 7)}`
        : `PR #${g.entry.pr}: ${failed.join('; ')}`,
  };
};
