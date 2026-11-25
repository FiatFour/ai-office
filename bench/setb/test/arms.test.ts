import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CageShell } from '../../../server/agents/claude-code.ts';
import { claudeCode } from '../../../server/agents/claude-code.ts';
import { parseReview } from '../../../server/agents/runtime.ts';
import { scripted } from '../../../server/agents/scripted.ts';
import { type HttpRequest, type Transport, WriteRefused, writeProblem } from '../../../server/githost/host.ts';
import { FakeGithub } from '../../../server/test/fakes/github-api.ts';
import { canSpawnTs, hasSqlite, tempDir } from '../../../server/test/helpers.ts';
import { factoryArm, ticketOf } from '../../arms-live.ts';
import { TaskRefused } from '../../model.ts';
import {
  AUTHOR,
  adoptable,
  BASE_PREFIX,
  BENCH_LABEL,
  baseNameOf,
  benchHost,
  benchWrites,
  CI_PARALLEL,
  ciPending,
  hiddenTask,
  listRemote,
  orphansOf,
  publicEnv,
  publishBaseline,
  REVIEWER,
  resetAt,
  resumeBranch,
  type Step,
  stopLine,
  stopOf,
  sweepRemote,
  waitForCiSlot,
  withStderr,
} from '../arms.ts';
import {
  appendLine,
  claimIntent,
  newSalt,
  pinBase,
  readJournal,
  setAsideTorn,
  TRANSIENT_CAP,
  transientCount,
} from '../journal.ts';
import { acquireLock } from '../lock.ts';
import type { Ci } from '../packet.ts';
import { appendRun, classify, driveArms, entriesOf, finish, isFinal, type RunRecord, readRuns, todo } from '../run.ts';
import { loadFrozen, type SetBTask } from '../task.ts';

const REPO = 'acme/app';
const tasks = loadFrozen(join(import.meta.dirname, '..')).tasks;

const harness = () => {
  const fake = new FakeGithub(REPO, 'success');
  const root = fake.refs.get('main') ?? '';
  const labels: Array<{ pr: number; labels: unknown }> = [];
  const log: string[] = [];
  const plain = fake.transport('aw-nova');
  const send: Transport = async (request: HttpRequest) => {
    const m = /\/issues\/(\d+)\/labels$/.exec(request.path);
    if (request.method === 'POST' && m !== null) {
      fake.calls.push(request);
      labels.push({ pr: Number(m[1]), labels: (request.body as { labels: unknown }).labels });
      return { status: 200, body: [] };
    }
    return plain(request);
  };
  return {
    fake,
    root,
    labels,
    log,
    send,
    note: (c: { method: string; path: string }) => log.push(`${c.method} ${c.path}`),
  };
};

const FILE = 'src/slug.js';

