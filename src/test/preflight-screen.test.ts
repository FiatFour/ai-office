import { describe, expect, it } from 'vitest';
import {
  fetchReport,
  mayStart,
  needsFix,
  type PreflightReport,
  type Run,
  type Status,
  verdictOf,
} from '../screens/preflight/model.ts';

const check = (status: Status) => ({
  id: 'git' as const,
  group: 'computer' as const,
  label: 'git',
  status,
  detail: '',
  fix: 'fix it',
});

const report = (canStart: boolean, ...statuses: Status[]): PreflightReport => ({
  checkedAt: 1,
  host: { os: 'linux', label: 'Linux', shell: 'bash', arch: 'x64', kvm: false, engines: [] },
  checks: statuses.map(check),
  canStart,
});

describe('the preflight screen', () => {
  it('allows a start only after a finished run that says so', () => {
    const good = report(true, 'PASS', 'WARN');
    const done: Run = { phase: 'done', report: good };
    expect(mayStart(done)).toBe(true);
    expect(mayStart({ phase: 'done', report: report(false, 'FAIL') })).toBe(false);
    expect(mayStart({ phase: 'checking', last: good })).toBe(false);
    expect(mayStart({ phase: 'checking', last: null })).toBe(false);
    expect(mayStart({ phase: 'error', message: 'down' })).toBe(false);
  });

  it('names the state it is in', () => {
    expect(verdictOf({ phase: 'done', report: report(true, 'PASS', 'SKIP') })).toBe('ready');
    expect(verdictOf({ phase: 'done', report: report(true, 'PASS', 'WARN') })).toBe('warned');
    expect(verdictOf({ phase: 'done', report: report(false, 'FAIL', 'WARN') })).toBe('blocked');
    expect(verdictOf({ phase: 'checking', last: report(true) })).toBe('checking');
    expect(verdictOf({ phase: 'error', message: 'down' })).toBe('failed');
  });

  it('shows a fix for FAIL and WARN only', () => {
    expect((['PASS', 'WARN', 'FAIL', 'SKIP'] as const).filter((status) => needsFix(check(status)))).toEqual([
      'WARN',
      'FAIL',
    ]);
  });

  it('treats an HTTP error as no report', async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    await expect(fetchReport(answer(500, { error: 'boom' }))).rejects.toThrow('HTTP 500');
    await expect(fetchReport(answer(200, report(true)))).resolves.toEqual(report(true));
  });
});
