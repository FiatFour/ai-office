import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReview } from '../../../server/agents/runtime.ts';
import { scripted } from '../../../server/agents/scripted.ts';
import { type HttpRequest, type Transport, WriteRefused, writeProblem } from '../../../server/githost/host.ts';
import { FakeGithub } from '../../../server/test/fakes/github-api.ts';
import { tempDir } from '../../../server/test/helpers.ts';
import { factoryArm } from '../../arms-live.ts';
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
  publicEnv,
  REVIEWER,
  resetAt,
  stopOf,
  waitForCiSlot,
} from '../arms.ts';
import type { Ci } from '../packet.ts';
import { appendRun, entriesOf, isFinal, type RunRecord, readRuns, todo } from '../run.ts';
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

describe('the factory arm on the public repo, with a scripted crew', () => {
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
