import { describe, expect, it } from 'vitest';
import { DRIVERS, OSES, tabulate } from '../../scripts/contract-table.mjs';
import { find } from './engines.ts';

type Row = Parameters<typeof tabulate>[0][number];

const IDS = ['a', 'b'];
const LIVE = ['github-live', 'gitlab-live', 'krun'];

const cell = (driver: string, os: string, ids = IDS, status: Row['status'] = 'pass'): Row[] => [
  ...ids.map((id) => ({ driver, os, case: id, status: 'expected' as const, reason: null })),
  ...ids.map((id) => ({ driver, os, case: id, status, reason: status === 'not-run' ? 'needs x' : null })),
];

const ran = (driver: string, os: string, outcomes: Record<string, Row['status']>): Row[] => [
  ...IDS.map((id) => ({ driver, os, case: id, status: 'expected' as const, reason: null })),
  ...Object.entries(outcomes).map(([id, status]) => ({
    driver,
    os,
    case: id,
    status,
    reason: status === 'not-run' ? 'needs x' : status === 'fail' ? 'boom' : null,
  })),
];

const whole = (driver: string, os: string, reason: string | null): Row => ({
  driver,
  os,
  case: null,
  status: 'not-run',
  reason,
});

const everything = (): Row[] =>
  OSES.flatMap((os) =>
    DRIVERS.flatMap((driver) => {
      if (LIVE.includes(driver)) return [whole(driver, os, 'no account')];
      if ((driver === 'docker' || driver === 'podman') && os !== 'linux') return [whole(driver, os, 'no linux engine')];
      return cell(driver, os);
    }),
  );

const without = (driver: string, os: string, rows = everything()) =>
  rows.filter((r) => !(r.driver === driver && r.os === os));

describe('the CI table', () => {
  it('has no problem when every cell is a pass or a named reason', () => {
    const { markdown, problems } = tabulate(everything());
    expect(problems).toEqual([]);
    expect(markdown).toContain('| github-live | not run: no account | not run: no account | not run: no account |');
    expect(markdown).toContain('| docker | pass 2 | not run: no linux engine | not run: no linux engine |');
  });

  it('calls a cell nobody reported MISSING and a problem', () => {
    const { markdown, problems } = tabulate(without('podman', 'linux'));
    expect(markdown).toContain('| podman | MISSING |');
    expect(problems).toEqual(['podman on linux has no result and no reason']);
  });

  it('fails a case the contract lists and nothing ran', () => {
    const rows = everything().filter(
      (r) => !(r.driver === 'github-recorded' && r.os === 'macos' && r.case === 'b' && r.status === 'pass'),
    );
    expect(tabulate(rows).problems).toEqual(['github-recorded on macos never ran b']);
  });

  it('fails a case that was skipped in a cell that must pass', () => {
    const rows = [
      ...without('gitlab-recorded', 'windows'),
      ...ran('gitlab-recorded', 'windows', { a: 'pass', b: 'not-run' }),
    ];
    expect(tabulate(rows).problems).toEqual(['gitlab-recorded on windows must pass every case and skipped 1']);
  });

  it('lets gitlab skip the one case that is about a GitHub signature', () => {
    const rows = [
      ...without('gitlab-recorded', 'linux'),
      ...ran('gitlab-recorded', 'linux', { a: 'pass', b: 'pass' }).filter(
        (r) => r.case !== 'b' || r.status === 'expected',
      ),
      {
        driver: 'gitlab-recorded',
        os: 'linux',
        case: 'a-github-signature-is-checked',
        status: 'not-run' as const,
        reason: 'token header',
      },
      {
        driver: 'gitlab-recorded',
        os: 'linux',
        case: 'a-github-signature-is-checked',
        status: 'expected' as const,
        reason: null,
      },
      { driver: 'gitlab-recorded', os: 'linux', case: 'b', status: 'pass' as const, reason: null },
    ];
    expect(tabulate(rows).problems).toEqual([]);
  });

  it('fails results that come with no list of the cases to run', () => {
    const rows = everything().filter((r) => !(r.driver === 'docker' && r.os === 'linux' && r.status === 'expected'));
    expect(tabulate(rows).problems).toEqual(['docker on linux has results and no list of the cases it must run']);
  });

  it('fails a case the contract does not list', () => {
    const rows = [...without('docker', 'linux'), ...ran('docker', 'linux', { a: 'pass', b: 'pass', stray: 'pass' })];
    expect(tabulate(rows).problems).toEqual(['docker on linux ran stray, which the contract does not list']);
  });

  it('fails a case recorded twice, even fail then pass', () => {
    const rows = [
      ...everything(),
      { driver: 'docker', os: 'linux', case: 'a', status: 'fail' as const, reason: 'boom' },
    ];
    const { problems } = tabulate(rows);
    expect(problems).toContain('docker on linux recorded a more than once');
    expect(problems).toContain('docker on linux failed a');
  });

  it('refuses a skip without a reason', () => {
    const rows = [...without('krun', 'linux'), whole('krun', 'linux', '  ')];
    expect(tabulate(rows).problems).toEqual(['krun on linux skipped 1 without a reason']);
  });

  it('reports a failed case by name and never turns it into a pass', () => {
    const rows = [...without('docker', 'linux'), ...ran('docker', 'linux', { a: 'pass', b: 'fail' })];
    const { markdown, problems } = tabulate(rows);
    expect(markdown).toContain('| docker | FAIL 1 of 2: b |');
    expect(problems).toEqual(['docker on linux failed b']);
  });

  it('lets live cells show a partial pass with the cases that did not run', () => {
    const rows = [...without('github-live', 'linux'), ...ran('github-live', 'linux', { a: 'pass', b: 'not-run' })];
    const { markdown, problems } = tabulate(rows);
    expect(problems).toEqual([]);
    expect(markdown).toContain('pass 1, not run 1 (needs x)');
  });

  it('fails a row that names a driver the table does not know', () => {
    const rows = [...everything(), ...cell('cloud-hypervisor', 'linux')];
    expect(tabulate(rows).problems).toContain(
      'cloud-hypervisor on linux case a names a driver the table does not know',
    );
  });

  it('fails a row that names an OS the table does not know', () => {
    const rows = [...everything(), ...cell('docker', 'freebsd')];
    expect(tabulate(rows).problems).toContain('docker on freebsd case a names an OS the table does not know');
  });

  it('fails a row whose status is neither pass, fail, not-run nor expected', () => {
    const rows = [
      ...without('docker', 'linux'),
      ...ran('docker', 'linux', { a: 'pass', b: 'passed' as Row['status'] }),
    ];
    expect(tabulate(rows).problems).toContain(
      'docker on linux case b has status "passed", which is not pass, fail, not-run or expected',
    );
  });

  it('fails docker and podman on linux when the engine is unusable, the way a broken socket looks', async () => {
    const { engine, reason } = await find('docker', { ...process.env, DOCKER_HOST: 'unix:///nonexistent.sock' });
    expect(engine).toBeNull();
    const rows = [...without('docker', 'linux'), whole('docker', 'linux', reason)];
    const { markdown, problems } = tabulate(rows);
    expect(markdown).toContain('| docker | FAIL not run:');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^docker on linux must pass every case and was not run: /);
  }, 60_000);
});
