import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CageShell } from '../../../server/agents/claude-code.ts';
import { claudeCode } from '../../../server/agents/claude-code.ts';
import { parseReview } from '../../../server/agents/runtime.ts';
import { scripted } from '../../../server/agents/scripted.ts';
import { type HttpRequest, type Transport, WriteRefused, writeProblem } from '../../../server/githost/host.ts';
import { FakeGithub } from '../../../server/test/fakes/github-api.ts';
import { hasSqlite, tempDir } from '../../../server/test/helpers.ts';
import { factoryArm, ticketOf } from '../../arms-live.ts';
import { TaskRefused } from '../../model.ts';
import {
  AUTHOR,
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
  stopOf,
  sweepRemote,
  waitForCiSlot,
  withStderr,
} from '../arms.ts';
import { claimIntent, newSalt, pinBase, readJournal, TRANSIENT_CAP, transientCount } from '../journal.ts';
import type { Ci } from '../packet.ts';
import { appendRun, classify, entriesOf, finish, isFinal, type RunRecord, readRuns, todo } from '../run.ts';
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

  describe('claude stderr', () => {
    const shell = (err: string, out = ''): CageShell => ({
      async exec(argv) {
        if (argv.includes('rev-parse')) return { code: 0, out: 'abc123\n', err: '', timedOut: false };
        return { code: 1, out, err, timedOut: false };
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
    const message = async (err: string, out = ''): Promise<string> => {
      try {
        await claudeCode({ shell: () => withStderr(shell(err, out)) }).run(job);
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
  const ci = (state: Ci['state']): Ci => ({ sha: 'a'.repeat(40), state, note: '' });

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
