import { describe, expect, it } from 'vitest';
import { DRIVERS, tabulate } from '../../scripts/contract-table.mjs';

type Row = Parameters<typeof tabulate>[0][number];

const row = (driver: string, status: Row['status'], reason: string | null = null, name: string | null = 'c'): Row => ({
  driver,
  os: 'linux',
  case: name,
  status,
  reason,
});

const everything = (): Row[] =>
  DRIVERS.map((driver) =>
    row(driver, driver.endsWith('live') ? 'not-run' : 'pass', driver.endsWith('live') ? 'no account' : null),
  );

const table = (rows: Row[]) => tabulate(rows, { oses: ['linux'] });

describe('the CI table', () => {
  it('has no problem when every cell is a pass or a named reason', () => {
    const { markdown, problems } = table(everything());
    expect(problems).toEqual([]);
    expect(markdown).toContain('| github-live | not run: no account |');
    expect(markdown).toContain('| docker | pass 1 |');
  });

  it('calls a cell nobody reported MISSING and a problem', () => {
    const { markdown, problems } = table(everything().filter((r) => r.driver !== 'podman'));
    expect(markdown).toContain('| podman | MISSING |');
    expect(problems).toEqual(['podman on linux has no result and no reason']);
  });

  it('refuses a skip without a reason', () => {
    expect(table([...everything(), row('docker', 'not-run', '  ', 'x')]).problems).toEqual([
      'docker on linux skipped 1 without a reason',
    ]);
  });

  it('reports a failed case by name and never turns it into a pass', () => {
    const { markdown, problems } = table([...everything(), row('docker', 'fail', 'boom', 'cage-is-hardened')]);
    expect(markdown).toContain('| docker | FAIL 1 of 2: cage-is-hardened |');
    expect(problems).toEqual(['docker on linux failed cage-is-hardened']);
  });

  it('shows a partial pass with the cases that did not run', () => {
    const { markdown, problems } = table([...everything(), row('docker', 'not-run', 'needs bulk-writes', 'pages')]);
    expect(problems).toEqual([]);
    expect(markdown).toContain('| docker | pass 1, not run 1 (needs bulk-writes) |');
  });

  it('keeps the last result of a case that ran twice', () => {
    const { markdown } = table([...everything(), row('docker', 'fail', 'x', 'c'), row('docker', 'pass', null, 'c')]);
    expect(markdown).toContain('| docker | pass 1 |');
  });
});
