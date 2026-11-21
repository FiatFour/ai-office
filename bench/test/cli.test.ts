import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canSpawnTs, tempDir } from '../../server/test/helpers.ts';
import { loadTasks } from '../run.ts';

const RUN = fileURLToPath(new URL('../run.ts', import.meta.url));
const TASKS = fileURLToPath(new URL('../tasks', import.meta.url));

const cli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync('node', [RUN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

const withTasks = (...tasks: unknown[]): string => {
  const dir = tempDir('bench-tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'x.json'), JSON.stringify(tasks));
  return dir;
};

const GOOD = {
  set: 'A',
  id: 'a-1',
  repo: 'a/b',
  issue: 1,
  title: 't',
  body: '',
  fixSha: 'a'.repeat(40),
  hiddenPaths: ['t.test.ts'],
  specs: ['t.test.ts'],
  testCommand: ['true'],
  reporter: 'vitest',
  image: 'i',
};

describe.skipIf(!canSpawnTs)('the harness command line', () => {
  it('refuses a task with no hidden-test commit and says what is missing', () => {
    const dir = withTasks({ ...GOOD, id: 'no-hidden', fixSha: undefined, hiddenPaths: [] });
    const ran = cli(['prepare', '--task', 'no-hidden', '--tasks', dir]);
    expect(ran.status).toBe(3);
    expect(ran.stderr).toContain('task no-hidden names no hidden-test commit');
  });

  it('refuses a model run on a task the operator has not confirmed', () => {
    const ran = cli(
      ['run', '--task', 'a-1', '--arm', 'baseline', '--tasks', withTasks({ ...GOOD, confirmed: false })],
      {
        AW_BENCH_LOGIN_CONFIRMED: '1',
      },
    );
    expect(ran.status).toBe(3);
    expect(ran.stderr).toContain('not confirmed by the operator: no model run');
  });

  it('refuses the real Claude baseline on a confirmed task until the operator confirms the login', () => {
    const dir = withTasks({ ...GOOD, confirmed: true });
    const ran = cli(['run', '--task', 'a-1', '--arm', 'baseline', '--tasks', dir], { AW_BENCH_LOGIN_CONFIRMED: '' });
    expect(ran.status).toBe(3);
    expect(ran.stderr).toContain('not run, needs operator login confirmation');
  });

  it('applies both gates when --bin points at another binary', () => {
    const open = withTasks({ ...GOOD, confirmed: false });
    const shut = withTasks({ ...GOOD, confirmed: true });
    const args = (dir: string) => ['run', '--task', 'a-1', '--arm', 'baseline', '--bin', '/bin/true', '--tasks', dir];
    const unconfirmed = cli(args(open), { AW_BENCH_LOGIN_CONFIRMED: '1' });
    expect(unconfirmed.status).toBe(3);
    expect(unconfirmed.stderr).toContain('not confirmed by the operator: no model run');
    const noLogin = cli(args(shut), { AW_BENCH_LOGIN_CONFIRMED: '' });
    expect(noLogin.status).toBe(3);
    expect(noLogin.stderr).toContain('not run, needs operator login confirmation');
  });

  it('refuses the factory arm on an unconfirmed task and until the operator confirms the login', () => {
    const unconfirmed = cli(
      ['run', '--task', 'a-1', '--arm', 'factory', '--tasks', withTasks({ ...GOOD, confirmed: false })],
      { AW_BENCH_LOGIN_CONFIRMED: '1' },
    );
    expect(unconfirmed.status).toBe(3);
    expect(unconfirmed.stderr).toContain('not confirmed by the operator: no model run');
    const shut = withTasks({ ...GOOD, confirmed: true });
    const noLogin = cli(['run', '--task', 'a-1', '--arm', 'factory', '--tasks', shut], {
      AW_BENCH_LOGIN_CONFIRMED: '',
    });
    expect(noLogin.status).toBe(3);
    expect(noLogin.stderr).toContain('not run, needs operator login confirmation');
    const bin = cli(['run', '--task', 'a-1', '--arm', 'factory', '--bin', '/bin/true', '--tasks', shut], {
      AW_BENCH_LOGIN_CONFIRMED: '',
    });
    expect(bin.stderr).toContain('not run, needs operator login confirmation');
  });

  it('needs a cage home for the factory arm and refuses a scratch repo that is not one', () => {
    const dir = withTasks({ ...GOOD, confirmed: true });
    const env = { AW_BENCH_LOGIN_CONFIRMED: '1' };
    const noHome = cli(['run', '--task', 'a-1', '--arm', 'factory', '--tasks', dir], env);
    expect(noHome.status).toBe(3);
    expect(noHome.stderr).toContain('needs --home');
    const wrong = cli(
      [
        'run',
        '--task',
        'a-1',
        '--arm',
        'factory',
        '--scratch-repo',
        'FiatFour/ai-office',
        '--home',
        '/nowhere',
        '--tasks',
        dir,
      ],
      env,
    );
    expect(wrong.status).toBe(3);
    expect(wrong.stderr).toContain('is not a scratch repo');
  });

  it('refuses a --timeout-ms or --runs that is not a whole number of milliseconds a timer can hold, before any push', () => {
    const dir = withTasks({ ...GOOD, confirmed: true });
    const env = { AW_BENCH_LOGIN_CONFIRMED: '1' };
    for (const arm of ['baseline', 'factory'])
      for (const [flag, value] of [
        ['--timeout-ms', 'abc'],
        ['--timeout-ms', '0'],
        ['--timeout-ms', '-1'],
        ['--timeout-ms', '1.5'],
        ['--timeout-ms', '99999999999'],
        ['--runs', '0'],
        ['--runs', 'x'],
      ] as const) {
        const ran = cli(['run', '--task', 'a-1', '--arm', arm, `${flag}=${value}`, '--tasks', dir], env);
        expect(ran.status, `${arm} ${flag} ${value}`).toBe(3);
        expect(ran.stderr, `${arm} ${flag} ${value}`).toContain(`${flag} must be a whole number`);
      }
  }, 60_000);

  it('refuses a scratch remote that is not the scratch repo, before any push', () => {
    const dir = withTasks({ ...GOOD, confirmed: true });
    const ran = cli(
      [
        'run',
        '--task',
        'a-1',
        '--arm',
        'factory',
        '--scratch-remote',
        'git@github.com:FiatFour/ai-office.git',
        '--tasks',
        dir,
      ],
      { AW_BENCH_LOGIN_CONFIRMED: '1' },
    );
    expect(ran.status).toBe(3);
    expect(ran.stderr).toContain('the remote names FiatFour/ai-office, not FiatFour/agent-works-scratch');
  });

  it('needs a scripted file for the scripted arm and an unknown task id names the directory', () => {
    const dir = withTasks(GOOD);
    expect(cli(['run', '--task', 'a-1', '--tasks', dir]).stderr).toContain('needs --scripts');
    expect(cli(['run', '--task', 'nope', '--tasks', dir]).stderr).toContain('no task nope');
  });
});

describe('the cage a model run gets', () => {
  it('is built from BenchCage, which owns the allowlist, and from no bare SandboxDriver', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const text = (f: string) => readFileSync(join(dir, f), 'utf8');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(sources.filter((f) => /new SandboxDriver\(/.test(text(f)))).toEqual([]);
    expect(text('run.ts')).toMatch(/new BenchCage\(/);
  });
});

describe('the committed tasks', () => {
  const tasks = loadTasks(TASKS);

  it('hold 10 Set A tasks from 2 repos, all confirmed by the operator', () => {
    expect(tasks).toHaveLength(10);
    expect(new Set(tasks.map((t) => t.repo)).size).toBe(2);
    expect(tasks.every((t) => t.set === 'A' && t.confirmed)).toBe(true);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(10);
  });

  it('name a fix commit and at least one hidden test path each', () => {
    for (const t of tasks) if (t.set === 'A') expect(t.hiddenPaths.length).toBeGreaterThan(0);
  });
});
