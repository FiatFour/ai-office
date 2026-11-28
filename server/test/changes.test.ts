import type { Box, Change, PrKey, State } from '@agent-works/core';
import { afterEach, describe, expect, it } from 'vitest';
import { scripted } from '../agents/scripted.ts';
import { github } from '../githost/github.ts';
import type { ApiCall, CommentFact, GitHost, ReviewFact } from '../githost/host.ts';
import { type RunningHq, startHq } from '../hq.ts';
import { cagesMode, type HqPort, reviewDraft } from '../modes/cages.ts';
import { cagesFromConfig } from '../modes/cages-config.ts';
import {
  type ChangeDetail,
  type ChangeSources,
  type ChangeStamp,
  type ChangesView,
  changesView,
  readable,
  roundsFrom,
  withChanges,
} from '../snapshot/changes.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { SCRIPTS, TICKETS } from './fixtures/factory.ts';
import { hasSqlite, tempDir } from './helpers.ts';

const TASK = 'alpha/t2';

const running: RunningHq[] = [];
const holds: (() => void)[] = [];
afterEach(async () => {
  // HQ waits for its jobs before it closes, so a job that is still held would hang the close.
  for (const release of holds.splice(0)) release();
  await Promise.all(running.splice(0).map((hq) => hq.close()));
});