describe('the bench host on the public repo', () => {
  const ticket = 'bench/t-0a1b2c3d-r1';
  const make = (h: ReturnType<typeof harness>) =>
    benchHost({ repo: REPO, base: baseNameOf(ticket), baseSha: h.root, send: h.send, log: h.note });

  it('seeds the base at the pinned sha only, opens a draft PR with the aw-bench label, and merges nothing', async () => {
    const h = harness();
    const bench = make(h);
    await bench.seedBase();
    expect(h.fake.refs.get(baseNameOf(ticket))).toBe(h.root);
    const head = await bench.host.pushFiles(REPO, {
      branch: `aw/${ticket}`,
      base: baseNameOf(ticket),
      files: [{ path: FILE, content: 'fixed\n' }],
      message: 'fix it',
    });
    const change = await bench.host.openChange(REPO, {
      branch: `aw/${ticket}`,
      base: baseNameOf(ticket),
      title: 'fix it',
      body: 'body',
    });
    expect(change.headSha).toBe(head);
    expect(h.fake.prs.map((p) => ({ draft: p.draft, base: p.base }))).toEqual([
      { draft: true, base: baseNameOf(ticket) },
    ]);
    expect(h.labels).toEqual([{ pr: 1, labels: [BENCH_LABEL] }]);
    expect(h.fake.calls.some((c) => /merge/.test(c.path))).toBe(false);
    expect(h.fake.refs.get('main')).toBe(h.root);
  });

  it('refuses a base ref outside the bench prefix', async () => {
    const h = harness();
    const outside = benchHost({ repo: REPO, base: 'main', baseSha: h.root, send: h.send, log: h.note });
    await expect(outside.seedBase()).rejects.toThrow(WriteRefused);
    expect(BASE_PREFIX).toBe('aw-bench-base/');
    expect(h.fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses a push that changes anything under .github or CODEOWNERS before a single write', async () => {
    const h = harness();
    const bench = make(h);
    await bench.seedBase();
    const before = h.fake.calls.length;
    for (const path of [
      '.github/workflows/ci.yml',
      '.GitHub/x.yml',
      '.github/../.github/y',
      'CODEOWNERS',
      'docs/CODEOWNERS',
    ]) {
      await expect(
        bench.host.pushFiles(REPO, {
          branch: `aw/${ticket}`,
          base: baseNameOf(ticket),
          files: [
            { path: FILE, content: 'ok\n' },
            { path, content: 'x' },
          ],
          message: 'm',
        }),
        path,
      ).rejects.toThrow(/under \.github/);
    }
    expect(h.fake.calls.length).toBe(before);
  });

  it('closes only the PRs of its own work branch and never merges', async () => {
    const h = harness();
    const bench = make(h);
    await bench.seedBase();
    await bench.host.pushFiles(REPO, {
      branch: `aw/${ticket}`,
      base: baseNameOf(ticket),
      files: [{ path: FILE, content: 'a\n' }],
      message: 'm',
    });
    await bench.host.openChange(REPO, { branch: `aw/${ticket}`, base: baseNameOf(ticket), title: 't', body: 'b' });
    await expect(bench.closeWork('aw/alpha/t1')).rejects.toThrow(TaskRefused);
    expect(await bench.closeWork(`aw/${ticket}`)).toEqual([1]);
    expect(h.fake.prs.map((p) => ({ state: p.state, merged: p.merged }))).toEqual([{ state: 'closed', merged: false }]);
    await bench.dropRefs(`aw/${ticket}`);
    await bench.dropRefs(`aw/${ticket}`);
    expect(h.fake.refs.has(`aw/${ticket}`)).toBe(false);
    expect(h.fake.refs.has(baseNameOf(ticket))).toBe(false);
    expect(h.fake.refs.get('main')).toBe(h.root);
    expect(h.fake.calls.some((c) => /merge/.test(c.path))).toBe(false);
  });

  it('writes nothing outside its allowlist: no merge, no ready PR, no other label, no main', async () => {
    const h = harness();
    const writes = benchHost({ repo: REPO, base: baseNameOf(ticket), baseSha: h.root, send: h.send, log: h.note });
    await writes.seedBase();
    await expect(writes.dropRefs('main')).rejects.toThrow();
    expect(h.fake.refs.has('main')).toBe(true);
  });
});

describe('what a bench write may be', () => {
  const sha = 'c'.repeat(40);
  const base = 'aw-bench-base/t-0a1b2c3d-r1';
  const head = 'aw/bench/t-0a1b2c3d-r1';
  const home = `/repos/${REPO}`;
  const scope = { home, base };
  const problem = (method: HttpRequest['method'], path: string, body?: unknown) =>
    writeProblem(
      benchWrites(sha),
      body === undefined ? { method, path: `${home}${path}` } : { method, path: `${home}${path}`, body },
      scope,
    );

  it('allows the base ref, a draft PR, the aw-bench label, a close and a delete of its own branches', () => {
    expect(problem('POST', '/git/refs', { ref: `refs/heads/${base}`, sha })).toBeNull();
    expect(problem('POST', '/pulls', { title: 't', body: 'b', head, base, draft: true })).toBeNull();
    expect(problem('POST', '/issues/3/labels', { labels: [BENCH_LABEL] })).toBeNull();
    expect(problem('PATCH', '/pulls/3', { state: 'closed' })).toBeNull();
    expect(problem('DELETE', `/git/refs/heads/${head}`)).toBeNull();
    expect(problem('DELETE', `/git/refs/heads/${base}`)).toBeNull();
  });

  it('refuses a merge, a ready PR, another label, another sha, main, and a PR on another base', () => {
    const bad: Array<[HttpRequest['method'], string, unknown?]> = [
      ['PUT', '/pulls/3/merge', {}],
      ['POST', '/pulls/3/merge', {}],
      ['POST', '/pulls', { title: 't', body: 'b', head, base, draft: false }],
      ['POST', '/pulls', { title: 't', body: 'b', head, base }],
      ['POST', '/pulls', { title: 't', body: 'b', head, base: 'main', draft: true }],
      ['POST', '/issues/3/labels', { labels: ['bug'] }],
      ['POST', '/issues/3/labels', { labels: [BENCH_LABEL, 'bug'] }],
      ['POST', '/git/refs', { ref: `refs/heads/${base}`, sha: 'd'.repeat(40) }],
      ['POST', '/git/refs', { ref: 'refs/heads/main', sha }],
      ['PATCH', '/pulls/3', { state: 'open' }],
      ['PATCH', '/pulls/3', { state: 'closed', title: 'x' }],
      ['DELETE', '/git/refs/heads/main'],
      ['DELETE', '/git/refs/heads/aw/alpha/t1'],
      ['DELETE', '/git/refs/heads/aw-bench-base/main'],
      ['PATCH', '/git/refs/heads/main', { sha, force: true }],
    ];
    for (const [method, path, body] of bad) expect(problem(method, path, body), `${method} ${path}`).not.toBeNull();
  });
});

describe.skipIf(!hasSqlite)('the factory arm on the public repo, with a scripted crew', () => {
  it('opens one draft labelled PR on a random branch and base, at the head the review settled on', async () => {
    const h = harness();
    const FIX = 'export const x = 1;\n';
    const script = {
      author: [{ files: [{ path: FILE, content: FIX }] }],
      reviews: [{ verdict: 'approve' as const, body: 'ok', comments: [] }],
    };
    const runtime = scripted({ scripts: new Proxy({}, { get: () => script }) as never });
    const withUsage = {
      id: runtime.id,
      async run(job: Parameters<typeof runtime.run>[0]) {
        const said = await runtime.run(job);
        const result =
          said.role === 'reviewer'
            ? { role: 'reviewer' as const, ...parseReview(`\`\`\`json\n${JSON.stringify(said)}\n\`\`\``) }
            : said;
        return {
          ...result,
          usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 1000, webRequests: 0 },
        };
      },
    };
    const task = tasks[0] as SetBTask;
    const hidden = hiddenTask(task, 'ab12cd34') as never;
    const env = publicEnv({
      repo: REPO,
      baseSha: h.root,
      send: h.send,
      log: h.note,
      workers: { [AUTHOR]: withUsage, [REVIEWER]: withUsage },
      home: () => tempDir('setb-hq'),
      pollMs: 30,
      settleMs: 10,
      reviewPollMs: 30,
    });
    const ran = await factoryArm(env).run(hidden, undefined as never, new AbortController().signal, 1);
    expect(ran.note).toContain('PR #1');
    expect(ran.tokens).toMatchObject({ input: 2, output: 20 });
    const [pr] = h.fake.prs;
    expect(pr).toMatchObject({ draft: true, state: 'open', merged: false });
    expect(pr?.head).toMatch(/^aw\/bench\/t-[0-9a-f]{8}-r1$/);
    expect(pr?.base).toMatch(/^aw-bench-base\/t-[0-9a-f]{8}-r1$/);
    expect(`${pr?.head}${pr?.base}`).not.toContain(task.id);
    expect(h.labels).toEqual([{ pr: 1, labels: [BENCH_LABEL] }]);
    expect(h.fake.calls.some((c) => /merge/.test(c.path) || (c.method === 'PATCH' && /pulls/.test(c.path)))).toBe(
      false,
    );
    expect(h.fake.filesAt(pr?.head ?? '').get(FILE)).toBe(FIX);
  });
});

