import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, reduce } from '@agent-works/core';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../events.ts';
import { GITHUB_EVENTS, github, parseGithub } from '../githost/github.ts';
import { GITLAB_EVENTS, gitlab, parseGitlab } from '../githost/gitlab.ts';
import {
  type ApiCall,
  type GitHost,
  type HostEvent,
  PayloadError,
  signatureValid,
  toFact,
  toPoll,
  WriteRefused,
} from '../githost/host.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { FakeGitlab } from './fakes/gitlab-api.ts';

type Fixture = { host: 'github' | 'gitlab'; event: string; body: Record<string, unknown> };
const root = join(import.meta.dirname, '../../spikes/P0-4/fixtures');
const fixtures = (['github', 'gitlab'] as const).flatMap((host) =>
  readdirSync(join(root, host)).map((file) => ({
    name: `${host}/${file}`,
    fixture: JSON.parse(readFileSync(join(root, host, file), 'utf8')) as Fixture,
  })),
);
const load = (name: string): Fixture => structuredClone(fixtures.find((f) => f.name === name)?.fixture as Fixture);
const parse = (f: Fixture): HostEvent | null =>
  f.host === 'github' ? parseGithub(f.event, f.body) : parseGitlab(f.event, f.body);
const set = (body: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split('.');
  const last = keys.pop() as string;
  (keys.reduce((node, key) => node[key] as Record<string, unknown>, body) as Record<string, unknown>)[last] = value;
};

const expected: Record<string, Partial<Record<string, unknown>>> = {
  'github/push.json': { kind: 'push', ref: 'refs/heads/aw/alpha/t1', deleted: false, at: 1794770055000 },
  'github/status.json': {
    kind: 'check',
    name: 'agent-works/spike',
    state: 'success',
    at: Date.parse('2026-11-15T19:14:17Z'),
  },
  'github/check_run-completed.json': {
    kind: 'check',
    repo: 'FiatFour/ai-office',
    state: 'success',
    at: Date.parse('2026-11-15T19:17:53Z'),
  },
  'github/pull_request-opened.json': {
    kind: 'change',
    state: 'open',
    branch: 'aw/alpha/t1',
    author: 'FiatFour',
    headRepo: 'FiatFour/agent-works-scratch',
    at: Date.parse('2026-11-15T19:14:16Z'),
  },
  'github/pull_request-closed.json': { kind: 'change', state: 'closed', branch: 'aw/beta/t2', author: 'FiatFour' },
  'github/pull_request_review.json': {
    kind: 'review',
    number: 1,
    verdict: 'comment',
    reviewer: 'FiatFour',
    reviewId: '5912374539',
    commitId: 'bcd3c9d62fcf1e658502495dccac564b3c393158',
    at: Date.parse('2026-11-15T19:14:18Z'),
  },
  'github/pull_request_review_comment.json': {
    kind: 'review_comment',
    line: 2,
    path: 'spike/alpha-t1.md',
    author: 'FiatFour',
    reviewId: '5912374539',
    commitId: 'bcd3c9d62fcf1e658502495dccac564b3c393158',
  },
  'gitlab/push.json': { kind: 'push', repo: 'mike/diaspora', deleted: false },
  'gitlab/merge_request-open.json': {
    kind: 'change',
    state: 'open',
    number: 16,
    author: 'agarcia',
    headRepo: 'flightjs/flight-management',
    at: Date.parse('2026-01-16T05:56:25Z'),
  },
  'gitlab/note-merge-request.json': {
    kind: 'review_comment',
    line: null,
    path: null,
    author: 'root',
    body: 'This MR needs work.',
  },
  'gitlab/pipeline.json': {
    kind: 'check',
    state: 'success',
    name: 'pipeline 31',
    at: Date.parse('2016-08-12T15:26:29Z'),
  },
};

