import type { State } from '@agent-works/core';
import { afterEach, describe, expect, it } from 'vitest';
import { scripted } from '../agents/scripted.ts';
import { type Candidate, hostGate, hqGate, standing } from '../brief/gate.ts';
import { type Brief, type BriefAnswer, MAX_FILES, withBriefs } from '../brief/store.ts';
import { github } from '../githost/github.ts';
import type { ApiCall, ChangeSnapshot, CheckFact, GitHost, ReviewFact } from '../githost/host.ts';
import { type RunningHq, startHq } from '../hq.ts';
import { cagesMode, reviewDraft } from '../modes/cages.ts';
import { cagesFromConfig } from '../modes/cages-config.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { SCRIPTS, TICKETS } from './fixtures/factory.ts';
import { hasSqlite, tempDir } from './helpers.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const stateWith = (box: Record<string, unknown>, change: Record<string, unknown> = {}) =>
  ({
    config: { budget: 1, approvals: 1 },
    boxes: { 'alpha/t2': { id: 'alpha/t2', pr: 'acme/app#1', builders: ['nova'], ...box } },
    changes: {
      'acme/app#1': {
        repo: 'acme/app',
        number: 1,
        branch: 'aw/alpha/t2',
        head: { v: HEAD, at: 1 },
        author: { v: 'aw-nova', at: 1 },
        state: 'open',
        ...change,
      },
    },
  }) as unknown as State;

describe('HQ gate of a merge brief', () => {
  const why = (state: State, task = 'alpha/t2') => {
    const got = hqGate(state, task, 'acme/app');
    return got.ok ? `ok${got.shipped ? ' shipped' : ''}` : got.why;
  };

  it('passes only a box whose approvals and checks HQ has seen', () => {
    expect(why(stateWith({ state: 'merge' }))).toBe('ok');
    expect(why(stateWith({ state: 'shipping' }))).toBe('ok shipped');
    expect(why(stateWith({ state: 'shipped' }))).toBe('ok shipped');
    expect(why(stateWith({ state: 'belt' }))).toBe('no-pr');
    expect(why(stateWith({ state: 'building' }))).toBe('no-pr');
    expect(why(stateWith({ state: 'test' }))).toBe('test');
    expect(why(stateWith({ state: 'qc', changesRequested: false }))).toBe('review');
    expect(why(stateWith({ state: 'qc', changesRequested: true }))).toBe('changes');
    expect(why(stateWith({ state: 'cancelled' }))).toBe('closed');
    expect(why(stateWith({ state: 'merge' }), 'alpha/t1')).toBe('no-pr');
  });

  it('refuses a change that is not the task’s own branch in this repo', () => {
    expect(why(stateWith({ state: 'merge' }, { branch: 'aw/alpha/t1' }))).toBe('no-pr');
    expect(why(stateWith({ state: 'merge' }, { repo: 'acme/other' }))).toBe('no-pr');
  });
});

const review = (reviewer: string, verdict: ReviewFact['verdict'], at: number, over: Partial<ReviewFact> = {}) =>
  ({
    host: 'github',
    kind: 'review',
    repo: 'acme/app',
    number: 1,
    reviewId: String(at),
    reviewer,
    verdict,
    commitId: HEAD,
    body: '',
    at,
    ...over,
  }) satisfies ReviewFact;

const check = (name: string, state: CheckFact['state'], headSha = HEAD): CheckFact => ({
  host: 'github',
  kind: 'check',
  repo: 'acme/app',
  headSha,
  name,
  state,
  at: 1,
});

const snapshot = (over: {
  head?: string;
  state?: 'open' | 'closed' | 'merged';
  checks?: CheckFact[];
  reviews?: ReviewFact[];
}): ChangeSnapshot => ({
  change: {
    host: 'github',
    kind: 'change',
    repo: 'acme/app',
    headRepo: 'acme/app',
    number: 1,
    branch: 'aw/alpha/t2',
    author: 'aw-nova',
    state: over.state ?? 'open',
    headSha: over.head ?? HEAD,
    url: 'https://github.com/acme/app/pull/1',
    at: 1,
  },
  checks: over.checks ?? [check('ci', 'success')],
  reviews: over.reviews ?? [review('vega', 'approve', 1)],
});

