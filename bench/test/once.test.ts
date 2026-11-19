import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../server/agents/claude-code.ts';
import type { AgentJob, AgentRuntime } from '../../server/agents/runtime.ts';
import { github } from '../../server/githost/github.ts';
import type { HttpRequest, Transport } from '../../server/githost/host.ts';
import { type RunningHq, startHq } from '../../server/hq.ts';
import { cagesMode } from '../../server/modes/cages.ts';
import { FakeGithub } from '../../server/test/fakes/github-api.ts';
import { hasSqlite, tempDir } from '../../server/test/helpers.ts';
import type { Arm } from '../arms.ts';
import { type FactoryEnv, factoryArm, ticketOf } from '../arms-live.ts';
import type { TaskA } from '../model.ts';
import { killOnAbort, runTask, timeoutOf, verifyTask } from '../run.ts';
import { localRunner } from '../runner.ts';
import { AUTHOR, namesOf, oneSessionEach, REVIEWER, scratchEnv } from '../scratch.ts';
import { prepareTask } from '../workspace.ts';
import { FIXED, makeFixture } from './fixture.ts';

const REPO = 'acme/app-scratch';
const FIXED_AGAIN = `${FIXED}// tidy\n`;

const gitOf = (dir: string, ...args: string[]) =>
  execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const bare = (): string => {
  const dir = tempDir('once-bare');
  execFileSync('git', ['init', '-q', '--bare', dir]);
  return dir;
};

const verified = async () => {
  const fx = makeFixture();
  const cache = tempDir('bench-cache');
  const scratch = join(cache, 'grading');
  const prepared = await prepareTask(fx.task, {
    cache,
    repoUrl: (repo) => join(fx.reposRoot, `${repo}.git`),
    runner: localRunner,
  });
  await verifyTask(fx.task, prepared, localRunner, scratch);
  return { fx, scratch, prepared, cache };
};

interface Case {
  readonly name: string;
  readonly inject?: (request: HttpRequest) => boolean;
  readonly authorFails?: boolean;
  readonly reviewerFails?: boolean;
  readonly review?: 'approve' | 'changes';
  readonly files: (round: number) => Array<{ path: string; content: string }>;
  readonly sessions: Record<string, number>;
  readonly outcome: 'error' | 'fail';
  readonly note: string;
}

const slug = (content: string) => [{ path: 'src/slug.js', content }];
const post =
  (pattern: RegExp, status = 'POST') =>
  (r: HttpRequest) =>
    r.method === status && pattern.test(r.path);

const CASES: readonly Case[] = [
  {
    name: 'before the session: the host cannot list the PR',
    inject: (r) => r.method === 'GET' && /\/pulls\?/.test(r.path),
    files: () => slug(FIXED),
    sessions: {},
    outcome: 'error',
    note: '500',
  },
  {
    name: 'inside the author session',
    authorFails: true,
    files: () => slug(FIXED),
    sessions: { author0: 1 },
    outcome: 'error',
    note: 'the author crashed',
  },
  {
    name: 'inside the reviewer session',
    reviewerFails: true,
    files: () => slug(FIXED),
    sessions: { author0: 1, reviewer1: 1 },
    outcome: 'error',
    note: 'the reviewer crashed',
  },
  {
    name: 'after the author session: the REST guard refuses a dotfile',
    files: () => [...slug(FIXED), { path: '.eslintrc.json', content: '{}\n' }],
    sessions: { author0: 1 },
    outcome: 'fail',
    note: 'the host refused what the crew pushed',
  },
  {
    name: 'after the author session: the host rejects the tree',
    inject: post(/\/git\/trees$/),
    files: () => slug(FIXED),
    sessions: { author0: 1 },
    outcome: 'error',
    note: '/git/trees -> 500',
  },
  {
    name: 'after the author session: the host will not open the PR',
    inject: post(/\/pulls$/),
    files: () => slug(FIXED),
    sessions: { author0: 1 },
    outcome: 'error',
    note: 'POST /repos/acme/app-scratch/pulls -> 500',
  },
  {
    name: 'after the fix session: the round changed no file',
    review: 'changes',
    files: () => slug(FIXED),
    sessions: { author0: 1, reviewer1: 1, author1: 1 },
    outcome: 'error',
    note: 'the fix round changed no file',
  },
  {
    name: 'after the fix session: the REST guard refuses a dotfile',
    review: 'changes',
    files: (round) => (round === 0 ? slug(FIXED) : [...slug(FIXED_AGAIN), { path: '.babelrc', content: '{}\n' }]),
    sessions: { author0: 1, reviewer1: 1, author1: 1 },
    outcome: 'fail',
    note: 'the host refused what the crew pushed',
  },
  {
    name: 'after the reviewer session: the host rejects the review',
    inject: post(/\/pulls\/\d+\/reviews$/),
    files: () => slug(FIXED),
    sessions: { author0: 1, reviewer1: 1 },
    outcome: 'error',
    note: '/reviews -> 500',
  },
];

