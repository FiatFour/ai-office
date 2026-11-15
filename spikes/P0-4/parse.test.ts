import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignToFactories,
  branchName,
  githubSignatureValid,
  lifecycleWriteAllowed,
  PayloadError,
  parseEvent,
  routeBranch,
} from './githost.mjs';

type Body = Record<string, unknown>;
type Fixture = { host: 'github' | 'gitlab'; event: string; body: Body };

const root = join(import.meta.dirname, 'fixtures');
const fixtures = (['github', 'gitlab'] as const).flatMap((host) =>
  readdirSync(join(root, host)).map((file) => ({
    name: `${host}/${file}`,
    fixture: JSON.parse(readFileSync(join(root, host, file), 'utf8')) as Fixture,
  })),
);
const load = (name: string) => structuredClone(fixtures.find((f) => f.name === name)?.fixture) as Fixture;

function edit(body: Body, path: string, value?: unknown) {
  const keys = path.split('.');
  const last = keys.pop() as string;
  const parent = keys.reduce((node, key) => node[key] as Body, body);
  if (value === undefined) delete parent[last];
  else parent[last] = value;
}

const expected: Record<string, object> = {
  'github/push.json': { kind: 'push', ref: 'refs/heads/aw/alpha/t1' },
  'github/status.json': { kind: 'check', name: 'agent-works/spike', state: 'success' },
  'github/check_run-completed.json': { kind: 'check', repo: 'FiatFour/ai-office', state: 'success' },
  'github/pull_request-opened.json': { kind: 'change', action: 'opened', state: 'open', branch: 'aw/alpha/t1' },
  'github/pull_request-closed.json': { kind: 'change', action: 'closed', state: 'closed', branch: 'aw/beta/t2' },
  'github/pull_request_review.json': { kind: 'review', number: 1, verdict: 'commented' },
  'github/pull_request_review_comment.json': { kind: 'review_comment', path: 'spike/alpha-t1.md', line: 2 },
  'gitlab/push.json': { kind: 'push', host: 'gitlab' },
  'gitlab/merge_request-open.json': { kind: 'change', action: 'open', state: 'open' },
  'gitlab/note-merge-request.json': { kind: 'review_comment', line: null },
  'gitlab/pipeline.json': { kind: 'check', state: 'success' },
};

describe('parseEvent', () => {
  it('has an expectation for every fixture', () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(fixtures)('parses $name into its typed event', ({ name, fixture }) => {
    const event = parseEvent(fixture.host, fixture.event, fixture.body);
    expect(event).toMatchObject({ host: fixture.host, ...expected[name] });
  });

  it.each([
    ['github/push.json', 'after'],
    ['github/pull_request-opened.json', 'pull_request.head.ref'],
    ['github/pull_request_review.json', 'review.state'],
    ['github/check_run-completed.json', 'check_run.head_sha'],
    ['gitlab/merge_request-open.json', 'object_attributes.iid'],
    ['gitlab/pipeline.json', 'object_attributes.status'],
  ])('rejects %s without %s', (name, path) => {
    const { host, event, body } = load(name);
    edit(body, path);
    expect(() => parseEvent(host, event, body)).toThrow(new PayloadError(path));
  });

  it('reads a closed pull request with merged true as merged', () => {
    const { body } = load('github/pull_request-closed.json');
    edit(body, 'pull_request.merged', true);
    expect(parseEvent('github', 'pull_request', body)).toMatchObject({ state: 'merged', action: 'closed' });
  });

  it('reads a GitLab line note with its position', () => {
    const { body } = load('gitlab/note-merge-request.json');
    edit(body, 'object_attributes.position', { new_path: 'src/app.ts', new_line: 7 });
    expect(parseEvent('gitlab', 'Note Hook', body)).toMatchObject({ path: 'src/app.ts', line: 7 });
  });

  it('ignores events the lifecycle does not use', () => {
    expect(parseEvent('github', 'ping', { zen: 'hi' })).toBeNull();
  });
});

describe('routing', () => {
  it('assigns each change to the factory in its branch prefix', () => {
    const byFactory = assignToFactories([
      { number: 1, branch: branchName({ factory: 'alpha', task: 't1' }) },
      { number: 2, branch: branchName({ factory: 'beta', task: 't2' }) },
      { number: 3, branch: 'feature/no-prefix' },
    ]);
    expect([...byFactory].map(([factory, changes]) => [factory, changes.map((c) => c.number)])).toEqual([
      ['alpha', [1]],
      ['beta', [2]],
      [null, [3]],
    ]);
  });

  it('rejects branch names outside aw/<factory>/<task>', () => {
    expect(routeBranch('aw/alpha')).toBeNull();
    expect(routeBranch('aw/Alpha/t1')).toBeNull();
    expect(() => branchName({ factory: 'a/b', task: 't' })).toThrow();
  });
});

describe('guards', () => {
  it('sends only the writes the lifecycle needs, so no merge call goes out', () => {
    expect(lifecycleWriteAllowed('PUT', '/repos/o/r/pulls/4/merge')).toBe(false);
    expect(lifecycleWriteAllowed('POST', '/repos/o/r/merges')).toBe(false);
    expect(lifecycleWriteAllowed('PUT', '/projects/9/merge_requests/4/merge')).toBe(false);
    expect(lifecycleWriteAllowed('GET', '/repos/o/r/pulls/4/merge')).toBe(true);
    expect(lifecycleWriteAllowed('POST', '/repos/o/r/pulls/4/reviews')).toBe(true);
    expect(lifecycleWriteAllowed('PUT', '/repos/o/r/contents/spike/perf.txt')).toBe(true);
  });

  it('accepts only the matching webhook signature', () => {
    const raw = Buffer.from('Hello, World!');
    const docsVector = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(githubSignatureValid("It's a Secret to Everybody", raw, docsVector)).toBe(true);
    expect(githubSignatureValid('another secret', raw, docsVector)).toBe(false);
    expect(githubSignatureValid("It's a Secret to Everybody", raw, undefined)).toBe(false);
  });
});