describe('the quota and login stops', () => {
  it('reads a usage limit, a revoked login and an ordinary failure apart', () => {
    expect(stopOf("You've hit your limit · resets 3pm (Asia/Bangkok)")).toBe('quota');
    expect(stopOf('Claude AI usage limit reached|1764000000')).toBe('quota');
    expect(stopOf('API Error: OAuth token revoked')).toBe('auth');
    expect(stopOf('Failed to authenticate. API Error: 401')).toBe('auth');
    expect(stopOf('Failed to authenticate; usage limit reached')).toBe('auth');
    expect(stopOf('the agent ran past its timeout')).toBeNull();
  });

  it('reads a provider overload or rate limit as transient, never as a usage limit or a task failure', () => {
    expect(stopOf('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe('transient');
    expect(stopOf('API Error: 429 rate_limit_error')).toBe('transient');
    expect(stopOf('claude ended with error_during_execution: overloaded_error')).toBe('transient');
    expect(classify('API Error: 529 overloaded_error', new Date()).status).toBe('transient');
    expect(classify("You've hit your limit · resets 3pm (UTC)", new Date()).status).toBe('quota');
    expect(classify('the tests failed', new Date()).status).toBe('failed');
  });

  it('does not read a task text that talks about rate limits as a stop', () => {
    for (const text of [
      'Make the rate-limit check reject a burst; the usage limit is 5 per minute',
      'claude ended with success: I added a rate limit and a usage limit to the docs',
      'the limit reached the end of the list',
    ])
      expect(stopOf(text), text).toBeNull();
  });

  it('matches only a provider message at the start of a line or of what claude ended with, not a model sentence', () => {
    for (const text of [
      "claude ended with error_max_turns: You've hit your max turns; tests still fail",
      "claude ended with success: You've hit your limit of retries in this test",
      'claude ended with success: I handled the case where Claude AI usage limit reached|1 is printed',
      'claude ended with success: the code now retries on API Error: 529',
      'claude ended with success: it logs OAuth token revoked and Failed to authenticate',
    ])
      expect(stopOf(text), text).toBeNull();
    for (const text of [
      "You've hit your limit · resets 3pm (UTC)",
      "You've hit your session limit · resets 3pm (UTC)",
      "You've hit your org's monthly usage limit",
      '5-hour limit reached ∙ resets 3pm (Asia/Bangkok)',
      "bench/t-0a1b2c3d-r1 author 0 failed: claude ended with success: You've hit your weekly limit · resets 9am",
      'no retry after the first failure: x failed: claude ended with an error: Claude AI usage limit reached|1764000000',
      'Error: out of extra usage · resets 3pm',
    ])
      expect(stopOf(text), text).toBe('quota');
  });

  it('puts an auth line before a usage-limit line, in whatever order they were printed', () => {
    const both = 'Claude AI usage limit reached|1764000000\nFailed to authenticate. API Error: 401\n';
    expect(stopLine(both)).toMatch(/^Failed to authenticate/);
    expect(stopOf(both)).toBe('auth');
  });

  describe('claude stderr', () => {
    const shell = (err: string, out: string, code: number): CageShell => ({
      async exec(argv) {
        if (argv.includes('rev-parse')) return { code: 0, out: 'abc123\n', err: '', timedOut: false };
        return { code, out, err, timedOut: false };
      },
    });
    const job = {
      role: 'author' as const,
      task: 'bench/t-0a1b2c3d-r1',
      worker: 'baseline',
      ticket: { id: 'bench/t-0a1b2c3d-r1', kind: 'defect' as const, title: 't', body: 'b', url: null, risk: null },
      round: 0,
      comments: [],
      signal: new AbortController().signal,
    };
    const message = async (err: string, out = '', code = 1): Promise<string> => {
      try {
        await claudeCode({ shell: () => withStderr(shell(err, out, code)) }).run(job);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('claude did not fail');
    };

    it('reads a usage limit printed only to stderr as a quota stop, not a task failure', async () => {
      const m = await message('Claude AI usage limit reached|1764000000\nsomething else\n');
      expect(m).not.toMatch(/no result line/);
      expect(classify(m, new Date()).status).toBe('quota');
    });

    it('reads an overload printed only to stderr as transient', async () => {
      const m = await message('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}\n');
      expect(classify(m, new Date()).status).toBe('transient');
    });

    it('reads a revoked login on stderr as auth', async () => {
      expect(classify(await message('Failed to authenticate. API Error: 401\n'), new Date()).status).toBe('auth');
    });

    it('leaves an ordinary stderr as a failure of the task', async () => {
      expect(classify(await message('Segmentation fault\n'), new Date()).status).toBe('failed');
    });

    const resultOf = (result: string, subtype = 'error_during_execution', is_error = true): string =>
      `${JSON.stringify({ type: 'result', subtype, is_error, result })}\n`;
    const status = async (err: string, out = '', code = 1) =>
      classify(await message(err, out, code), new Date()).status;
    const QUOTA_LINE = 'Claude AI usage limit reached|1764000000\n';
    const AUTH_LINE = 'Failed to authenticate. API Error: 401\n';

    it('reads auth when a usage limit and an auth line are both printed, wherever each is', async () => {
      expect(await status(`${QUOTA_LINE}${AUTH_LINE}`)).toBe('auth');
      expect(await status(AUTH_LINE, resultOf("You've hit your limit · resets 3pm"))).toBe('auth');
      expect(await status(AUTH_LINE, resultOf('tests broke', 'success'))).toBe('auth');
      expect(await status(QUOTA_LINE, AUTH_LINE)).toBe('auth');
      expect(await status(QUOTA_LINE, resultOf('OAuth token revoked'))).toBe('auth');
    });

    it('reads an empty reply with exit 0 as transient, and an empty reply with exit 1 as a failure', async () => {
      expect(await status('', '', 0)).toBe('transient');
      expect(await status('some warning\n', '', 0)).toBe('transient');
      expect(await status(QUOTA_LINE, '', 0)).toBe('quota');
      expect(await status('', '', 1)).toBe('failed');
    });

    it('reads a quota on stderr when stdout says only Execution error', async () => {
      expect(await status(QUOTA_LINE, 'Execution error\n')).toBe('quota');
      expect(await status(QUOTA_LINE, resultOf('Execution error'))).toBe('quota');
      expect(await status(QUOTA_LINE, resultOf(''))).toBe('quota');
    });

    it('does not override a successful result with what stderr says', async () => {
      const ran = await withStderr(shell(AUTH_LINE, resultOf('done', 'success', false), 0)).exec([
        'claude',
        '--output-format',
        'stream-json',
      ]);
      expect(ran.out).toBe(resultOf('done', 'success', false));
    });

    it('leaves a stream that has its own result line alone', async () => {
      const out = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'tests broke' })}\n`;
      const m = await message("You've hit your limit", out);
      expect(m).toContain('tests broke');
      expect(classify(m, new Date()).status).toBe('failed');
    });
  });

  it('turns the stated reset time into the next such time, in the stated zone', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    expect(resetAt('Claude AI usage limit reached|1764000000', now)).toBe(1764000000_000);
    const at = resetAt("You've hit your limit · resets 3pm (Asia/Bangkok)", now) as number;
    expect(new Date(at).toISOString()).toBe('2026-11-25T08:00:00.000Z'.replace('25T08', '26T08'));
    expect(resetAt('resets 5:30pm (UTC)', now)).toBe(Date.parse('2026-11-25T17:30:00Z'));
    expect(resetAt('resets 9am (UTC)', now)).toBe(Date.parse('2026-11-26T09:00:00Z'));
    expect(resetAt('no time here', now)).toBeNull();
  });
});

describe('the CI cap', () => {
  const ci = (state: Ci['state']): Ci => ({ sha: 'a'.repeat(40), state, note: '', checks: 1 });

  it('treats running CI as pending, and a head with no checks yet as pending only while it is fresh', () => {
    expect(ciPending(ci('pending'), 0, 1e9)).toBe(true);
    expect(ciPending(ci('green'), 0, 1e9)).toBe(false);
    expect(ciPending(ci('red'), 0, 1e9)).toBe(false);
    expect(ciPending(ci('none'), 1e9 - 60_000, 1e9)).toBe(true);
    expect(ciPending(ci('none'), 1e9 - 3_600_000, 1e9)).toBe(false);
  });

  it('waits while 2 heads run CI and goes on the moment one finishes', async () => {
    expect(CI_PARALLEL).toBe(2);
    const state = new Map<string, Ci['state']>([
      ['a', 'pending'],
      ['b', 'pending'],
      ['c', 'green'],
    ]);
    const slept: number[] = [];
    const heads = ['a', 'b', 'c'].map((sha) => ({ sha, since: 0 }));
    await waitForCiSlot(
      heads,
      async (sha) => ci(state.get(sha) ?? 'green'),
      async (ms) => {
        slept.push(ms);
        if (slept.length === 3) state.set('b', 'green');
      },
      () => 1e12,
    );
    expect(slept).toHaveLength(3);
    await waitForCiSlot(
      heads.slice(0, 1),
      async () => ci('pending'),
      async () => expect.unreachable(),
      () => 1e12,
    );
  });
});

describe('the run log', () => {
  const rec = (
    task: string,
    arm: 'factory' | 'baseline',
    status: RunRecord['status'],
    pr: number | null = null,
  ): RunRecord => ({
    task,
    arm,
    status,
    stage: 1,
    branch: null,
    pr,
    readyHeadSha: pr === null ? null : 'b'.repeat(40),
    wallMs: 1,
    tokens: null,
    reviewRounds: null,
    note: '',
    startedAt: '2026-11-25T00:00:00Z',
    resetAt: null,
    baseSha: 'c'.repeat(40),
  });

  it('alternates which arm goes first, skips final runs and reruns a quota or auth stop', () => {
    const first = todo(tasks, []);
    expect(first).toHaveLength(20);
    expect(first.slice(0, 4).map((t) => t.arm)).toEqual(['factory', 'baseline', 'baseline', 'factory']);
    const id = (tasks[0] as SetBTask).id;
    const left = todo(tasks, [rec(id, 'factory', 'done', 5), rec(id, 'baseline', 'quota')]);
    expect(left).toHaveLength(19);
    expect(left[0]).toMatchObject({ arm: 'baseline' });
    expect(todo(tasks, [rec(id, 'factory', 'failed')]).some((t) => t.task.id === id && t.arm === 'factory')).toBe(
      false,
    );
    expect(isFinal(rec(id, 'factory', 'auth'))).toBe(false);
    expect(isFinal(rec(id, 'factory', 'aborted'))).toBe(false);
  });

  it('lists only done runs with a PR as graded entries, and round-trips the file', () => {
    const file = join(tempDir('setb-runs'), 'out', 'runs.jsonl');
    const id = (tasks[0] as SetBTask).id;
    for (const r of [
      rec(id, 'factory', 'done', 7),
      rec(id, 'baseline', 'failed', 8),
      rec((tasks[1] as SetBTask).id, 'factory', 'quota', 9),
    ])
      appendRun(file, r);
    expect(readRuns(file)).toHaveLength(3);
    expect(entriesOf(tasks, readRuns(file))).toEqual([
      { task: id, arm: 'factory', pr: 7, readyHeadSha: 'b'.repeat(40) },
    ]);
  });
});

class Killed extends Error {}

describe('a killed baseline run resumes without orphans', () => {
  const task = tasks[0] as SetBTask;
  const FIXED = 'export const x = 1;\n';

  const session = (h: ReturnType<typeof harness>, journal: string) => async (killAt?: Step) => {
    const { intent, resumed } = claimIntent(journal, task, 'baseline', h.root);
    const bench = benchHost({ repo: REPO, base: intent.base, baseSha: h.root, send: h.send, log: h.note });
    if (resumed) {
      const adopted = await resumeBranch(bench, REPO, intent.branch, async () => true);
      if (adopted !== null) return adopted;
    }
    const ticket = ticketOf(hiddenTask(task, intent.salt) as never, 1);
    const made = await publishBaseline({
      bench,
      repo: REPO,
      branch: intent.branch,
      base: intent.base,
      ticket,
      files: [{ path: FILE, content: FIXED }],
      after: (step) => {
        if (step === killAt) throw new Killed(step);
      },
    });
    return made.change;
  };

  it.each(['seedBase', 'push', 'openChange'] as const)(
    'after %s: the rerun opens exactly one PR for the task and arm and leaves nothing behind',
    async (killAt) => {
      const h = harness();
      const journal = join(tempDir('setb-resume'), 'runs.jsonl');
      const run = session(h, journal);
      await expect(run(killAt)).rejects.toBeInstanceOf(Killed);
      const [intent] = readJournal(journal).intents;
      expect(intent, 'the intent is journaled before the first remote write').toBeDefined();
      const change = await run();
      expect(h.fake.prs, 'one PR in all, open or closed').toHaveLength(1);
      expect(h.fake.prs.filter((p) => p.state === 'open')).toHaveLength(1);
      expect(readJournal(journal).intents, 'the rerun reuses the intent').toEqual([intent]);
      expect(change.number).toBe(1);
      const remote = await listRemote(h.send, REPO);
      expect([...remote.refs].sort()).toEqual([intent?.branch, intent?.base].sort());
      expect(orphansOf(remote, readJournal(journal).intents)).toEqual({ refs: [], pulls: [] });
      const bench = benchHost({ repo: REPO, base: intent?.base ?? '', baseSha: h.root, send: h.send, log: h.note });
      const swept = await sweepRemote(bench, remote);
      expect(swept.closed).toEqual([1]);
      expect([...h.fake.refs.keys()].filter((r) => /^aw/.test(r))).toEqual([]);
      expect(h.fake.prs.every((p) => p.state === 'closed' && !p.merged)).toBe(true);
    },
  );

  it.each(['seedBase', 'push'] as const)(
    'finds the refs of a run killed after %s and no PR (pr is null) by prefix, with no journal at all',
    async (killAt) => {
      const h = harness();
      const run = session(h, join(tempDir('setb-resume'), 'runs.jsonl'));
      await expect(run(killAt)).rejects.toBeInstanceOf(Killed);
      expect(h.fake.prs).toHaveLength(0);
      const remote = await listRemote(h.send, REPO);
      expect(remote.refs.length).toBeGreaterThan(0);
      expect(orphansOf(remote, [])).toMatchObject({ pulls: [] });
      expect(orphansOf(remote, []).refs).toEqual(remote.refs);
      const bench = benchHost({
        repo: REPO,
        base: `${BASE_PREFIX}t-00000000-r1`,
        baseSha: h.root,
        send: h.send,
        log: h.note,
      });
      await sweepRemote(bench, remote);
      expect([...h.fake.refs.keys()].filter((r) => /^aw/.test(r))).toEqual([]);
    },
  );

  it('opens the baseline PR with the same title, body and commit message template as the factory', async () => {
    const h = harness();
    const journal = join(tempDir('setb-resume'), 'runs.jsonl');
    await session(h, journal)();
    const [intent] = readJournal(journal).intents;
    const id = intent?.branch.replace(/^aw\//, '') ?? '';
    const [pr] = h.fake.prs;
    expect(pr?.title).toBe(`${id}: ${task.title}`);
    expect(pr?.body).toContain(`Work order \`${id}\``);
    expect(pr?.body).toContain('Opened by an Agent Works worker');
  });

  it('sweeps by prefix and never touches main', async () => {
    const h = harness();
    const run = session(h, join(tempDir('setb-resume'), 'runs.jsonl'));
    await run();
    const bench = benchHost({
      repo: REPO,
      base: `${BASE_PREFIX}t-00000000-r1`,
      baseSha: h.root,
      send: h.send,
      log: h.note,
    });
    await sweepRemote(bench, await listRemote(h.send, REPO));
    expect(h.fake.refs.has('main')).toBe(true);
  });

  it('refuses to sweep when a bench PR is merged', async () => {
    const h = harness();
    await session(h, join(tempDir('setb-resume'), 'runs.jsonl'))();
    h.fake.mergeByHuman(1);
    const bench = benchHost({
      repo: REPO,
      base: `${BASE_PREFIX}t-00000000-r1`,
      baseSha: h.root,
      send: h.send,
      log: h.note,
    });
    await expect(sweepRemote(bench, await listRemote(h.send, REPO))).rejects.toThrow(/merged/);
  });

  it('a rerun after a stop that left a PR open adopts that PR (baseline), on the same branch', async () => {
    const h = harness();
    const journal = join(tempDir('setb-resume'), 'runs.jsonl');
    const run = session(h, journal);
    const first = await run();
    const second = await run();
    expect(second.number).toBe(first.number);
    expect(h.fake.prs).toHaveLength(1);
  });

  it('closes an unsettled PR of a resumed arm and drops its refs, so the arm starts from nothing on the same names', async () => {
    const h = harness();
    const journal = join(tempDir('setb-resume'), 'runs.jsonl');
    const first = await session(h, journal)();
    const { intent } = claimIntent(journal, task, 'baseline', h.root);
    const bench = benchHost({ repo: REPO, base: intent.base, baseSha: h.root, send: h.send, log: h.note });
    const taken = await resumeBranch(bench, REPO, intent.branch, async () => false);
    expect(taken).toBeNull();
    expect(h.fake.prs.find((p) => p.number === first.number)?.state).toBe('closed');
    expect(h.fake.refs.has(intent.branch)).toBe(false);
    expect(h.fake.refs.has(intent.base)).toBe(false);
  });
});

describe('the journal', () => {
  const task = tasks[0] as SetBTask;

  it('writes the intent before any remote write, and a resume reuses its salt, branch and base', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    const first = claimIntent(file, task, 'factory', 'a'.repeat(40), () => 'deadbeef');
    expect(first.resumed).toBe(false);
    expect(readJournal(file).intents).toEqual([first.intent]);
    expect(first.intent).toMatchObject({ task: task.id, arm: 'factory', salt: 'deadbeef', baseSha: 'a'.repeat(40) });
    expect(first.intent.branch).toMatch(/^aw\/bench\/t-[0-9a-f]{8}-r1$/);
    expect(first.intent.base).toMatch(/^aw-bench-base\/t-[0-9a-f]{8}-r1$/);
    const again = claimIntent(file, task, 'factory', 'a'.repeat(40), () => 'cafef00d');
    expect(again).toEqual({ intent: first.intent, resumed: true });
    const other = claimIntent(file, task, 'baseline', 'a'.repeat(40), () => 'cafef00d');
    expect(other.resumed).toBe(false);
    expect(other.intent.branch).not.toBe(first.intent.branch);
    expect(newSalt()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pins the base on the first line and refuses a different --base-sha afterwards', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    pinBase(file, 'a'.repeat(40));
    pinBase(file, 'a'.repeat(40));
    expect(readJournal(file).header).toMatchObject({ kind: 'header', baseSha: 'a'.repeat(40) });
    expect(() => pinBase(file, 'b'.repeat(40))).toThrow(/pinned to base a+, not b+/);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('refuses a header that disagrees with the base of an intent or of a run record', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    for (const record of [
      { kind: 'intent', task: 'x', arm: 'factory', baseSha: A },
      { task: 'x', arm: 'factory', status: 'done', baseSha: A },
    ]) {
      const file = join(tempDir('setb-journal'), 'runs.jsonl');
      appendLine(file, { kind: 'header', baseSha: B, createdAt: 'x' });
      appendLine(file, record);
      expect(() => pinBase(file, B)).toThrow(/a record for x factory says a+/);
    }
  });

  it('skips a torn last line without losing a whole one, and sets it aside before the next append', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    pinBase(file, 'a'.repeat(40));
    const { intent } = claimIntent(file, task, 'factory', 'a'.repeat(40));
    const torn = '{"kind":"intent","task":"x';
    appendFileSync(file, torn);
    expect(readJournal(file)).toMatchObject({ intents: [intent], torn });
    pinBase(file, 'a'.repeat(40));
    const next = claimIntent(file, task, 'baseline', 'a'.repeat(40));
    expect(readJournal(file)).toMatchObject({ intents: [intent, next.intent], torn: null });
    expect(readFileSync(`${file}.torn`, 'utf8')).toBe(`${torn}\n`);
    expect(setAsideTorn(file)).toBeNull();
  });

  it('keeps a whole last line that only lacks its newline, and appends after it', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    writeFileSync(file, JSON.stringify({ kind: 'intent', task: 'x' }));
    appendLine(file, { kind: 'intent', task: 'y' });
    expect(readJournal(file).intents.map((i) => i.task)).toEqual(['x', 'y']);
    expect(existsSync(`${file}.torn`)).toBe(false);
  });

  it('refuses a journal that has records but no header', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    claimIntent(file, task, 'factory', 'a'.repeat(40));
    expect(() => pinBase(file, 'a'.repeat(40))).toThrow(/no header/);
  });

  it('counts transient records per task and arm, and a transient record is not final', () => {
    const rec = (status: RunRecord['status'], arm: 'factory' | 'baseline'): RunRecord => ({
      task: task.id,
      arm,
      status,
      stage: 1,
      branch: null,
      pr: null,
      readyHeadSha: null,
      wallMs: 1,
      tokens: null,
      reviewRounds: null,
      note: '',
      startedAt: '2026-11-25T00:00:00Z',
      resetAt: null,
      baseSha: 'c'.repeat(40),
    });
    const runs = [rec('transient', 'factory'), rec('transient', 'factory'), rec('transient', 'baseline')];
    expect(TRANSIENT_CAP).toBe(3);
    expect(transientCount(runs, task.id, 'factory')).toBe(2);
    expect(isFinal(rec('transient', 'factory'))).toBe(false);
    expect(todo(tasks, runs).some((t) => t.task.id === task.id && t.arm === 'factory')).toBe(true);
  });
});