const boot = async ({ shared = false, maxAgeMs = 60_000 } = {}) => {
  const fake = new FakeGithub();
  const logged: ApiCall[] = [];
  const account = (login: string) =>
    github({ repo: 'acme/app', base: 'main', send: fake.transport(login), log: (c) => logged.push(c) });
  const host = account('aw-nova');
  const reviewHost = shared ? host : account('vega');
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  holds.push(release);
  const agent = scripted({ scripts: SCRIPTS });
  const held: typeof agent = {
    id: agent.id,
    run: async (job) => {
      if (job.role === 'author' && job.round > 0) await released;
      return agent.run(job);
    },
  };
  // The reads of the screen go through their own failure switch, so the mode keeps working while they fail.
  let broken = false;
  let reads = 0;
  const watched: GitHost = {
    ...host,
    snapshot: async (repo, number) => {
      reads += 1;
      if (broken) throw new Error('the host is down');
      return host.snapshot(repo, number);
    },
  };
  const facts = { repo: 'acme/app', base: 'main', tickets: TICKETS };
  const hq = await startHq({
    home: tempDir('changes'),
    port: 0,
    makeDriver: async () => null,
    mode: withChanges(
      cagesMode({
        ...facts,
        host,
        reviewHost,
        author: 'nova',
        reviewer: 'vega',
        workers: { nova: held, vega: held },
        pollMs: 30,
        settleMs: 5,
      }),
      { ...facts, host: watched, reviewHost, maxAgeMs },
    ),
  });
  running.push(hq);
  const get = async <T>(path: string) => {
    const res = await fetch(`${hq.url}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };
  const list = async () => (await get<ChangesView>('/api/changes')).body.rows;
  const detail = async (number = 1) => (await get<ChangeDetail>(`/api/changes/${number}`)).body;
  const order = async () => {
    const res = await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: TASK }) });
    expect(res.status).toBe(200);
  };
  const until = async (done: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(await list())}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  return {
    fake,
    logged,
    release: () => release(),
    get,
    list,
    detail,
    order,
    until,
    stamped: (stamp: ChangeStamp) => until(async () => (await list())[0]?.stamp === stamp),
    breakHost: (value: boolean) => {
      broken = value;
    },
    snapshots: () => reads,
  };
};

const writes = (fake: FakeGithub) => fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

describe.skipIf(!hasSqlite)('the PRs of a factory at /api/changes', () => {
  it('shows a scripted review round as CHANGES, then READY, then SHIPPED after a person merges', async () => {
    const hq = await boot();
    expect(await hq.list()).toEqual([]);
    await hq.order();
    await hq.stamped('CHANGES');
    expect((await hq.list())[0]).toMatchObject({
      number: 1,
      repo: 'acme/app',
      host: 'github',
      branch: 'aw/alpha/t2',
      base: 'main',
      task: TASK,
      title: 'Add a two-file note',
      worker: 'nova',
    });
    const asked = await hq.detail();
    expect(asked.approvals).toEqual([
      { by: 'peer', who: 'vega', state: 'changes' },
      { by: 'you', state: 'wait' },
    ]);
    expect(asked.briefUrl).toBeNull();
    expect(asked.fromHost).toMatchObject({
      state: 'read',
      url: 'https://github.com/acme/app/pull/1',
      checks: [{ name: 'ci', state: 'success' }],
      rounds: [
        {
          round: 1,
          head: asked.row.head,
          reviews: [
            {
              reviewer: 'vega',
              verdict: 'changes',
              body: 'Please fix the comments.',
              comments: [{ path: 'docs/note.md', line: 3, body: 'Say "second draft".' }],
            },
          ],
        },
      ],
    });

    hq.release();
    await hq.stamped('READY');
    await hq.until(async () => (await hq.detail()).briefUrl !== null);
    const ready = await hq.detail();
    expect(ready.row.head).not.toBe(asked.row.head);
    expect(ready.approvals).toEqual([
      { by: 'peer', who: 'vega', state: 'approve' },
      { by: 'you', state: 'wait' },
    ]);
    expect(ready.briefUrl).toMatch(/^https:\/\/github\.com\/acme\/app\/pull\/1#issuecomment-\d+$/);
    expect(
      ready.fromHost.state === 'read' && ready.fromHost.rounds.map((r) => [r.round, r.reviews[0]?.verdict]),
    ).toEqual([
      [1, 'changes'],
      [2, 'approve'],
    ]);

    hq.fake.mergeByHuman(1);
    await hq.stamped('SHIPPED');
    const shipped = await hq.detail();
    expect(shipped.approvals.at(-1)).toEqual({ by: 'you', state: 'approve' });
    expect(shipped.briefUrl).toBeNull();
  });

  it('only reads: asking for the list and the details writes nothing to the host and never calls a merge endpoint', async () => {
    const hq = await boot({ maxAgeMs: 0 });
    await hq.order();
    hq.release();
    await hq.stamped('READY');
    await hq.until(async () => (await hq.detail()).briefUrl !== null);
    const before = writes(hq.fake);
    expect(before.some((call) => call.includes('/reviews'))).toBe(true);
    const asked = hq.fake.calls.length;
    for (let i = 0; i < 3; i += 1) {
      await hq.list();
      await hq.detail();
    }
    expect(hq.fake.calls.length).toBeGreaterThan(asked);
    expect(writes(hq.fake)).toEqual(before);
    expect(hq.logged.filter((call) => /\/merges?(\?|\/|$)/.test(call.path))).toEqual([]);
    for (const method of ['POST', 'PUT', 'DELETE'])
      expect((await fetch(`${running[0]?.url}/api/changes/1`, { method })).status).toBe(404);
  });

  it('names the worker that reviewed when one account both opens and reviews the PR', async () => {
    const hq = await boot({ shared: true });
    await hq.order();
    await hq.stamped('CHANGES');
    const { fromHost } = await hq.detail();
    expect(fromHost.state === 'read' && fromHost.rounds[0]?.reviews[0]).toMatchObject({
      reviewer: 'vega',
      verdict: 'changes',
      body: expect.stringContaining('Please fix the comments.'),
    });
    expect(JSON.stringify(fromHost)).not.toContain('agent-works:');
  });

  it('refuses a PR it does not list', async () => {
    const hq = await boot();
    expect(await hq.get('/api/changes/7')).toEqual({
      status: 400,
      body: { error: 'no PR 7 belongs to a task of this factory' },
    });
  });

  it('reuses a host answer while nothing changed, and keeps no failed one', async () => {
    const hq = await boot();
    await hq.order();
    await hq.stamped('CHANGES');
    hq.breakHost(true);
    const down = await hq.detail();
    expect(down.fromHost).toEqual({ state: 'unread', reason: 'the host is down' });
    expect(down.row.stamp).toBe('CHANGES');
    expect(down.approvals).toHaveLength(2);
    hq.breakHost(false);
    expect((await hq.detail()).fromHost.state).toBe('read');
    const after = hq.snapshots();
    await Promise.all([hq.detail(), hq.detail(), hq.detail()]);
    expect(hq.snapshots()).toBe(after);
    hq.release();
    await hq.stamped('READY');
    await hq.detail();
    expect(hq.snapshots()).toBe(after + 1);
  });

  it('asks the host again once an answer is older than its limit', async () => {
    const hq = await boot({ maxAgeMs: 0 });
    await hq.order();
    await hq.stamped('CHANGES');
    await hq.detail();
    const after = hq.snapshots();
    await hq.detail();
    expect(hq.snapshots()).toBe(after + 1);
  });
});

const box = (over: object): Box =>
  ({
    id: TASK,
    shipment: 's',
    seq: 1,
    worker: 'nova',
    builders: ['nova'],
    cancelled: false,
    state: 'test',
    ...over,
  }) as unknown as Box;
const KEY = 'acme/app#1@aw/alpha/t2' as PrKey;
const pr = (over: object = {}): Change =>
  ({
    repo: 'acme/app',
    number: 1,
    branch: 'aw/alpha/t2',
    author: { v: 'nova', at: 1 },
    head: { v: 'a1', at: 1 },
    first: 1,
    at: 1,
    state: 'open',
    ...over,
  }) as Change;
const stateOf = (boxes: Box[], changes: Record<string, Change>): State =>
  ({ boxes: Object.fromEntries(boxes.map((b) => [b.id, b])), changes, reviews: {} }) as unknown as State;
const SOURCES = {
  host: { id: 'github' },
  repo: 'Acme/App',
  base: 'main',
  tickets: TICKETS,
} as unknown as ChangeSources;
const stampFor = (b: Box, change = pr(), red: Record<string, string[]> = {}) =>
  changesView(stateOf([b], { [KEY]: change }), SOURCES, red).rows[0]?.stamp;

describe('the stamp of a PR', () => {
  it.each<[ChangeStamp, Box, Change?]>([
    ['DRAFT', box({ state: 'test', pr: KEY })],
    ['DRAFT', box({ state: 'building' })],
    ['AT QC', box({ state: 'qc', pr: KEY, changesRequested: false })],
    ['CHANGES', box({ state: 'qc', pr: KEY, changesRequested: true })],
    ['READY', box({ state: 'merge', pr: KEY })],
    ['DRAFT', box({ state: 'merge', pr: 'acme/app#2@aw/alpha/t2' })],
    ['DRAFT', box({ state: 'qc', pr: 'acme/app#2@aw/alpha/t2', changesRequested: true })],
    ['SHIPPED', box({ state: 'shipping', pr: KEY })],
    ['SHIPPED', box({ state: 'shipped', pr: KEY }), pr({ state: 'merged' })],
    ['SCRAPPED', box({ state: 'cancelled', reason: 'closed' }), pr({ state: 'closed' })],
    ['SCRAPPED', box({ state: 'cancelled', reason: 'human' })],
    ['SCRAPPED', box({ state: 'test', pr: KEY }), pr({ state: 'closed' })],
    ['SHIPPED', box({ state: 'test', pr: KEY }), pr({ state: 'merged' })],
  ])('is %s', (stamp, b, change) => {
    expect(stampFor(b, change)).toBe(stamp);
  });

  it('is never READY while a check of the head is red', () => {
    expect(stampFor(box({ state: 'merge', pr: KEY }), pr(), { [TASK]: ['ci'] })).toBe('DRAFT');
  });

  it('lists only the PRs of its repo that a task owns, the ones that wait for a person first', () => {
    const other = box({ id: 'alpha/t1', state: 'test', pr: 'acme/app#3@aw/alpha/t1' });
    const state = stateOf([box({ state: 'merge', pr: KEY }), other], {
      [KEY]: pr(),
      'acme/app#3@aw/alpha/t1': pr({ number: 3, branch: 'aw/alpha/t1' }),
      'acme/app#4@feature': pr({ number: 4, branch: 'feature' }),
      'acme/else#5@aw/alpha/t2': pr({ number: 5, repo: 'acme/else' }),
    });
    expect(changesView(state, SOURCES, {}).rows.map((row) => [row.number, row.stamp])).toEqual([
      [1, 'READY'],
      [3, 'DRAFT'],
    ]);
  });
});

const fact = (over: Partial<ReviewFact>): ReviewFact => ({
  host: 'github',
  kind: 'review',
  repo: 'acme/app',
  number: 1,
  reviewId: '1',
  reviewer: 'someone',
  verdict: 'comment',
  commitId: 'a1',
  body: '',
  at: 1,
  ...over,
});

describe('review rounds', () => {
  const marked = reviewDraft('a1', 'vega', { verdict: 'approve', body: 'fine', comments: [] }).body;

  it('trusts a marker only on a review of the reviewer account', () => {
    const [round] = roundsFrom(
      [fact({ reviewer: 'stranger', body: marked }), fact({ reviewId: '2', reviewer: 'Bot', body: marked, at: 2 })],
      [],
      'bot',
    );
    expect(round?.reviews.map((r) => [r.reviewer, r.verdict])).toEqual([
      ['stranger', 'comment'],
      ['vega', 'approve'],
    ]);
  });

  it('numbers one round per reviewed head, oldest first, and skips a review with no verdict', () => {
    const rounds = roundsFrom(
      [
        fact({ reviewId: '3', commitId: 'b2', at: 5 }),
        fact({ reviewId: '1', commitId: 'a1', at: 1 }),
        fact({ reviewId: '4', commitId: 'c3', at: 7, verdict: null }),
      ],
      [{ reviewId: '3', path: 'x.ts', line: 2, body: 'why' } as CommentFact],
      'bot',
    );
    expect(rounds.map((r) => [r.round, r.head, r.reviews[0]?.comments.length])).toEqual([
      [1, 'a1', 0],
      [2, 'b2', 1],
    ]);
  });

  it('takes HQ quoting and markers off a body, also with a note after the quote', () => {
    expect(readable(`${marked}\n\n(The verdict was "approve".)`)).toBe('fine\n\n\n\n(The verdict was "approve".)');
    expect(readable('plain │ text')).toBe('plain │ text');
  });
});

const idle: HqPort = {
  state: () => stateOf([], {}),
  ingest: () => {},
  outbox: () => [],
  events: () => [],
  changed: () => {},
  paused: () => false,
};

describe('what the host says', () => {
  it('shows only checks of the head and no link that is not http', async () => {
    const host = {
      id: 'github',
      login: async () => 'bot',
      comments: async () => [],
      snapshot: async () => ({
        change: { headSha: 'a1', url: 'javascript:alert(1)' },
        reviews: [],
        checks: [
          { headSha: 'a1', name: 'unit', state: 'skipped' },
          { headSha: 'a0', name: 'old', state: 'failure' },
        ],
      }),
    } as unknown as GitHost;
    const mode = withChanges(
      () => ({ view: () => ({ red: {} }), actions: () => [], route: () => undefined }) as never,
      { ...SOURCES, host },
    )({ ...idle, state: () => stateOf([box({ state: 'test', pr: KEY })], { [KEY]: pr() }) });
    const detail = (await mode.route('GET', '/api/changes/1', async () => ({}))) as ChangeDetail;
    expect(detail.fromHost).toEqual({
      state: 'read',
      url: null,
      checks: [{ name: 'unit', state: 'skipped' }],
      rounds: [],
    });
    expect(detail.approvals).toEqual([
      { by: 'peer', who: null, state: 'wait' },
      { by: 'you', state: 'wait' },
    ]);
  });

  it('is wired into the cages mode that the CLI builds from a config file', async () => {
    const mode = cagesFromConfig(
      { host: 'github', repo: 'acme/app', base: 'main', author: 'nova', reviewer: 'vega', source: '.', tickets: {} },
      async () => null,
      () => {},
    )(idle);
    await expect(mode.route('GET', '/api/changes', async () => ({}))).resolves.toEqual({ rows: [] });
    await mode.close();
  });
});
