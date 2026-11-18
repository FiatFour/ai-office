import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  testCommand: ['true'],
  expect: '.',
  baseFail: '.',
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

  it('does not wire the live factory arm into the command line', () => {
    const ran = cli(['run', '--task', 'a-1', '--arm', 'factory', '--tasks', withTasks({ ...GOOD, confirmed: true })]);
    expect(ran.status).toBe(3);
    expect(ran.stderr).toContain('needs a scratch host repo seeded with the task base');
  });

  it('needs a scripted file for the scripted arm and an unknown task id names the directory', () => {
    const dir = withTasks(GOOD);
    expect(cli(['run', '--task', 'a-1', '--tasks', dir]).stderr).toContain('needs --scripts');
    expect(cli(['run', '--task', 'nope', '--tasks', dir]).stderr).toContain('no task nope');
  });
});

describe('the committed tasks', () => {
  const tasks = loadTasks(TASKS);

  it('hold 10 Set A tasks from 2 repos, all waiting for the operator to confirm', () => {
    expect(tasks).toHaveLength(10);
    expect(new Set(tasks.map((t) => t.repo)).size).toBe(2);
    expect(tasks.every((t) => t.set === 'A' && !t.confirmed)).toBe(true);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(10);
  });

  it('name a fix commit and at least one hidden test path each', () => {
    for (const t of tasks) if (t.set === 'A') expect(t.hiddenPaths.length).toBeGreaterThan(0);
  });
});
