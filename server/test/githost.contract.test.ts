import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, reduce } from '@agent-works/core';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../events.ts';
import { GITHUB_EVENTS, GITHUB_WRITES, github, githubScope, parseGithub } from '../githost/github.ts';
import { GITLAB_EVENTS, GITLAB_WRITES, gitlab, gitlabScope, parseGitlab } from '../githost/gitlab.ts';
import {
  type ApiCall,
  allPages,
  DROPPED_MARK,
  type GitHost,
  guard,
  type HostEvent,
  type HttpRequest,
  type HttpResponse,
  PayloadError,
  signatureValid,
  toFact,
  toPoll,
  WriteRefused,
} from '../githost/host.ts';
import { FakeGithub, UNRESOLVED_LINE } from './fakes/github-api.ts';
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
  readonly as: (account: string) => GitHost;
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
      author: github({ repo: 'acme/app', base: 'main', send: gh.transport('aw-bot'), log: (c) => ghCalls.push(c) }),
      reviewer: github({
        repo: 'acme/app',
        base: 'main',
        send: gh.transport('aw-reviewer'),
        log: (c) => ghCalls.push(c),
      }),
      as: (account) => github({ repo: 'acme/app', base: 'main', send: gh.transport(account), log: () => {} }),
      calls: ghCalls,
      merges: () => gh.calls.filter((c) => /\/merge$/.test(c.path)).length,
    },
    {
      name: 'gitlab',
      author: gitlab({ repo: 'acme/app', base: 'main', send: gl.transport('aw-bot'), log: (c) => glCalls.push(c) }),
      reviewer: gitlab({
        repo: 'acme/app',
        base: 'main',
        send: gl.transport('aw-reviewer'),
        log: (c) => glCalls.push(c),
      }),
      as: (account) => gitlab({ repo: 'acme/app', base: 'main', send: gl.transport(account), log: () => {} }),
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
    const binary = await author.pushFiles(repo, {
      branch,
      base: 'main',
      files: [{ path: 'logo.png', content: '\u0089PNG\r\n\u001a\n\u0000\u0000' }],
      message: 'm',
    });
    const both = await reviewer.files(repo, pr.number, binary);
    expect(both.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'logo.png', content: null },
      { path: 'src/a.txt', content: 'a\nb\nc\n' },
    ]);
  });

  it('finds a comment by its marker only when the HQ account wrote it, on any page', async () => {
    const { author, reviewer, as } = setup();
    await author.pushFiles(repo, { branch, base: 'main', files: [{ path: 'x.md', content: 'x\n' }], message: 'm' });
    const pr = await author.openChange(repo, { branch, base: 'main', title: 't', body: 'b' });
    const marker = '<!-- agent-works:merge-brief task=alpha/t1 head=abc -->';
    expect(await author.findComment(repo, pr.number, marker)).toBeNull();
    await reviewer.postComment(repo, pr.number, `fake brief\n${marker}`);
    await as('x-aw-bot-2').postComment(repo, pr.number, `fake brief\n${marker}`);
    for (let i = 0; i < 120; i += 1) await reviewer.postComment(repo, pr.number, `noise ${i}`);
    expect(await author.findComment(repo, pr.number, marker)).toBeNull();
    const posted = await author.postComment(repo, pr.number, `brief\n${marker}`);
    expect(await author.findComment(repo, pr.number, marker)).toEqual(posted);
    expect(
      await author.findComment(repo, pr.number, '<!-- agent-works:merge-brief task=alpha/t1 head=ab -->'),
    ).toBeNull();
    const other = '<!-- agent-works:merge-brief task=alpha/t1 head=def -->';
    const same = await as('AW-Bot').postComment(repo, pr.number, `brief by the same login\n${other}`);
    expect(await author.findComment(repo, pr.number, other)).toEqual(same);
  });

  it('reads every page of review comments', async () => {
    const { author, reviewer } = setup();
    const head = await author.pushFiles(repo, {
      branch,
      base: 'main',
      files: [{ path: 'src/a.txt', content: 'a\n' }],
      message: 'm',
    });
    const pr = await author.openChange(repo, { branch, base: 'main', title: 't', body: 'b' });
    const comments = Array.from({ length: 130 }, (_, i) => ({ path: 'src/a.txt', line: 1, body: `c${i}` }));
    await reviewer.postReview(repo, pr.number, { commitId: head, verdict: 'comment', body: 'many', comments });
    const read = await author.comments(repo, pr.number);
    expect(read.filter((c) => c.path === 'src/a.txt').map((c) => c.body)).toContain('c129');
  });

  it('lists every changed path across pages', async () => {
    const { author } = setup();
    const files = Array.from({ length: 230 }, (_, i) => ({ path: `src/f${i}.txt`, content: `${i}\n` }));
    await author.pushFiles(repo, { branch, base: 'main', files, message: 'm' });
    const pr = await author.openChange(repo, { branch, base: 'main', title: 't', body: 'b' });
    const paths = await author.paths(repo, pr.number);
    expect(paths).toHaveLength(230);
    expect(paths).toContain('src/f229.txt');
  });

  it('pushes all files of a round as one commit on the task branch', async () => {
    const { author, calls } = setup();
    const files = [
      { path: 'a.txt', content: 'a\n' },
      { path: 'b/c.txt', content: 'c\n' },
    ];
    const first = await author.pushFiles(repo, { branch, base: 'main', files, message: 'm' });
    const writes = () => calls.filter((c) => c.method !== 'GET');
    const before = writes().length;
    const second = await author.pushFiles(repo, {
      branch,
      base: 'main',
      files: [
        { path: 'a.txt', content: 'a2\n' },
        { path: 'b/c.txt', content: 'c2\n' },
      ],
      message: 'm2',
    });
    expect(second).not.toBe(first);
    const moved = writes()
      .slice(before)
      .filter((c) => /git\/refs|repository\/commits/.test(c.path));
    expect(moved).toHaveLength(1);
  });
});