const countingRuntime = (c: Case, seen: Map<string, number>): AgentRuntime => ({
  id: 'scripted',
  async run(job) {
    const key = `${job.role}${job.round}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (job.role === 'reviewer') {
      if (c.reviewerFails === true) throw new Error('the reviewer crashed');
      return { role: 'reviewer', verdict: c.review ?? 'approve', body: 'ok', comments: [], usage: null };
    }
    if (c.authorFails === true) throw new Error('the author crashed');
    return { role: 'author', files: c.files(job.round), message: 'm', usage: null };
  },
});

const armedTransport = (fake: FakeGithub, c: Case): { send: Transport; arm: () => void } => {
  const inner = fake.transport('aw-nova');
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    send: async (request) =>
      armed && c.inject?.(request) === true ? { status: 500, body: { message: 'injected' } } : inner(request),
  };
};

describe.skipIf(!hasSqlite || process.platform === 'win32')(
  'a model session starts once per task, role and turn',
  () => {
    it.each(CASES)(
      'arm: $name ends the row at once and starts no second session',
      async (c) => {
        const { fx, scratch, prepared, cache } = await verified();
        const fake = new FakeGithub(REPO);
        const remote = bare();
        const seen = new Map<string, number>();
        const { send, arm } = armedTransport(fake, c);
        const inner = scratchEnv({
          repo: REPO,
          remote,
          send,
          log: () => {},
          workers: () => {
            const runtime = countingRuntime(c, seen);
            return { [AUTHOR]: runtime, [REVIEWER]: runtime };
          },
          workRoot: join(cache, 'scratch'),
          pollMs: 30,
          settleMs: 10,
          reviewPollMs: 30,
        });
        const env: FactoryEnv = {
          ...inner,
          async open(t, ticket, p) {
            const handle = await inner.open(t, ticket, p);
            const files = gitOf(remote, 'ls-tree', '-r', '--name-only', handle.base).split('\n');
            fake.commitOn(
              handle.base,
              Object.fromEntries(files.map((f) => [f, gitOf(remote, 'show', `${handle.base}:${f}`)])),
            );
            arm();
            return handle;
          },
        };
        const row = await runTask({ ...fx.task, timeoutMs: 6000 }, 1, prepared, {
          arm: factoryArm(env),
          runner: localRunner,
          scratch,
        });
        await sleep(300);
        expect(row.note).toContain(c.note);
        expect(row.outcome).toBe(c.outcome);
        expect(row.wallMs).toBeLessThan(5000);
        expect(Object.fromEntries(seen)).toEqual(c.sessions);
      },
      20_000,
    );

    describe('at the cages mode, with nothing but the guard where sessions start', () => {
      const running: RunningHq[] = [];
      afterEach(async () => {
        await Promise.all(running.splice(0).map((hq) => hq.close()));
      });

      it.each(CASES.filter((c) => !c.name.startsWith('before')))(
        '$name: the retries the mode makes never reach a second session',
        async (c) => {
          const fake = new FakeGithub(REPO);
          const seen = new Map<string, number>();
          const { send, arm } = armedTransport(fake, c);
          const runtime = countingRuntime(c, seen);
          const crew = oneSessionEach({ [AUTHOR]: runtime, [REVIEWER]: runtime });
          const ticket = { ...ticketOf(makeFixture().task, 1) };
          const hq = await startHq({
            home: tempDir('once-hq'),
            port: 0,
            makeDriver: async () => null,
            mode: cagesMode({
              host: github({ repo: REPO, base: 'main', send, log: () => {} }),
              repo: REPO,
              base: 'main',
              tickets: { [ticket.id]: ticket },
              author: AUTHOR,
              reviewer: REVIEWER,
              workers: crew.workers,
              pollMs: 30,
              settleMs: 10,
            }),
          });
          running.push(hq);
          arm();
          await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: ticket.id }) });
          const until = Date.now() + 4000;
          while (crew.failure() === null && Date.now() < until) await sleep(20);
          await sleep(600);
          expect(crew.failure()).not.toBeNull();
          expect(Math.max(0, ...seen.values())).toBeLessThanOrEqual(1);
          expect(Object.fromEntries(seen)).toEqual(c.sessions);
        },
        20_000,
      );
    });
  },
);

describe.skipIf(!hasSqlite || process.platform === 'win32')(
  'a run that times out is stopped before the next one starts',
  () => {
    it('waits for a session that ignores the abort, and nothing it does reaches run 2', async () => {
      const { fx, scratch, prepared, cache } = await verified();
      const fake = new FakeGithub(REPO);
      const remote = bare();
      let run = 1;
      const log: string[] = [];
      const runtime: AgentRuntime = {
        id: 'scripted',
        async run(job) {
          const mine = run;
          if (job.role === 'reviewer') {
            await sleep(300);
            return { role: 'reviewer', verdict: 'approve', body: 'ok', comments: [], usage: null };
          }
          await sleep(mine === 1 ? 1200 : 100);
          log.push(`author r${mine} done`);
          return {
            role: 'author',
            files: slug(mine === 1 ? 'export const slug = () => "ZOMBIE";\n' : FIXED),
            message: 'm',
            usage: null,
          };
        },
      };
      const inner = scratchEnv({
        repo: REPO,
        remote,
        send: fake.transport('aw-nova'),
        log: () => {},
        workers: () => ({ [AUTHOR]: runtime, [REVIEWER]: runtime }),
        workRoot: join(cache, 'scratch'),
        pollMs: 30,
        settleMs: 10,
        reviewPollMs: 30,
      });
      const env: FactoryEnv = {
        ...inner,
        async open(t, ticket, p) {
          const handle = await inner.open(t, ticket, p);
          const files = gitOf(remote, 'ls-tree', '-r', '--name-only', handle.base).split('\n');
          fake.commitOn(
            handle.base,
            Object.fromEntries(files.map((f) => [f, gitOf(remote, 'show', `${handle.base}:${f}`)])),
          );
          return handle;
        },
      };
      const arm = factoryArm(env);
      const first = await runTask({ ...fx.task, timeoutMs: 300 }, 1, prepared, { arm, runner: localRunner, scratch });
      const callsAtReturn = fake.calls.length;
      expect(first.outcome).toBe('timeout');
      expect(log).toEqual(['author r1 done']);
      run = 2;
      const second = await runTask({ ...fx.task, timeoutMs: 15_000 }, 2, prepared, {
        arm,
        runner: localRunner,
        scratch,
      });
      await sleep(500);
      expect(second.outcome).toBe('pass');
      const late = fake.calls.slice(callsAtReturn).filter((c) => JSON.stringify(c).includes('-r1'));
      expect(late).toEqual([]);
      expect(fake.calls.slice(0, callsAtReturn).some((c) => c.method === 'POST' && /\/git\/trees$/.test(c.path))).toBe(
        false,
      );
      expect(namesOf(ticketOf(fx.task, 1).id).work).not.toBe(namesOf(ticketOf(fx.task, 2).id).work);
      expect(fake.prs.map((p) => p.state)).toEqual(['closed']);
    }, 40_000);

    it('does not return the timeout row until the arm has finished and cleaned up', async () => {
      const { fx, scratch, prepared } = await verified();
      let cleaned = false;
      const stubborn: Arm = {
        name: 'factory',
        scripted: false,
        async run() {
          await sleep(400);
          cleaned = true;
          throw new Error('late');
        },
      };
      const row = await runTask({ ...fx.task, timeoutMs: 50 }, 1, prepared, {
        arm: stubborn,
        runner: localRunner,
        scratch,
      });
      expect(row.outcome).toBe('timeout');
      expect(cleaned).toBe(true);
    });

    it('abandons an arm that never stops, after the grace, and says so on the row', async () => {
      const { fx, scratch, prepared } = await verified();
      const stuck: Arm = { name: 'factory', scripted: false, run: () => new Promise(() => {}) };
      const row = await Promise.race([
        runTask({ ...fx.task, timeoutMs: 50 }, 1, prepared, {
          arm: stuck,
          runner: localRunner,
          scratch,
          settleMs: 200,
        }),
        sleep(3000).then(() => 'hung' as const),
      ]);
      expect(row).not.toBe('hung');
      expect(row).toMatchObject({
        outcome: 'timeout',
        note: expect.stringContaining('had not stopped 200 ms after the abort'),
      });
    });

    it('kills the cages the moment the run is aborted, and only then', async () => {
      let killed = 0;
      const inner: Arm = {
        name: 'baseline',
        scripted: false,
        async run() {
          return {
            files: [],
            deleted: [],
            reviewRounds: null,
            tokens: null,
            webRequests: null,
            quotaWindows: null,
            humanMinutes: null,
            note: '',
          };
        },
      };
      const arm = killOnAbort(inner, async () => {
        killed += 1;
      });
      const quiet = new AbortController();
      await arm.run(makeFixture().task, {} as never, quiet.signal, 1);
      expect(killed).toBe(0);
      const stopped = new AbortController();
      await arm.run(makeFixture().task, {} as never, stopped.signal, 1);
      stopped.abort();
      expect(killed).toBe(1);
    });

    it('passes the abort signal to the cage exec and starts no session after an abort', async () => {
      const seen: Array<AbortSignal | undefined> = [];
      const runtime = claudeCode({
        shell: () => ({
          async exec(argv, options) {
            if (argv[0] === 'claude') seen.push(options?.signal);
            return {
              code: 0,
              out: argv[0] === 'claude' ? '{"type":"result","subtype":"success","result":""}' : 'x\n',
              err: '',
              timedOut: false,
            };
          },
        }),
      });
      const controller = new AbortController();
      const job = {
        role: 'reviewer',
        task: 't/x',
        worker: 'w',
        ticket: ticketOf(makeFixture().task, 1),
        round: 1,
        change: {},
        files: [],
        signal: controller.signal,
      } as unknown as AgentJob;
      await runtime.run(job).catch(() => {});
      expect(seen[0]).toBe(controller.signal);
      controller.abort();
      await expect(runtime.run(job)).rejects.toThrow('aborted');
      expect(seen).toHaveLength(1);
    });

    it('pushes nothing after the mode is closed under a session that is still running', async () => {
      const fake = new FakeGithub(REPO);
      let started: () => void = () => {};
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const runtime: AgentRuntime = {
        id: 'scripted',
        async run() {
          started();
          await sleep(400);
          return { role: 'author', files: slug(FIXED), message: 'm', usage: null };
        },
      };
      const ticket = ticketOf(makeFixture().task, 1);
      const hq = await startHq({
        home: tempDir('once-hq'),
        port: 0,
        makeDriver: async () => null,
        mode: cagesMode({
          host: github({ repo: REPO, base: 'main', send: fake.transport('aw-nova'), log: () => {} }),
          repo: REPO,
          base: 'main',
          tickets: { [ticket.id]: ticket },
          author: AUTHOR,
          reviewer: REVIEWER,
          workers: { [AUTHOR]: runtime, [REVIEWER]: runtime },
          pollMs: 30,
        }),
      });
      await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: ticket.id }) });
      await began;
      await hq.close();
      await sleep(100);
      expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });
  },
);

describe('the time a run may take', () => {
  const task = makeFixture().task as TaskA;

  it('is the task limit for one session, a multiple of it for the crew, and exactly --timeout-ms when given', () => {
    expect(timeoutOf(task, undefined, 1)).toBe(task.timeoutMs);
    expect(timeoutOf(task, undefined, 4)).toBe(4 * task.timeoutMs);
    expect(timeoutOf(task, '90000', 4)).toBe(90_000);
  });

  it.each(['abc', '', '0', '-5', '1.5', '2147483648', 'Infinity', '1e3x'])('refuses --timeout-ms %j', (raw) => {
    expect(() => timeoutOf(task, raw, 4)).toThrow('--timeout-ms must be a whole number');
  });

  it('gives every run its own ticket, base branch and work branch', () => {
    const one = namesOf(ticketOf(task, 1).id);
    const two = namesOf(ticketOf(task, 2).id);
    expect(ticketOf(task, 2).id).toMatch(/^bench\/t-[0-9a-f]{8}-r2$/);
    expect(one.base).not.toBe(two.base);
    expect(one.work).not.toBe(two.work);
  });

  it('refuses a task whose own limit cannot be a timer, before the arm starts', async () => {
    const { fx, scratch, prepared } = await verified();
    let ran = false;
    const arm: Arm = {
      name: 'factory',
      scripted: false,
      async run() {
        ran = true;
        throw new Error('no');
      },
    };
    await expect(
      runTask({ ...fx.task, timeoutMs: Number('abc') }, 1, prepared, { arm, runner: localRunner, scratch }),
    ).rejects.toThrow('whole number');
    expect(ran).toBe(false);
  });
});
