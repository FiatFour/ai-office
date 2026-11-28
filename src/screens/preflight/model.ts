import type { Check, Group, Status } from '../../../server/preflight/checks.ts';
import type { PreflightReport } from '../../../server/preflight/report.ts';

export type { Check, Group, PreflightReport, Status };

export const STATUSES: readonly Status[] = ['PASS', 'WARN', 'FAIL', 'SKIP'];
export const GROUP_ORDER: readonly Group[] = ['computer', 'sandbox'];

/** What the screen knows. Only a finished run can allow a start, so a report that is old or being replaced cannot. */
export type Run =
  | { readonly phase: 'checking'; readonly last: PreflightReport | null }
  | { readonly phase: 'done'; readonly report: PreflightReport }
  | { readonly phase: 'error'; readonly message: string };

export const mayStart = (run: Run): boolean => run.phase === 'done' && run.report.canStart;

export const reportOf = (run: Run): PreflightReport | null =>
  run.phase === 'done' ? run.report : run.phase === 'checking' ? run.last : null;

export type Verdict = 'checking' | 'ready' | 'warned' | 'blocked' | 'failed';

export const verdictOf = (run: Run): Verdict => {
  if (run.phase === 'checking') return 'checking';
  if (run.phase === 'error') return 'failed';
  if (!run.report.canStart) return 'blocked';
  return run.report.checks.some((check) => check.status === 'WARN') ? 'warned' : 'ready';
};

export const countOf = (checks: readonly Check[], status: Status): number =>
  checks.filter((check) => check.status === status).length;

export const needsFix = (check: Check): boolean => check.status === 'FAIL' || check.status === 'WARN';

export const fetchReport = async (ask: typeof fetch = fetch): Promise<PreflightReport> => {
  const res = await ask('/api/preflight', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PreflightReport;
};
