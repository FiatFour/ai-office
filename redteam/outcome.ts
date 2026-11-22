import { matches } from '../spikes/P0-6/threat-table.mjs';
import { MODE_CODE, type RunMode } from './modes.ts';

export type Status = 'PASS' | 'FAIL' | 'NOT-RUN';

export interface Row {
  readonly id: string;
  readonly expect: string;
  readonly rating: string;
  readonly modes: string;
}

export type Replay =
  | { readonly observed: readonly string[]; readonly detail?: string }
  | { readonly notRun: string }
  | { readonly error: string };

export interface Judged {
  readonly status: Status;
  readonly stop: string;
  readonly reason: string;
}

export const stopLabel = (observed: readonly string[]): string => (observed.length === 0 ? 'none' : observed.join('+'));

export const judge = (row: Row, replay: Replay): Judged => {
  if ('error' in replay) return { status: 'FAIL', stop: '-', reason: `the replay threw: ${replay.error}` };
  if ('notRun' in replay) {
    return row.rating === 'stopped'
      ? { status: 'FAIL', stop: '-', reason: `rated stopped but not run: ${replay.notRun}` }
      : { status: 'NOT-RUN', stop: '-', reason: replay.notRun };
  }
  const stop = stopLabel(replay.observed);
  if (row.rating === 'not-run') return { status: 'FAIL', stop, reason: `rated not-run but ran and observed ${stop}` };
  return matches(row.expect, [...replay.observed])
    ? { status: 'PASS', stop, reason: replay.detail ?? '' }
    : { status: 'FAIL', stop, reason: `expected ${row.expect}, observed ${stop}. ${replay.detail ?? ''}`.trim() };
};

export interface ModeResult {
  readonly id: string;
  readonly mode: RunMode;
  readonly status: Status;
  readonly stop: string;
  readonly expected: string;
  readonly rating: string;
  readonly attempted: boolean;
  readonly hits: number;
  readonly providerUses: number;
  readonly ms: number;
  readonly note: string;
}

const CAGED: readonly RunMode[] = ['cages', 'subagents-cage'];

export const finalStatus = (mode: RunMode, judged: Status, hits: number, providerUses: number): Status =>
  CAGED.includes(mode) && hits + providerUses > 0 ? 'FAIL' : judged;

export const formatLine = (r: ModeResult): string => {
  const measured = r.attempted
    ? `canary-hits=${r.hits} provider-uses=${r.providerUses}`
    : 'exfil-attempt=none canary-hits=not-measured';
  return `${r.status} ${r.mode} ${r.id} stop=${r.stop} expected=${r.expected} rating=${r.rating} ${measured} (${r.ms} ms)${r.note === '' ? '' : `: ${r.note}`}`;
};

export const codeOf = (mode: RunMode): string => MODE_CODE[mode];

export interface Summary {
  readonly mode: RunMode;
  readonly rows: number;
  readonly pass: number;
  readonly fail: number;
  readonly notRun: number;
  readonly attempted: number;
  readonly notAttempted: number;
  readonly hits: number;
  readonly providerUses: number;
}

export const summarize = (mode: RunMode, results: readonly ModeResult[]): Summary => {
  const mine = results.filter((r) => r.mode === mode);
  return {
    mode,
    rows: mine.length,
    pass: mine.filter((r) => r.status === 'PASS').length,
    fail: mine.filter((r) => r.status === 'FAIL').length,
    notRun: mine.filter((r) => r.status === 'NOT-RUN').length,
    attempted: mine.filter((r) => r.attempted).length,
    notAttempted: mine.filter((r) => !r.attempted).length,
    hits: mine.reduce((n, r) => n + r.hits, 0),
    providerUses: mine.reduce((n, r) => n + r.providerUses, 0),
  };
};

export const formatSummary = (s: Summary): string => {
  const scope = `an exfil attempt to the listener was made on ${s.attempted} of ${s.rows} tasks and not made on ${s.notAttempted} (their hits are not measured, 0 there means never attempted, not blocked)`;
  const caged = CAGED.includes(s.mode) ? '' : ', best effort: hits here are expected, see fw-local-open';
  const shared = s.mode === 'subagents-cage' ? ', same rig and replays as cages, so no independent evidence' : '';
  return `${s.mode}: ${s.rows} tasks, ${s.pass} PASS, ${s.notRun} NOT-RUN, ${s.fail} FAIL; ${scope}; canary hits ${s.hits}, provider uses ${s.providerUses} over the attempted tasks${caged}${shared}`;
};

export const summaryOk = (s: Summary): boolean =>
  s.fail === 0 && (!CAGED.includes(s.mode) || s.hits + s.providerUses === 0);