const mark = (worker: string, verdict: string) => `<!-- agent-works:review worker=${worker} verdict=${verdict} -->`;

describe('host gate of a merge brief', () => {
  const candidate = hqGate(stateWith({ state: 'merge' }), 'alpha/t2', 'acme/app') as Candidate;
  const judge = (over: Parameters<typeof snapshot>[0], required = 1) => {
    const got = hostGate(candidate, snapshot(over), 'vega', required);
    return got.ok ? `${got.phase} by ${got.approvers.join()}` : `${got.why} ${got.names.join()}`.trim();
  };

  it('is ready with green checks and an approval on the head', () => {
    expect(judge({})).toBe('ready by vega');
    expect(judge({ state: 'merged' })).toBe('merged by vega');
  });

  it('refuses a moved head and a closed PR', () => {
    expect(judge({ head: OTHER, checks: [check('ci', 'success', OTHER)] })).toBe('head-moved');
    expect(judge({ state: 'closed' })).toBe('closed');
  });

  it('refuses a head with no check, and any check that is not a success', () => {
    expect(judge({ checks: [] })).toBe('no-checks');
    expect(judge({ checks: [check('ci', 'success', OTHER)] })).toBe('no-checks');
    for (const state of ['failure', 'pending', 'skipped'] as const)
      expect(judge({ checks: [check('ci', 'success'), check('late', state)] })).toBe('checks late');
    // A merged PR gets no brief either when its head is red.
    expect(judge({ state: 'merged', checks: [check('ci', 'failure')] })).toBe('checks ci');
  });

  it('refuses when the approvals on the host are not met', () => {
    expect(judge({ reviews: [] })).toBe('approvals');
    expect(judge({ reviews: [review('vega', 'approve', 1, { commitId: OTHER })] })).toBe('approvals');
    expect(judge({ reviews: [review('echo', 'approve', 1)] }, 2)).toBe('approvals echo');
    expect(judge({ reviews: [review('echo', 'approve', 1), review('echo', 'approve', 2)] }, 2)).toBe('approvals echo');
    expect(judge({ reviews: [review('echo', 'approve', 1), review('rio', 'approve', 2)] }, 2)).toBe(
      'ready by echo,rio',
    );
    expect(judge({ reviews: [review('nova', 'approve', 1)] })).toBe('approvals');
    expect(judge({ reviews: [review('aw-nova', 'approve', 1)] })).toBe('approvals');
  });

  it('refuses a standing request for changes, from anyone who did not build it', () => {
    expect(judge({ reviews: [review('echo', 'approve', 1), review('rio', 'changes', 2)] })).toBe('changes rio');
    expect(judge({ reviews: [review('rio', 'changes', 1), review('rio', 'approve', 2)] })).toBe('ready by rio');
    expect(judge({ reviews: [review('rio', 'approve', 2), review('rio', 'changes', 1)] })).toBe('ready by rio');
    // A later comment takes nothing back.
    expect(judge({ reviews: [review('rio', 'changes', 1), review('rio', 'comment', 2)] })).toBe('changes rio');
  });

  it('takes the approval away when the host dismissed the review', () => {
    expect(judge({ reviews: [review('rio', 'approve', 1), review('rio', null, 2)] })).toBe('approvals');
    expect(judge({ reviews: [review('vega', null, 1, { body: mark('vega', 'approve') })] })).toBe('approvals');
  });

  it('reads the worker from HQ’s marker only on a review its own reviewer login posted', () => {
    const own = review('shared', 'comment', 1, { body: mark('vega', 'changes') });
    expect([...standing([own], HEAD, 'shared')]).toEqual([['vega', 'changes']]);
    expect([...standing([own], HEAD, 'someone-else')]).toEqual([]);
    const forged = review('mallory', 'comment', 1, { body: mark('vega', 'changes') });
    expect([...standing([forged], HEAD, 'shared')]).toEqual([]);
  });

  it('never counts a marker as an approval, because HQ does not either', () => {
    const own = review('shared', 'comment', 1, { body: mark('vega', 'approve') });
    expect([...standing([own], HEAD, 'shared')]).toEqual([]);
  });
});