describe('the write guard', () => {
  const sent: unknown[] = [];
  const send = async (request: unknown) => {
    sent.push(request);
    return { status: 200, body: {} };
  };
  const gh = guard('github', GITHUB_WRITES, githubScope('a/b', 'main'), send, () => {});
  const gl = guard('gitlab', GITLAB_WRITES, gitlabScope('a/b', 'main'), send, () => {});
  const deep = guard('gitlab', GITLAB_WRITES, gitlabScope('group/sub/app', 'main'), send, () => {});
  type Call = readonly [HttpRequest['method'], string, unknown?];
  const refused = async (api: typeof gh, calls: readonly Call[]) => {
    for (const [method, path, body] of calls)
      await expect(
        api(body === undefined ? { method, path } : { method, path, body }),
        `${method} ${path} ${JSON.stringify(body)}`,
      ).rejects.toThrow(WriteRefused);
  };
  const allowed = async (api: typeof gh, calls: readonly Call[]) => {
    for (const [method, path, body] of calls)
      await expect(api(body === undefined ? { method, path } : { method, path, body })).resolves.toEqual({});
  };
  const tree = (path: string) => ({ base_tree: 't', tree: [{ path, mode: '100644', type: 'blob', content: 'x' }] });
  const pr = { title: 't', body: 'b', head: 'aw/alpha/t1', base: 'main', draft: false };

  it('never reaches a GitHub merge endpoint, however the path is spelled', async () => {
    await refused(gh, [
      ['PUT', '/repos/a/b/pulls/1/merge'],
      ['POST', '/repos/a/b/pulls/1/merge'],
      ['PUT', '/repos/a/b/contents/x.txt', { branch: 'aw/alpha/t1' }],
      ['POST', '/repos/a/b/merges'],
      ['PUT', '/repos/a/b/pulls/1/merge?x=1'],
      ['PATCH', '/repos/a/b/git/refs/heads/main', { sha: 'x' }],
      ['POST', '/graphql', { query: 'mutation { mergePullRequest }' }],
      ['POST', '/repos/a/b/pulls/../pulls/1/merge'],
      ['POST', '/repos/a/b/pulls/1/reviews/2/events'],
    ]);
  });

  it('refuses a write path with a query or a fragment, even on an allowed route', async () => {
    await refused(gh, [
      ['POST', '/repos/a/b/pulls?state=open', pr],
      ['POST', '/repos/a/b/pulls#x', pr],
    ]);
    await allowed(gh, [['POST', '/repos/a/b/pulls', pr]]);
  });

  it('pins every branch write to aw/<factory>/<task>', async () => {
    await refused(gh, [
      ['POST', '/repos/a/b/git/refs', { ref: 'refs/heads/main', sha: 'x' }],
      ['POST', '/repos/a/b/git/refs', { ref: 'refs/heads/aw/alpha/../main', sha: 'x' }],
      ['POST', '/repos/a/b/git/refs', { ref: 'refs/tags/aw/alpha/t1', sha: 'x' }],
      ['PATCH', '/repos/a/b/git/refs/heads/aw/alpha/t1', { sha: 'x', force: true }],
      ['PATCH', '/repos/a/b/git/refs/heads/aw/alpha', { sha: 'x' }],
      ['POST', '/repos/a/b/pulls', { ...pr, head: 'main' }],
      ['POST', '/repos/a/b/pulls', { ...pr, head: 'aw/alpha/-t1' }],
      ['POST', '/repos/a/b/pulls', { ...pr, head: 'aw/alpha/t 1' }],
      ['POST', '/repos/a/b/pulls', { ...pr, draft: true }],
    ]);
    await refused(gl, [
      ['POST', '/projects/a%2Fb/repository/commits', { branch: 'main', commit_message: 'm', actions: [] }],
      [
        'POST',
        '/projects/a%2Fb/merge_requests',
        { source_branch: 'refs/heads/main', target_branch: 'main', title: 't', description: 'd' },
      ],
    ]);
    await allowed(gh, [
      ['POST', '/repos/a/b/git/refs', { ref: 'refs/heads/aw/alpha/t1', sha: 'x' }],
      ['PATCH', '/repos/a/b/git/refs/heads/aw/alpha/t1', { sha: 'x', force: false }],
    ]);
  });

  it('refuses a commit that writes a hidden file, a symlink or a path with a backslash', async () => {
    await refused(gh, [
      ['POST', '/repos/a/b/git/trees', tree('.github/workflows/x.yml')],
      ['POST', '/repos/a/b/git/trees', tree('src/.env')],
      ['POST', '/repos/a/b/git/trees', tree('src\\..\\x')],
      ['POST', '/repos/a/b/git/trees', tree('src//x')],
      [
        'POST',
        '/repos/a/b/git/trees',
        { base_tree: 't', tree: [{ path: 'l', mode: '120000', type: 'blob', content: '/etc' }] },
      ],
    ]);
    const action = (file_path: string, act = 'create') => ({
      branch: 'aw/alpha/t1',
      commit_message: 'm',
      actions: [{ action: act, file_path, content: 'x' }],
    });
    await refused(gl, [
      ['POST', '/projects/a%2Fb/repository/commits', action('.gitlab-ci.yml')],
      ['POST', '/projects/a%2Fb/repository/commits', action('a.txt', 'delete')],
    ]);
    await allowed(gh, [['POST', '/repos/a/b/git/trees', tree('src/x.txt')]]);
    await allowed(gl, [['POST', '/projects/a%2Fb/repository/commits', action('src/x.txt')]]);
  });

  it('decodes the GitLab project id before it checks it, and matches routes by exact case', async () => {
    await refused(gl, [
      ['PUT', '/projects/a%2Fb/merge_requests/1/merge'],
      ['POST', '/projects/a%2Fb/merge_requests/1/merge'],
      ['POST', '/projects/a%2Fb/merge_requests/1/approve/../merge'],
      ['POST', '/projects/a%2Fb/merge_requests/1%2Fmerge/notes'],
      ['POST', '/projects/a%2Fb/merge_requests/1/merge_when_pipeline_succeeds'],
      ['POST', '/projects/a%2Fb%2F..%2Fc/merge_requests/1/notes', { body: 'x' }],
      ['POST', '/projects/a%2F.b/merge_requests/1/notes', { body: 'x' }],
      ['POST', '/projects/a%2fb/merge_requests/1/notes', { body: 'x' }],
      ['POST', '/projects/a%2Fb/MERGE_REQUESTS/1/approve', { sha: 'x' }],
      ['POST', '/projects/1/merge_requests/1/notes', { body: 'x' }],
      ['POST', '/api/graphql', { query: 'x' }],
    ]);
    await allowed(gl, [['POST', '/projects/a%2Fb/merge_requests/1/notes', { body: 'x' }]]);
    await allowed(deep, [['POST', '/projects/group%2Fsub%2Fapp/merge_requests/1/approve', { sha: 'x' }]]);
    await refused(deep, [['POST', '/projects/a%2Fb/merge_requests/1/approve', { sha: 'x' }]]);
  });

  it('binds every call, reads included, to the configured repository', async () => {
    await refused(gh, [
      ['GET', '/repos/a/c/pulls/1'],
      ['GET', '/repos/a/bb/pulls/1'],
      ['POST', '/repos/x/b/issues/1/comments', { body: 'x' }],
      ['POST', '/repos/a/b2/pulls', pr],
    ]);
    await refused(gl, [
      ['GET', '/projects/a%2Fc/merge_requests/1'],
      ['POST', '/projects/a%2Fbb/merge_requests/1/notes', { body: 'x' }],
      ['POST', '/projects/7/merge_requests/1/notes', { body: 'x' }],
    ]);
    await allowed(gh, [
      ['GET', '/user'],
      ['GET', '/repos/a/b/pulls/1'],
    ]);
    expect(() => githubScope('a', 'main')).toThrow(/owner/);
    expect(() => gitlabScope('7', 'main')).toThrow(/namespace path/);
    expect(() => gitlabScope('a/../b', 'main')).toThrow(/namespace path/);
  });

  it('refuses a body key the route does not list: force, another project, file modes, author overrides', async () => {
    const commit = {
      branch: 'aw/alpha/t1',
      commit_message: 'm',
      actions: [{ action: 'create', file_path: 'a', content: 'x' }],
    };
    const mr = { source_branch: 'aw/alpha/t1', target_branch: 'main', title: 't', description: 'd' };
    await refused(gl, [
      ['POST', '/projects/a%2Fb/repository/commits', { ...commit, force: true }],
      ['POST', '/projects/a%2Fb/repository/commits', { ...commit, start_project: 9 }],
      ['POST', '/projects/a%2Fb/repository/commits', { ...commit, start_branch: 'release' }],
      ['POST', '/projects/a%2Fb/repository/commits', { ...commit, author_email: 'x@y.z' }],
      [
        'POST',
        '/projects/a%2Fb/repository/commits',
        { ...commit, actions: [{ ...commit.actions[0], execute_filemode: true }] },
      ],
      ['POST', '/projects/a%2Fb/merge_requests', { ...mr, target_branch: 'production' }],
      ['POST', '/projects/a%2Fb/merge_requests', { ...mr, target_project_id: 9 }],
      ['POST', '/projects/a%2Fb/merge_requests', { ...mr, remove_source_branch: true }],
      ['POST', '/projects/a%2Fb/merge_requests/1/notes', { body: 'x', merge_request_diff_head_sha: 'x' }],
      [
        'POST',
        '/projects/a%2Fb/merge_requests/1/discussions',
        { body: 'x', position: { position_type: 'text', x: 1 } },
      ],
    ]);
    await refused(gh, [
      ['POST', '/repos/a/b/git/commits', { message: 'm', tree: 't', parents: ['p'], author: { name: 'x' } }],
      ['POST', '/repos/a/b/git/commits', { message: 'm', tree: 't', parents: ['p'], committer: { name: 'x' } }],
      ['POST', '/repos/a/b/pulls', { ...pr, issue: 3 }],
      ['POST', '/repos/a/b/pulls', { ...pr, base: 'production' }],
      ['POST', '/repos/a/b/pulls', { ...pr, maintainer_can_modify: true }],
      ['POST', '/repos/a/b/git/refs', { ref: 'refs/heads/aw/alpha/t1', sha: 'x', force: true }],
      [
        'POST',
        '/repos/a/b/git/trees',
        { base_tree: 't', tree: [{ path: 'a', mode: '100644', type: 'blob', content: 'x', sha: 'y' }] },
      ],
      [
        'POST',
        '/repos/a/b/pulls/1/reviews',
        { event: 'COMMENT', body: 'ok', comments: [{ path: 'a', line: 1, body: 'b', start_line: 0 }] },
      ],
    ]);
    await allowed(gl, [
      ['POST', '/projects/a%2Fb/repository/commits', { ...commit, start_branch: 'main' }],
      ['POST', '/projects/a%2Fb/merge_requests', mr],
    ]);
    await allowed(gh, [['POST', '/repos/a/b/git/commits', { message: 'm', tree: 't', parents: ['p'] }]]);
  });

  it('refuses a body that holds a quick action, a mention, raw HTML or a link outside code', async () => {
    const bad = [
      '/merge',
      'ok\n/approve',
      '  /merge',
      '> /merge',
      '- /merge',
      '1. /merge',
      '\u200b/merge',
      '\uff0fmerge',
      '\u2215merge',
      'hi @everyone',
      'see <img src=x onerror=alert(1)>',
      'click [here](https://evil.example)',
      'x'.repeat(70_000),
    ];
    for (const body of bad) {
      await refused(gl, [['POST', '/projects/a%2Fb/merge_requests/1/notes', { body }]]);
      await refused(gh, [['POST', '/repos/a/b/issues/1/comments', { body }]]);
    }
    await refused(gh, [
      [
        'POST',
        '/repos/a/b/pulls/1/reviews',
        { event: 'COMMENT', body: 'ok', comments: [{ path: 'a', line: 1, body: '/merge' }] },
      ],
      ['POST', '/repos/a/b/pulls', { ...pr, title: 'a\n/merge' }],
      ['POST', '/repos/a/b/git/commits', { message: 'x\n/merge', tree: 't', parents: ['p'] }],
      ['POST', '/repos/a/b/pulls/1/reviews', { event: 'DISMISS', body: 'ok' }],
      ['POST', '/repos/a/b/pulls', { ...pr, title: 'line one\nline two' }],
      ['POST', '/repos/a/b/pulls', { ...pr, title: 'line one\u2028line two' }],
    ]);
    await refused(gl, [
      [
        'POST',
        '/projects/a%2Fb/merge_requests',
        { source_branch: 'aw/alpha/t1', target_branch: 'main', title: 'line one\nline two', description: 'd' },
      ],
    ]);
    await allowed(gl, [
      ['POST', '/projects/a%2Fb/merge_requests/1/notes', { body: 'fine `@user` and\n```text\n│ /merge\n```' }],
      [
        'POST',
        '/projects/a%2Fb/merge_requests/1/notes',
        { body: 'x\n<!-- agent-works:merge-brief task=alpha/t1 head=abc -->' },
      ],
    ]);
  });
});