describe('GitHost parsers on the P0-4 fixtures', () => {
  it.each(Object.keys(expected))('%s keeps the identity fields and the host time', (name) => {
    const event = parse(load(name));
    expect(event).toMatchObject(expected[name] as object);
    expect(event?.at === null || (event?.at ?? 0) > 0).toBe(true);
  });

  it('turns every fact into an event the HQ boundary and the reducer accept', () => {
    let state = initialState({ budget: 1, approvals: 1 });
    const facts = fixtures.map((f) => parse(f.fixture)).flatMap((e) => (e === null ? [] : [toFact(e)]));
    const kinds = new Set(facts.flatMap((f) => (f === null ? [] : [f.kind])));
    expect([...kinds].sort()).toEqual(['change', 'check', 'review']);
    for (const fact of facts)
      if (fact !== null) state = reduce(state, parseEvent(JSON.parse(JSON.stringify(fact)))).state;
    expect(Object.keys(state.changes).length).toBeGreaterThan(0);
  });

  it('reads a merged GitHub PR as merged', () => {
    const f = load('github/pull_request-closed.json');
    set(f.body, 'pull_request.merged', true);
    expect(parse(f)).toMatchObject({ kind: 'change', state: 'merged' });
  });

  it('never reads a skipped pipeline or check run as passing', () => {
    const pipeline = load('gitlab/pipeline.json');
    set(pipeline.body, 'object_attributes.status', 'skipped');
    const run = load('github/check_run-completed.json');
    set(run.body, 'check_run.conclusion', 'skipped');
    for (const f of [pipeline, run]) {
      const event = parse(f);
      expect(event).toMatchObject({ kind: 'check', state: 'skipped' });
      expect(toFact(event as HostEvent)).toMatchObject({ state: 'pending' });
    }
  });

  it('refuses a PR number that is not a positive safe integer', () => {
    for (const bad of [0, -1, 2 ** 53, 1.5]) {
      const f = load('github/pull_request-opened.json');
      set(f.body, 'pull_request.number', bad);
      expect(() => parse(f)).toThrow(PayloadError);
    }
  });

  it('refuses a fact without a host time', () => {
    const f = load('github/pull_request_review.json');
    set(f.body, 'review.submitted_at', 'yesterday');
    expect(() => parse(f)).toThrow(/host timestamp/);
  });

  it('parses only the event names it knows, so an unsigned header cannot name a parser', () => {
    expect(parseGithub('../../etc/passwd', {})).toBeNull();
    expect(parseGithub('__proto__', {})).toBeNull();
    expect(parseGitlab('constructor', {})).toBeNull();
    expect(GITHUB_EVENTS).toContain('pull_request');
    expect(GITLAB_EVENTS).toContain('Merge Request Hook');
  });

  it('reads a deleted branch as a deletion', () => {
    const f = load('github/push.json');
    set(f.body, 'after', '0'.repeat(40));
    set(f.body, 'deleted', true);
    expect(parse(f)).toMatchObject({ kind: 'push', deleted: true });
  });

  it('checks the webhook signature', () => {
    const raw = Buffer.from('{"a":1}');
    expect(signatureValid('s', raw, 'sha256=00')).toBe(false);
    expect(signatureValid('s', raw, undefined)).toBe(false);
  });
});

interface Harness {
  readonly name: 'github' | 'gitlab';
  readonly author: GitHost;
  readonly reviewer: GitHost;
  readonly calls: ApiCall[];
  readonly merges: () => number;
}

const harnesses = (): Harness[] => {
  const gh = new FakeGithub();
  const gl = new FakeGitlab();
  const ghCalls: ApiCall[] = [];
  const glCalls: ApiCall[] = [];
  return [
    {
      name: 'github',
      author: github({ send: gh.transport('aw-bot'), log: (c) => ghCalls.push(c) }),
      reviewer: github({ send: gh.transport('aw-reviewer'), log: (c) => ghCalls.push(c) }),
      calls: ghCalls,
      merges: () => gh.calls.filter((c) => /\/merge$/.test(c.path)).length,
    },
    {
      name: 'gitlab',
      author: gitlab({ send: gl.transport('aw-bot'), log: (c) => glCalls.push(c) }),
      reviewer: gitlab({ send: gl.transport('aw-reviewer'), log: (c) => glCalls.push(c) }),
      calls: glCalls,
      merges: () => gl.calls.filter((c) => /\/merge$/.test(c.path)).length,
    },
  ];
};