describe('how a finished arm is recorded', () => {
  const ran = { note: 'n', tokens: null, reviewRounds: 2 } as never;

  it('records a host refusal after round 0 as a final failure, never as done on the rejected head', () => {
    const out = finish(
      { ...(ran as object), refused: true } as never,
      { number: 7, headSha: 'f'.repeat(40) },
      'aw/bench/t-0a1b2c3d-r1',
    );
    expect(out).toMatchObject({ status: 'failed', pr: 7, readyHeadSha: null });
    expect(isFinal({ status: out.status } as RunRecord)).toBe(true);
  });

  it('records a normal finish with a PR as done at its head, and one without a PR as a failure', () => {
    expect(finish(ran, { number: 7, headSha: 'f'.repeat(40) }, 'b')).toMatchObject({
      status: 'done',
      pr: 7,
      readyHeadSha: 'f'.repeat(40),
    });
    expect(finish(ran, null, 'aw/b')).toMatchObject({ status: 'failed', pr: null });
  });
});

describe.skipIf(!hasSqlite)('a factory refusal after round 0', () => {
  it('is flagged refused by the arm, so a live run records it as failed', async () => {
    const h = harness();
    const refuses = {
      id: 'claude-code' as const,
      async run(): Promise<never> {
        throw new WriteRefused('refusing a write');
      },
    };
    const env = publicEnv({
      repo: REPO,
      baseSha: h.root,
      send: h.send,
      log: h.note,
      workers: { [AUTHOR]: refuses, [REVIEWER]: refuses },
      home: () => tempDir('setb-hq'),
      pollMs: 30,
      settleMs: 10,
      reviewPollMs: 30,
    });
    const arm = await factoryArm(env).run(
      hiddenTask(tasks[0] as SetBTask, 'ab12cd34') as never,
      undefined as never,
      new AbortController().signal,
      1,
    );
    expect(arm.refused).toBe(true);
    expect(arm.note).toMatch(/nothing is graded/);
  });
});