const TASK = 'alpha/t2';

const running: RunningHq[] = [];
const holds: (() => void)[] = [];
afterEach(async () => {
  for (const release of holds.splice(0)) release();
  await Promise.all(running.splice(0).map((hq) => hq.close()));
});

type Tamper = (read: ChangeSnapshot) => ChangeSnapshot;

const boot = async ({ shared = false, maxAgeMs = 0, lineCounts = true } = {}) => {
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
  // The page's reads go through their own switches, so the mode keeps seeing the host as it is.
  let tamper: Tamper = (read) => read;
  let broken: 'nothing' | 'snapshot' | 'files' = 'nothing';
  let reads = 0;
  let manyFiles = 0;
  const calls: string[] = [];
  const watched: GitHost = {
    ...host,
    snapshot: async (repo, number) => {
      reads += 1;
      calls.push('snapshot');
      if (broken === 'snapshot') throw new Error('the host is down');
      return tamper(await host.snapshot(repo, number));
    },
    comments: async (repo, number) => {
      const got = await host.comments(repo, number);
      calls.push('comments');
      return got;
    },
    fileStats: async (repo, number) => {
      if (broken === 'files') throw new Error('no file list');
      const got =
        manyFiles > 0
          ? Array.from({ length: manyFiles }, (_, i) => ({ path: `f${i}`, added: 1, deleted: i === 0 ? null : 0 }))
          : await host.fileStats?.(repo, number);
      calls.push('files');
      return got ?? [];
    },
  };
  const { fileStats, ...uncounted } = watched;
  const facts = { repo: 'acme/app', base: 'main', tickets: TICKETS };
  const hq = await startHq({
    home: tempDir('brief'),
    port: 0,
    makeDriver: async () => null,
    mode: withBriefs(
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
      { ...facts, host: lineCounts ? watched : uncounted, reviewHost, author: agent.id, maxAgeMs },
    ),
  });
  running.push(hq);
  const get = async (task = TASK) => {
    const res = await fetch(`${hq.url}/api/briefs/${encodeURIComponent(task)}`);
    return { status: res.status, body: (await res.json()) as BriefAnswer };
  };
  const answer = async (task?: string) => (await get(task)).body;
  const why = async () => {
    const got = await answer();
    return got.state === 'none' ? got.why : got.brief.phase;
  };
  const brief = async (): Promise<Brief> => {
    const got = await answer();
    if (got.state !== 'brief') throw new Error(`no brief: ${JSON.stringify(got)}`);
    return got.brief;
  };
  const order = async (task = TASK) => {
    const res = await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: task }) });
    expect(res.status).toBe(200);
  };
  const until = async (want: string) => {
    const deadline = Date.now() + 10_000;
    let got = await why();
    while (got !== want) {
      if (Date.now() > deadline) throw new Error(`waited for ${want}, got ${got}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      got = await why();
    }
  };
  return {
    fake,
    logged,
    url: hq.url,
    host,
    release: () => release(),
    get,
    answer,
    why,
    brief,
    order,
    until,
    tamper: (value: Tamper) => {
      tamper = value;
    },
    breaks: (value: typeof broken) => {
      broken = value;
    },
    reads: () => reads,
    calls,
    many: (count: number) => {
      manyFiles = count;
    },
  };
};

const merges = (calls: readonly { method: string; path: string }[]) =>
  calls.filter((c) => /\/merges?(\?|\/|$)/.test(c.path));

describe.skipIf(!hasSqlite)('GET /api/briefs/<task> on a real HQ', () => {
  it('has no brief before approvals and green checks, then one, then keeps it after a person merges', async () => {
    const hq = await boot();
    expect(await hq.answer()).toEqual({ state: 'none', task: TASK, why: 'no-pr', names: [] });
    expect(hq.reads()).toBe(0);
    await hq.order();
    await hq.until('changes');
    expect(hq.reads()).toBe(0);
    hq.release();
    await hq.until('ready');
    const brief = await hq.brief();
    expect(brief).toMatchObject({
      task: TASK,
      number: 1,
      repo: 'acme/app',
      branch: 'aw/alpha/t2',
      base: 'main',
      title: 'Add a two-file note',
      summary: 'Write docs/note.md and src/note.txt.',
      url: 'https://github.com/acme/app/pull/1',
      risk: null,
      files: { state: 'collected', count: 2, added: 8, deleted: 0 },
      checks: [{ name: 'ci' }],
      approvals: { required: 1, by: ['vega'] },
      rounds: 2,
      changesAsked: 1,
      rootCause: null,
    });
    expect(brief.head).toBe(hq.fake.refs.get('aw/alpha/t2'));
    expect(brief.timeline.map((e) => `${e.round} ${e.reviewer} ${e.verdict}`)).toEqual([
      '1 vega changes',
      '2 vega approve',
    ]);
    expect(brief.timeline[0]?.notes).toContain('docs/note.md:3 Say "second draft".');
    expect(brief.reviewGap).toContain('Codex is deferred');
    expect(brief.evidence.ci_runs.state).toBe('collected');
    for (const kind of ['screenshots', 'test_output', 'logs'] as const)
      expect(brief.evidence[kind]).toMatchObject({ state: 'not_collected', reason: expect.stringMatching(/\w/) });
    expect(brief.beforeMerge.state).toBe('not_collected');

    hq.fake.mergeByHuman(1);
    await hq.until('merged');
    expect(merges([...hq.fake.calls, ...hq.logged])).toEqual([]);
  });

  it('has no brief when author and reviewer share one login, because nobody can approve', async () => {
    const hq = await boot({ shared: true });
    await hq.order();
    await hq.until('changes');
    hq.release();
    await hq.until('review');
    expect(await hq.why()).toBe('review');
  });

  it('shows no brief when the host contradicts HQ: a moved head, a red check, a lost approval', async () => {
    const hq = await boot();
    await hq.order();
    hq.release();
    await hq.until('ready');
    // Only the page's read sees these, so HQ still says the box is ready to merge.
    hq.tamper((read) => ({ ...read, change: { ...read.change, headSha: OTHER } }));
    expect(await hq.why()).toBe('head-moved');
    hq.tamper((read) => ({ ...read, checks: read.checks.map((c) => ({ ...c, state: 'failure' })) }));
    expect(await hq.answer()).toEqual({ state: 'none', task: TASK, why: 'checks', names: ['ci'] });
    hq.tamper((read) => ({ ...read, reviews: read.reviews.filter((r) => r.verdict !== 'approve') }));
    expect(await hq.why()).toBe('approvals');
    hq.tamper((read) => ({ ...read, change: { ...read.change, state: 'closed' } }));
    expect(await hq.why()).toBe('closed');
    hq.tamper((read) => read);
    expect(await hq.why()).toBe('ready');
  });

  it('drops the brief when a late check turns red on the same head', async () => {
    const hq = await boot();
    await hq.order();
    hq.release();
    await hq.until('ready');
    hq.fake.setStatus((await hq.brief()).head, 'late', 'failure');
    expect(await hq.why()).not.toBe('ready');
  });

  it('lists the files without line counts for a host that gives none', async () => {
    const hq = await boot({ lineCounts: false });
    await hq.order();
    hq.release();
    await hq.until('ready');
    expect((await hq.brief()).files).toEqual({
      state: 'collected',
      count: 2,
      added: null,
      deleted: null,
      list: [
        { path: 'docs/note.md', added: null, deleted: null },
        { path: 'src/note.txt', added: null, deleted: null },
      ],
    });
  });

  it('reads the host again as soon as HQ learns something new, however fresh the last answer', async () => {
    const hq = await boot({ maxAgeMs: 60_000 });
    await hq.order();
    hq.release();
    await hq.until('ready');
    // A second green check keeps the box ready, so only the new read can show it.
    hq.fake.setStatus((await hq.brief()).head, 'late', 'success');
    const deadline = Date.now() + 10_000;
    while ((await hq.brief()).checks.length < 2) {
      if (Date.now() > deadline) throw new Error('the old host answer was kept');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  });

  it('drops the brief when the reviewer asks for changes on the host after approving', async () => {
    const hq = await boot();
    await hq.order();
    hq.release();
    await hq.until('ready');
    const { head } = await hq.brief();
    await hq.host.postReview('acme/app', 1, reviewDraft(head, 'vega', { verdict: 'comment', body: 'x', comments: [] }));
    await hq.until('ready');
    const asked = { verdict: 'changes', body: 'Wait.', comments: [] } as const;
    await github({ repo: 'acme/app', base: 'main', send: hq.fake.transport('rio'), log: () => {} }).postReview(
      'acme/app',
      1,
      reviewDraft(head, 'rio', asked),
    );
    expect(await hq.why()).not.toBe('ready');
  });

  it('says the host was not read, reuses a host answer, and reads again when it is old', async () => {
    const hq = await boot({ maxAgeMs: 60_000 });
    await hq.order();
    hq.release();
    const deadline = Date.now() + 10_000;
    while (!hq.fake.calls.some((c) => c.method === 'POST' && c.path.includes('/issues/1/comments'))) {
      if (Date.now() > deadline) throw new Error('HQ posted no brief');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    hq.breaks('snapshot');
    expect(await hq.answer()).toEqual({ state: 'none', task: TASK, why: 'unread', names: ['the host is down'] });
    const before = hq.reads();
    await hq.answer();
    expect(hq.reads()).toBe(before);
  });

  it('reads the snapshot after the rest, and survives a file list the host refuses', async () => {
    const hq = await boot();
    await hq.order();
    hq.release();
    await hq.until('ready');
    hq.calls.length = 0;
    await hq.brief();
    expect(hq.calls.at(-1)).toBe('snapshot');
    expect(hq.calls.slice(0, -1).sort()).toEqual(['comments', 'files']);
    hq.many(MAX_FILES + 3);
    const many = (await hq.brief()).files;
    expect(many).toMatchObject({ count: MAX_FILES + 3, added: MAX_FILES + 3, deleted: null });
    expect(many.state === 'collected' && many.list).toHaveLength(MAX_FILES);
    hq.breaks('files');
    expect((await hq.brief()).files).toEqual({
      state: 'not_collected',
      reason: 'the host did not list the files: no file list',
    });
  });

  it('answers 400 for a task with no work order and leaves every other route alone', async () => {
    const hq = await boot();
    expect((await hq.get('alpha/none')).status).toBe(400);
    expect((await hq.get('constructor')).status).toBe(400);
    expect((await fetch(`${hq.url}/api/briefs/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${hq.url}/api/briefs/alpha%2Ft2`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${hq.url}/api/snapshot`)).status).toBe(200);
  });

  it('is wired into the cages config', async () => {
    const hq = await startHq({
      home: tempDir('brief-config'),
      port: 0,
      makeDriver: async () => null,
      mode: cagesFromConfig(
        {
          host: 'github',
          repo: 'acme/app',
          base: 'main',
          author: 'a',
          reviewer: 'b',
          source: '/tmp',
          tickets: { 'alpha/t1': { kind: 'chore', title: 't', body: 'b' } },
        },
        async () => null,
        () => {},
      ),
    });
    running.push(hq);
    const res = await fetch(`${hq.url}/api/briefs/alpha%2Ft1`);
    expect(await res.json()).toMatchObject({ state: 'none', why: 'no-pr' });
  });
});