describe.each(['github', 'gitlab'] as const)('GitHost contract on %s', (name) => {
  const setup = () => harnesses().find((h) => h.name === name) as Harness;
  const repo = 'acme/app';
  const branch = 'aw/alpha/t1';

  it('pushes files, opens one change and finds it again instead of opening a second', async () => {
    const { author, calls } = setup();
    expect(await author.findChange(repo, branch)).toBeNull();
    const head = await author.pushFiles(repo, {
      branch,
      base: 'main',
      files: [{ path: 'src/a.txt', content: 'one\n' }],
      message: 'm',
    });
    const opened = await author.openChange(repo, { branch, base: 'main', title: 't', body: 'b' });
    expect(opened).toMatchObject({ kind: 'change', branch, number: 1, state: 'open', author: 'aw-bot', headSha: head });
    expect(opened.at).toBeGreaterThan(0);
    expect(await author.findChange(repo, branch)).toMatchObject({ number: 1 });
    const writes = calls.filter((c) => c.method !== 'GET').length;
    expect(
      await author.pushFiles(repo, {
        branch,
        base: 'main',
        files: [{ path: 'src/a.txt', content: 'one\n' }],
        message: 'm',
      }),
    ).toBe(head);
    expect(calls.filter((c) => c.method !== 'GET').length).toBe(writes);
  });

  it('posts a review with line comments that carries the reviewer, the commit and the host time', async () => {
    const { author, reviewer } = setup();
    const head = await author.pushFiles(repo, {
      branch,
      base: 'main',
      files: [{ path: 'src/a.txt', content: 'a\nb\nc\n' }],
      message: 'm',
    });
    const pr = await author.openChange(repo, { branch, base: 'main', title: 't', body: 'b' });
    const review = await reviewer.postReview(repo, pr.number, {
      commitId: head,
      verdict: 'approve',
      body: 'looks fine',
      comments: [{ path: 'src/a.txt', line: 2, body: 'rename b' }],
    });
    expect(review).toMatchObject({ kind: 'review', reviewer: 'aw-reviewer', verdict: 'approve', commitId: head });
    expect(review.at).toBeGreaterThan(0);
    const comments = await author.comments(repo, pr.number);
    expect(comments.find((c) => c.line === 2)).toMatchObject({
      path: 'src/a.txt',
      author: 'aw-reviewer',
      body: 'rename b',
    });
    expect(await reviewer.files(repo, pr.number, head)).toEqual([{ path: 'src/a.txt', content: 'a\nb\nc\n' }]);
    const poll = toPoll(await author.snapshot(repo, pr.number));
    expect(poll).toMatchObject({ source: 'poll', number: pr.number, headSha: head, branch });
    expect(poll.reviews).toEqual([{ reviewer: 'aw-reviewer', verdict: 'approve' }]);
  });

  it('finds a posted comment by its marker', async () => {
    const { author } = setup();
    await author.pushFiles(repo, { branch, base: 'main', files: [{ path: 'x.md', content: 'x\n' }], message: 'm' });
    const pr = await author.openChange(repo, { branch, base: 'main', title: 't', body: 'b' });
    expect(await author.findComment(repo, pr.number, '<!-- m1 -->')).toBeNull();
    const posted = await author.postComment(repo, pr.number, 'brief <!-- m1 -->');
    expect(await author.findComment(repo, pr.number, '<!-- m1 -->')).toEqual(posted);
  });

  it('never reaches a merge endpoint, however the path is spelled', async () => {
    const h = setup();
    const raw = (h.author as unknown as Record<string, unknown>).id;
    expect(raw).toBe(name);
    const { guard } = await import('../githost/host.ts');
    const { GITHUB_WRITES } = await import('../githost/github.ts');
    const { GITLAB_WRITES } = await import('../githost/gitlab.ts');
    const send = async () => ({ status: 200, body: {} });
    const gh = guard('github', GITHUB_WRITES, send, () => {});
    const gl = guard('gitlab', GITLAB_WRITES, send, () => {}, /^\/projects\/[\w.-]+(?:%2F[\w.-]+)+/i);
    const ghPaths = [
      ['PUT', '/repos/a/b/pulls/1/merge'],
      ['POST', '/repos/a/b/pulls/1/merge'],
      ['PUT', '/repos/a/b/contents/../pulls/1/merge'],
      ['PUT', '/repos/a/b/contents/%2e%2e/pulls/1/merge'],
      ['PUT', '/repos/a/b/contents/x%2f..%2fpulls/1/merge'],
      ['POST', '/repos/a/b/merges'],
      ['PUT', '/repos/a/b/pulls/1/merge?x=1'],
      ['PATCH', '/repos/a/b/git/refs/heads/main'],
    ] as const;
    for (const [method, path] of ghPaths) await expect(gh({ method, path })).rejects.toThrow(WriteRefused);
    const glPaths = [
      ['PUT', '/projects/a%2Fb/merge_requests/1/merge'],
      ['POST', '/projects/a%2Fb/merge_requests/1/merge'],
      ['POST', '/projects/a%2Fb/merge_requests/1/approve/../merge'],
      ['POST', '/projects/a%2Fb/merge_requests/1%2Fmerge/notes'],
      ['POST', '/projects/a%2Fb/merge_requests/1/merge_when_pipeline_succeeds'],
    ] as const;
    for (const [method, path] of glPaths) await expect(gl({ method, path })).rejects.toThrow(WriteRefused);
    await expect(gh({ method: 'POST', path: '/repos/a/b/pulls' })).resolves.toEqual({});
    await expect(gl({ method: 'POST', path: '/projects/a%2Fb/merge_requests' })).resolves.toEqual({});
    expect(h.merges()).toBe(0);
  });
});