describe('a PR killed before it was labelled', () => {
  it('is still found by its head prefix and closed', async () => {
    const h = harness();
    const unlabelled: Transport = async (request) => {
      if (/\/labels$/.test(request.path)) throw new Killed('labels');
      return h.send(request);
    };
    const [task] = tasks as [SetBTask];
    const intent = claimIntent(join(tempDir('setb-label'), 'runs.jsonl'), task, 'baseline', h.root).intent;
    const bench = benchHost({ repo: REPO, base: intent.base, baseSha: h.root, send: unlabelled, log: h.note });
    await expect(
      publishBaseline({
        bench,
        repo: REPO,
        branch: intent.branch,
        base: intent.base,
        ticket: ticketOf(hiddenTask(task, intent.salt) as never, 1),
        files: [{ path: FILE, content: 'x\n' }],
      }),
    ).rejects.toBeInstanceOf(Killed);
    const remote = await listRemote(h.send, REPO);
    expect(remote.pulls.map((p) => ({ number: p.number, labelled: p.labelled }))).toEqual([
      { number: 1, labelled: false },
    ]);
    expect((await sweepRemote(bench, remote)).closed).toEqual([1]);
  });
});

describe('which open factory PR a resume keeps', () => {
  const HEAD = 'a'.repeat(40);
  type Seen = [verdict: 'approve' | 'changes' | 'comment', commit: string, worker?: string];
  const snapshot = (...reviews: Seen[]) =>
    ({
      change: { headSha: HEAD },
      reviews: reviews.map(([verdict, commitId, worker = REVIEWER]) => ({
        commitId,
        verdict: 'comment',
        body: `<!-- agent-works:review worker=${worker} verdict=${verdict} -->\nx`,
      })),
      checks: [],
    }) as never;
  const OLD = 'b'.repeat(40);

  it.each<[string, Seen[], boolean]>([
    ['no review', [], false],
    ['an approval of the head', [['approve', HEAD]], true],
    ['a comment on the head', [['comment', HEAD]], true],
    ['an approval of an older head only', [['approve', OLD]], false],
    ['another worker only', [['approve', HEAD, AUTHOR]], false],
    ['changes asked on the head', [['changes', HEAD]], false],
    [
      'an approval and then changes on the head',
      [
        ['approve', HEAD],
        ['changes', HEAD],
      ],
      false,
    ],
    [
      'changes and then an approval of the head',
      [
        ['changes', HEAD],
        ['approve', HEAD],
      ],
      true,
    ],
    [
      'an approval of the head and then changes elsewhere',
      [
        ['approve', HEAD],
        ['changes', OLD],
      ],
      false,
    ],
  ])('%s', (_name, reviews, kept) => {
    expect(adoptable(snapshot(...reviews), REVIEWER)).toBe(kept);
  });

  it('does not keep a PR someone asked changes on through the host after the reviewer approved', () => {
    const seen = snapshot(['approve', HEAD]) as unknown as { reviews: object[] };
    seen.reviews.push({ commitId: HEAD, verdict: 'changes', body: 'please' });
    expect(adoptable(seen as never, REVIEWER)).toBe(false);
  });
});

