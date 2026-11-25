import { readFileSync } from 'node:fs';
import { runBinary } from '../../server/sandbox/engine.ts';
import type { HostPull } from '../merge-state.ts';
import { type Row, TaskRefused, type Tokens, totalTokens } from '../model.ts';
import { workflowPaths } from './guard.ts';
import type { Judged } from './judge.ts';
import type { Entry } from './labels.ts';
import type { Ci, Unreadable } from './packet.ts';

export interface CheckRun {
  readonly head_sha: string;
  readonly status: string;
  readonly conclusion: string | null;
}

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);

const shaOfRuns = (asked: string, runs: readonly CheckRun[]): string => {
  const shas = new Set(runs.map((r) => r.head_sha));
  return shas.size === 1 ? ([...shas][0] ?? asked) : 'mixed';
};

export const ciFrom = (asked: string, runs: readonly CheckRun[]): Ci => {
  if (runs.length === 0) return { sha: asked, state: 'none', note: 'no check runs on this head' };
  const sha = shaOfRuns(asked, runs);
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
  return ciOfBody(sha, JSON.parse(ran.out) as CheckRunsBody);
};

export interface CheckRunsBody {
  readonly total_count: number;
  readonly check_runs: readonly CheckRun[];
}

export const ciOfBody = (sha: string, body: CheckRunsBody): Ci => {
  if (body.total_count > body.check_runs.length)
    throw new TaskRefused(`${sha} has ${body.total_count} check runs, only ${body.check_runs.length} were read`);
  return ciFrom(sha, body.check_runs);
};

export interface PullFile {
  readonly filename: string;
  readonly previous_filename?: string;
}

export const PAGE = 100;
const MAX_PAGES = 30;

export const readPaths = async (page: (n: number) => Promise<readonly PullFile[]>): Promise<string[]> => {
  const paths: string[] = [];
  for (let n = 1; n <= MAX_PAGES; n += 1) {
    const files = await page(n);
    for (const f of files) paths.push(f.filename, ...(f.previous_filename === undefined ? [] : [f.previous_filename]));
    if (files.length < PAGE) return paths;
  }
  throw new TaskRefused(`the PR lists more than ${MAX_PAGES * PAGE} files, too many to check`);
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
  readonly judged: Judged | Unreadable;
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
  const read = 'reason' in g.judged ? null : g.judged;
  const flows = workflowPaths(g.paths);
  if (flows.length > 0) out.push(`touches .github (${flows.join(', ')})`);
  if (g.pull.head.sha !== ready) out.push(`head moved from ${ready.slice(0, 7)} to ${g.pull.head.sha.slice(0, 7)}`);
  if (read === null) out.push(`the judge could not read it (${(g.judged as Unreadable).reason})`);
  else if (read.headSha !== ready) out.push(`judged ${read.headSha.slice(0, 7)}, not the ready head`);
  if (g.ci.sha !== ready) out.push(`CI read at ${g.ci.sha.slice(0, 7)}, not the ready head`);
  if (g.ci.state !== 'green') out.push(`CI ${g.ci.state}: ${g.ci.note}`);
  if (read?.verdict === 'MERGE AFTER EDITS') out.push(`judge wants edits (${read.editLines} lines)`);
  if (read?.verdict === 'REJECT') out.push('judge rejects');
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
    editLines: 'reason' in g.judged || g.judged.verdict !== 'MERGE AFTER EDITS' ? 0 : g.judged.editLines,
    judgeMinutes: 'reason' in g.judged ? null : g.judged.judgeMinutes,
    rootMinutes: g.rootMinutes,
    judgeAttempts: g.judged.attempts ?? null,
    inferredWindows: inferWindows(g.tokens, g.calibration),
    note: `${
      failed.length === 0
        ? `PR #${g.entry.pr}: CI green, MERGE AS IS at ${g.entry.readyHeadSha.slice(0, 7)}`
        : `PR #${g.entry.pr}: ${failed.join('; ')}`
    }${g.judged.attempts === undefined ? '' : ` (judge calls: ${g.judged.attempts})`}`,
  };
};