describe('reading every page', () => {
  const serve = (n: number) => {
    const asked: string[] = [];
    const get = async (path: string) => {
      asked.push(path);
      const page = Number(new URL(path, 'https://x.invalid').searchParams.get('page'));
      return Array.from({ length: Math.max(0, Math.min(100, n - (page - 1) * 100)) }, (_, i) => i);
    };
    return { get, asked };
  };

  it('reads exactly 5,000 items and refuses 5,001', async () => {
    for (const n of [0, 99, 100, 101, 250, 4_999, 5_000]) {
      const { get } = serve(n);
      expect(await allPages(get, '/x'), String(n)).toHaveLength(n);
    }
    await expect(allPages(serve(5_001).get, '/x')).rejects.toThrow(/more than 5000 items/);
    await expect(allPages(serve(1_000_000).get, '/x')).rejects.toThrow(/more than 5000 items/);
    const { get, asked } = serve(150);
    await allPages(get, '/x?state=open');
    expect(asked).toEqual(['/x?state=open&per_page=100&page=1', '/x?state=open&per_page=100&page=2']);
  });
});

describe('parsing edge cases the cages mode relies on', () => {
  it('reads a closed, unmerged GitLab MR as closed', () => {
    const f = load('gitlab/merge_request-open.json');
    set(f.body, 'object_attributes.state', 'closed');
    expect(parse(f)).toMatchObject({ kind: 'change', state: 'closed' });
  });

  it('reads a neutral check run as passing', () => {
    const f = load('github/check_run-completed.json');
    set(f.body, 'check_run.conclusion', 'neutral');
    expect(parse(f)).toMatchObject({ kind: 'check', state: 'success' });
  });

  it('opens a GitHub PR ready for review, not as a draft', async () => {
    const fake = new FakeGithub();
    const host = github({ repo: 'acme/app', base: 'main', send: fake.transport('aw-nova'), log: () => {} });
    await host.pushFiles('acme/app', {
      branch: 'aw/alpha/t1',
      base: 'main',
      files: [{ path: 'a', content: 'a\n' }],
      message: 'm',
    });
    await host.openChange('acme/app', { branch: 'aw/alpha/t1', base: 'main', title: 't', body: 'b' });
    expect(fake.prs[0]?.draft).toBe(false);
  });

  it('finds the change only on the exact branch, whatever the host list returns', async () => {
    const fake = new FakeGithub();
    const host = github({ repo: 'acme/app', base: 'main', send: fake.transport('aw-nova'), log: () => {} });
    await host.pushFiles('acme/app', {
      branch: 'aw/alpha/t10',
      base: 'main',
      files: [{ path: 'a', content: 'a\n' }],
      message: 'm',
    });
    await host.openChange('acme/app', { branch: 'aw/alpha/t10', base: 'main', title: 't', body: 'b' });
    const loose = github({
      repo: 'acme/app',
      base: 'main',
      send: async (request) => {
        const url = new URL(request.path, 'https://x.invalid');
        if (url.pathname.endsWith('/pulls')) url.searchParams.delete('head');
        return fake.transport('aw-nova')({ ...request, path: url.pathname + url.search });
      },
      log: () => {},
    });
    expect(await loose.findChange('acme/app', 'aw/alpha/t1')).toBeNull();
    expect(await loose.findChange('acme/app', 'aw/alpha/t10')).toMatchObject({ number: 1 });
  });

  it('approves on GitLab only when the verdict is approve', async () => {
    const fake = new FakeGitlab();
    const author = gitlab({ repo: 'acme/app', base: 'main', send: fake.transport('aw-nova'), log: () => {} });
    const reviewer = gitlab({ repo: 'acme/app', base: 'main', send: fake.transport('vega'), log: () => {} });
    const head = await author.pushFiles('acme/app', {
      branch: 'aw/alpha/t1',
      base: 'main',
      files: [{ path: 'a', content: 'a\n' }],
      message: 'm',
    });
    const mr = await author.openChange('acme/app', { branch: 'aw/alpha/t1', base: 'main', title: 't', body: 'b' });
    await reviewer.postReview('acme/app', mr.number, { commitId: head, verdict: 'changes', body: 'no', comments: [] });
    expect(fake.approvals).toEqual([]);
    await reviewer.postReview('acme/app', mr.number, { commitId: head, verdict: 'approve', body: 'ok', comments: [] });
    expect(fake.approvals).toHaveLength(1);
  });
});