describe('the drive loop stops', () => {
  const [first, second] = tasks as [SetBTask, SetBTask];
  const items = [
    { task: first, arm: 'factory' as const },
    { task: second, arm: 'factory' as const },
  ];
  const drive = async (statuses: RunRecord['status'][], prior = 0) => {
    const dir = tempDir('setb-drive');
    const runsFile = join(dir, 'runs.jsonl');
    const stopFile = join(dir, 'STOP');
    const record = (task: SetBTask, status: RunRecord['status']): RunRecord => ({
      task: task.id,
      arm: 'factory',
      status,
      stage: 1,
      branch: null,
      pr: null,
      readyHeadSha: null,
      wallMs: 1,
      tokens: null,
      reviewRounds: null,
      note: 'why',
      startedAt: '2026-11-25T00:00:00Z',
      resetAt: null,
      baseSha: 'c'.repeat(40),
    });
    for (let i = 0; i < prior; i += 1) appendRun(runsFile, record(first, 'transient'));
    const ran: string[] = [];
    const slept: number[] = [];
    const code = await driveArms(items, {
      runsFile,
      stopFile,
      stage: 1,
      run: async (task) => {
        ran.push(task.id);
        return record(task, statuses.shift() ?? 'done');
      },
      waitSlot: async () => {},
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { code, ran, slept, stop: existsSync(stopFile), records: readRuns(runsFile).length };
  };

  it('runs every arm and exits 0', async () => {
    expect(await drive(['done', 'failed'])).toMatchObject({ code: 0, ran: [first.id, second.id], stop: false });
  });

  it('retries a transient error, waiting longer each time, and exits 75 at the third', async () => {
    expect(await drive(['transient', 'transient', 'transient'])).toMatchObject({
      code: 75,
      ran: [first.id, first.id, first.id],
      slept: [60_000, 120_000],
      records: 3,
    });
    expect(await drive([], TRANSIENT_CAP)).toMatchObject({ code: 75, ran: [] });
    expect(await drive(['transient', 'done'])).toMatchObject({ code: 0, ran: [first.id, first.id, second.id] });
  });

  it('exits 75 on a usage limit without starting another arm', async () => {
    expect(await drive(['quota'])).toMatchObject({ code: 75, ran: [first.id], stop: false, records: 1 });
  });

  it('writes the STOP file and exits 5 on a login failure', async () => {
    expect(await drive(['auth'])).toMatchObject({ code: 5, ran: [first.id], stop: true });
  });
});

describe('one driver at a time', () => {
  const lockIn = () => join(tempDir('setb-lock'), 'runs.jsonl.lock');
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
  const holder = (pid: number) => JSON.stringify({ pid, startedAt: '2026-11-25T00:00:00Z', command: 'drive' });

  it('refuses a second holder, and gives the lock again after a release', () => {
    const file = lockIn();
    const release = acquireLock(file, 'drive');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid, command: 'drive' });
    expect(Date.parse(JSON.parse(readFileSync(file, 'utf8')).startedAt)).not.toBeNaN();
    expect(() => acquireLock(file, 'close')).toThrow(/held by pid \d+ \(drive, started .*one driver at a time/);
    release();
    expect(existsSync(file)).toBe(false);
    acquireLock(file, 'close')();
  });

  it('takes over a lock whose process is gone, and leaves a lock it cannot read', () => {
    const file = lockIn();
    writeFileSync(file, holder(deadPid()));
    acquireLock(file, 'drive')();
    expect(existsSync(`${file}.break`)).toBe(false);
    writeFileSync(file, '');
    expect(() => acquireLock(file, 'drive')).toThrow(/unreadable lock/);
    expect(existsSync(file)).toBe(true);
  });

  it('lets only one process at a time clear a stale lock', () => {
    const file = lockIn();
    writeFileSync(file, holder(deadPid()));
    writeFileSync(`${file}.break`, '1');
    expect(() => acquireLock(file, 'drive')).toThrow(/clearing a stale lock/);
    expect(readFileSync(file, 'utf8')).toContain('"command":"drive"');
  });

  it('releases only its own lock', () => {
    const file = lockIn();
    const release = acquireLock(file, 'drive');
    writeFileSync(file, holder(process.pid));
    release();
    expect(existsSync(file)).toBe(true);
  });

  describe.skipIf(process.platform === 'win32' || !canSpawnTs)('in a real process', () => {
    const module = pathToFileURL(join(import.meta.dirname, '..', 'lock.ts')).href;

    it.each(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const)('releases the lock on %s', async (how) => {
      const file = lockIn();
      const script = join(tempDir('setb-holder'), 'hold.mjs');
      writeFileSync(
        script,
        `import { holdLock } from ${JSON.stringify(module)};
holdLock(${JSON.stringify(file)}, 'drive');
console.log('held');
if (${JSON.stringify(how)} !== 'exit') setInterval(() => {}, 1000);
`,
      );
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
      const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      await new Promise((resolve) => child.stdout.once('data', resolve));
      if (how !== 'exit') {
        expect(existsSync(file)).toBe(true);
        child.kill(how);
      }
      expect(await done).toBe({ exit: 0, SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[how]);
      expect(existsSync(file)).toBe(false);
    });

    const stage = () => {
      const out = tempDir('setb-cli-lock');
      const bin = join(out, 'bin');
      mkdirSync(bin);
      const touched = join(out, 'touched');
      for (const tool of ['gh', 'git']) {
        writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${touched}'\nexit 1\n`);
        chmodSync(join(bin, tool), 0o755);
      }
      const cli = (command: string) =>
        spawnSync(
          process.execPath,
          [
            join(import.meta.dirname, '..', 'run.ts'),
            command,
            '--base-sha',
            'a'.repeat(40),
            '--home',
            out,
            '--out',
            out,
            '--cache',
            join(out, 'cache'),
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              AW_BENCH_LOGIN_CONFIRMED: '1',
              GH_HOST: '',
              PATH: `${bin}:${process.env.PATH ?? ''}`,
            },
          },
        );
      return { out, touched, cli, lock: join(out, 'runs.jsonl.lock') };
    };

    it.each(['drive', 'close', 'reconcile'])(
      '%s stops before touching the host while another holds the lock',
      (command) => {
        const { touched, cli, lock } = stage();
        writeFileSync(lock, holder(process.pid));
        const ran = cli(command);
        expect(ran.stderr).toMatch(/held by pid/);
        expect(ran.status).toBe(3);
        expect(existsSync(touched)).toBe(false);
        expect(readFileSync(lock, 'utf8')).toBe(holder(process.pid));
      },
    );

    it.each(['drive', 'close', 'reconcile'])('%s reports a torn journal line and goes on to the host', (command) => {
      const { out, touched, cli, lock } = stage();
      const runs = join(out, 'runs.jsonl');
      writeFileSync(
        runs,
        `${JSON.stringify({ kind: 'header', baseSha: 'a'.repeat(40), createdAt: 'x' })}\n{"kind":"inte`,
      );
      const ran = cli(command);
      expect(ran.stderr).toMatch(/ends in a torn line, which is skipped: "\{\\"kind\\":\\"inte"/);
      expect(readFileSync(touched, 'utf8')).toMatch(/^(gh|git) /);
      expect(existsSync(lock), 'the lock is released after a failure').toBe(false);
      expect(existsSync(`${runs}.torn`), 'only drive writes the journal').toBe(command === 'drive');
    });
  });
});