describe('a review the host refuses on a PR the same account opened', () => {
  it('posts it as a comment that names the verdict, and reports the comment verdict the host holds', async () => {
    const fake = new FakeGithub();
    const host = github({ send: fake.transport('fiatfour'), log: () => {} });
    const head = await host.pushFiles('acme/app', {
      branch: 'aw/alpha/t1',
      base: 'main',
      files: [{ path: 'a', content: 'a\n' }],
      message: 'm',
    });
    const pr = await host.openChange('acme/app', { branch: 'aw/alpha/t1', base: 'main', title: 't', body: 'b' });
    const review = await host.postReview('acme/app', pr.number, {
      commitId: head,
      verdict: 'changes',
      body: 'fix it',
      comments: [],
    });
    expect(review).toMatchObject({ verdict: 'comment', reviewer: 'fiatfour', commitId: head });
    expect(fake.reviews.at(-1)?.body).toContain('"changes"');
  });
});

describe('a poll', () => {
  it('drops reviews given on an older commit, so a fixed head does not inherit old changes', () => {
    const at = 1000;
    const change = {
      host: 'github',
      kind: 'change',
      repo: 'acme/app',
      headRepo: 'acme/app',
      number: 1,
      branch: 'aw/alpha/t1',
      author: 'aw-bot',
      state: 'open',
      headSha: 'new',
      url: 'u',
      at,
    } as const;
    const review = (reviewer: string, commitId: string, verdict: 'changes' | 'approve', t: number) =>
      ({
        host: 'github',
        kind: 'review',
        repo: 'acme/app',
        number: 1,
        reviewId: t.toString(),
        body: '',
        reviewer,
        verdict,
        commitId,
        at: t,
      }) as const;
    const poll = toPoll({
      change,
      reviews: [
        review('r1', 'old', 'changes', 1),
        review('r2', 'new', 'approve', 2),
        review('r2', 'new', 'changes', 3),
      ],
      checks: [],
    });
    expect(poll.reviews).toEqual([{ reviewer: 'r2', verdict: 'changes' }]);
  });
});