describe('a review the host refuses on a PR the same account opened', () => {
  it('posts it as a comment that names the verdict, and reports the comment verdict the host holds', async () => {
    const fake = new FakeGithub();
    const host = github({ repo: 'acme/app', base: 'main', send: fake.transport('fiatfour'), log: () => {} });
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

describe('a GitHub review with inline comments the host cannot place', () => {
  const OLD = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const lines = (edit?: string) => `${OLD.map((l) => (l === 'two' && edit !== undefined ? edit : l)).join('\n')}\n`;

  const open = async (account: string, files: Array<{ path: string; content: string }>) => {
    const fake = new FakeGithub();
    fake.commitOn('main', { 'src/old.txt': 'gone\n', 'src/big.txt': lines() });
    const author = github({ repo: 'acme/app', base: 'main', send: fake.transport('aw-bot'), log: () => {} });
    const head = await author.pushFiles('acme/app', {
      branch: 'aw/alpha/t1',
      base: 'main',
      files,
      message: 'm',
    });
    fake.trees.get(head)?.delete('src/old.txt');
    const pr = await author.openChange('acme/app', { branch: 'aw/alpha/t1', base: 'main', title: 't', body: 'b' });
    const host = github({ repo: 'acme/app', base: 'main', send: fake.transport(account), log: () => {} });
    return { fake, host, head, number: pr.number };
  };

  const changed = [{ path: 'src/big.txt', content: lines('TWO') }];

  it('refuses a line outside the diff with the 422 shape the host gives', async () => {
    const { fake, number, head } = await open('aw-reviewer', changed);
    const send = fake.transport('aw-reviewer');
    const response = await send({
      method: 'POST',
      path: `/repos/acme/app/pulls/${number}/reviews`,
      body: {
        commit_id: head,
        event: 'COMMENT',
        body: 'x',
        comments: [{ path: 'src/big.txt', line: 12, side: 'RIGHT', body: 'far' }],
      },
    });
    expect(response).toEqual({ status: 422, body: UNRESOLVED_LINE });
    expect(fake.reviews).toEqual([]);
  });

  it('accepts a changed line and a context line, and refuses a far line, a deleted file and a file the PR left alone', async () => {
    const { fake, number, head, host } = await open('aw-reviewer', [
      ...changed,
      { path: 'src/new.txt', content: 'n\n' },
    ]);
    const draft = (path: string, line: number) => ({
      commitId: head,
      verdict: 'comment' as const,
      body: 'b',
      comments: [{ path, line, body: 'c' }],
    });
    await host.postReview('acme/app', number, draft('src/big.txt', 2));
    await host.postReview('acme/app', number, draft('src/big.txt', 5));
    await host.postReview('acme/app', number, draft('src/new.txt', 1));
    expect(fake.comments.map((c) => `${c.path}:${c.line}`)).toEqual([
      'src/big.txt:2',
      'src/big.txt:5',
      'src/new.txt:1',
    ]);
    for (const [path, line] of [
      ['src/big.txt', 6],
      ['src/old.txt', 1],
      ['README.md', 1],
      ['src/new.txt', 2],
    ] as const) {
      fake.comments.length = 0;
      await host.postReview('acme/app', number, draft(path, line));
      expect(fake.comments).toEqual([]);
    }
  });

  it('reposts without the inline comments and carries each one, path:line and body, into the review body', async () => {
    const { fake, number, head, host } = await open('aw-reviewer', changed);
    const before = fake.reviews.length;
    const posted = await host.postReview('acme/app', number, {
      commitId: head,
      verdict: 'changes',
      body: 'needs work\n<!-- agent-works:review worker=vega verdict=changes -->',
      comments: [
        { path: 'src/big.txt', line: 2, body: 'inside' },
        { path: 'src/big.txt', line: 12, body: 'outside' },
        { path: 'src/old.txt', line: 1, body: 'deleted' },
      ],
    });
    expect(posted).toMatchObject({ kind: 'review', verdict: 'changes', reviewer: 'aw-reviewer', commitId: head });
    expect(fake.reviews.length).toBe(before + 1);
    expect(fake.comments).toEqual([]);
    const body = fake.reviews.at(-1)?.body ?? '';
    expect(body).toContain('needs work\n<!-- agent-works:review worker=vega verdict=changes -->');
    expect(body).toContain(DROPPED_MARK);
    for (const finding of ['`src/big.txt:2`\ninside', '`src/big.txt:12`\noutside', '`src/old.txt:1`\ndeleted'])
      expect(body).toContain(finding);
  });

  it('handles the own-pull-request refusal and the outside-the-diff refusal on one review', async () => {
    const { fake, number, head, host } = await open('aw-bot', changed);
    const posted = await host.postReview('acme/app', number, {
      commitId: head,
      verdict: 'approve',
      body: 'ok',
      comments: [{ path: 'src/big.txt', line: 12, body: 'outside' }],
    });
    expect(posted).toMatchObject({ verdict: 'comment', reviewer: 'aw-bot', commitId: head });
    expect(fake.reviews).toHaveLength(1);
    const body = fake.reviews[0]?.body ?? '';
    expect(body).toContain('"approve"');
    expect(body).toContain('`src/big.txt:12`\noutside');
  });

  it('copes with the two refusals arriving in the other order, and stops when the refusal is something else', async () => {
    const refusals = [
      { status: 422, body: UNRESOLVED_LINE },
      { status: 422, body: { message: 'Review Can not approve your own pull request' } },
    ];
    const sent: unknown[] = [];
    const send = async (request: HttpRequest): Promise<HttpResponse> => {
      sent.push(request.body);
      const refusal = refusals.shift();
      if (refusal !== undefined) return refusal;
      return {
        status: 200,
        body: {
          id: 9,
          user: { login: 'x' },
          state: 'COMMENTED',
          commit_id: 'c',
          submitted_at: '2026-01-01T00:00:00Z',
          body: '',
        },
      };
    };
    const host = github({ repo: 'acme/app', base: 'main', send, log: () => {} });
    await host.postReview('acme/app', 1, {
      commitId: 'c'.repeat(40),
      verdict: 'approve',
      body: 'ok',
      comments: [{ path: 'a', line: 1, body: 'b' }],
    });
    expect(sent.map((b) => (b as { event: string; comments: unknown[] }).comments.length)).toEqual([1, 0, 0]);
    expect(sent.map((b) => (b as { event: string }).event)).toEqual(['APPROVE', 'APPROVE', 'COMMENT']);

    const other = github({
      repo: 'acme/app',
      base: 'main',
      send: async () => ({
        status: 422,
        body: { message: 'Unprocessable Entity', errors: ['commit_id is not part of the pull request'] },
      }),
      log: () => {},
    });
    await expect(
      other.postReview('acme/app', 1, {
        commitId: 'c'.repeat(40),
        verdict: 'comment',
        body: 'b',
        comments: [{ path: 'a', line: 1, body: 'b' }],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('keeps the review body under the host limit and says how many findings it left out', async () => {
    const { fake, number, head, host } = await open('aw-reviewer', changed);
    const comments = Array.from({ length: 30 }, (_, i) => ({
      path: 'src/big.txt',
      line: 12,
      body: `${i}`.padEnd(5000, 'x'),
    }));
    await host.postReview('acme/app', number, { commitId: head, verdict: 'comment', body: 'b', comments });
    const body = fake.reviews.at(-1)?.body ?? '';
    expect(body.length).toBeLessThan(65536);
    expect(body).toMatch(/\d+ more comments do not fit/);
  });

  it.each([
    ['the outside-the-diff refusal first', true],
    ['the own-pull-request refusal first', false],
  ])('keeps the review body inside the write guard for every body size, with %s', async (_name, outsideFirst) => {
    const own = { status: 422, body: { message: 'Review Can not approve your own pull request' } };
    const outside = { status: 422, body: UNRESOLVED_LINE };
    const comments = Array.from({ length: 20 }, (_, i) => ({ path: 'a', line: 99, body: `${i}`.padEnd(3900, 'x') }));
    const tooLong: string[] = [];
    for (let pad = 0; pad < 4000; pad += 7) {
      const refusals = outsideFirst ? [outside, own] : [own, outside];
      let sent = '';
      const send = async (request: HttpRequest): Promise<HttpResponse> => {
        const refusal = refusals.shift();
        if (refusal !== undefined) return refusal;
        sent = (request.body as { body: string }).body;
        return {
          status: 200,
          body: {
            id: 9,
            user: { login: 'x' },
            state: 'COMMENTED',
            commit_id: 'c',
            submitted_at: '2026-01-01T00:00:00Z',
            body: sent,
          },
        };
      };
      const host = github({ repo: 'acme/app', base: 'main', send, log: () => {} });
      const posted = host.postReview('acme/app', 1, {
        commitId: 'c'.repeat(40),
        verdict: 'approve',
        body: 'y'.repeat(pad),
        comments,
      });
      await expect(posted, `pad ${pad}`).resolves.toMatchObject({ verdict: 'comment' });
      if (sent.length > 60_000) tooLong.push(`${pad}:${sent.length}`);
      expect(sent.indexOf('GitHub refuses it'), `pad ${pad}`).toBeGreaterThan(-1);
      expect(sent.indexOf('GitHub refuses it'), `pad ${pad}`).toBeLessThan(sent.indexOf(DROPPED_MARK));
      expect(sent, `pad ${pad}`).toMatch(/\d+ more comments do not fit/);
    }
    expect(tooLong).toEqual([]);
  });

  it('refuses a review for a commit the PR does not hold', async () => {
    const { host, number } = await open('aw-reviewer', changed);
    await expect(
      host.postReview('acme/app', number, { commitId: 'f'.repeat(40), verdict: 'comment', body: 'b', comments: [] }),
    ).rejects.toMatchObject({ status: 422 });
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
      checks: [
        { host: 'github', kind: 'check', repo: 'acme/app', headSha: 'old', name: 'ci', state: 'failure', at: 1 },
        { host: 'github', kind: 'check', repo: 'acme/app', headSha: 'new', name: 'ci', state: 'success', at: 2 },
      ],
    });
    expect(poll.reviews).toEqual([{ reviewer: 'r2', verdict: 'changes' }]);
    expect(poll.checks).toEqual([{ name: 'ci', state: 'success' }]);
  });
});
