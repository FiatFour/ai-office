import { describe, expect, it } from 'vitest';
import { github } from '../../server/githost/github.ts';
import { type Scope, writeProblem } from '../../server/githost/host.ts';
import { FakeGithub } from '../../server/test/fakes/github-api.ts';
import { NO_CI_CONTEXT, NO_CI_DESCRIPTION, NO_CI_WRITES, withNoCiStatus } from '../no-ci.ts';

const REPO = 'acme/app-scratch';
const BRANCH = 'aw/bench/t-0123abcd-r1';
const SHA = 'a'.repeat(40);
const scope: Scope = { home: `/repos/${REPO}`, base: 'main' };
const post = (body: Record<string, unknown>, path = `/repos/${REPO}/statuses/${SHA}`) =>
  writeProblem(NO_CI_WRITES, { method: 'POST', path, body }, scope);
const ok = { state: 'success', context: NO_CI_CONTEXT, description: NO_CI_DESCRIPTION };

describe('the no-ci status write rule', () => {
  it('allows exactly the success status of the harness on a full commit sha', () => {
    expect(post(ok)).toBeNull();
  });

  it.each([
    ['another state', { ...ok, state: 'failure' }],
    ['another context', { ...ok, context: 'ci' }],
    ['another description', { ...ok, description: 'looks fine' }],
    ['a target url', { ...ok, target_url: 'https://example.com' }],
  ])('refuses %s', (_name, body) => {
    expect(post(body)).not.toBeNull();
  });

  it('refuses a branch name, another repository and another verb in place of the sha', () => {
    expect(post(ok, `/repos/${REPO}/statuses/main`)).not.toBeNull();
    expect(post(ok, `/repos/other/app-scratch/statuses/${SHA}`)).not.toBeNull();
    expect(
      writeProblem(NO_CI_WRITES, { method: 'PUT', path: `/repos/${REPO}/statuses/${SHA}`, body: ok }, scope),
    ).not.toBeNull();
  });
});

describe('the no-ci status on a host that reports no checks', () => {
  const setup = () => {
    const fake = new FakeGithub(REPO, null);
    const send = fake.transport('aw-nova');
    const failures: unknown[] = [];
    const inner = github({ repo: REPO, base: 'main', send, log: () => {} });
    const aborted = new AbortController();
    const host = withNoCiStatus(inner, {
      repo: REPO,
      base: 'main',
      send,
      log: () => {},
      onFailure: (error) => failures.push(error),
      signal: aborted.signal,
    });
    const statusPosts = () => fake.calls.filter((c) => c.path.includes('/statuses/')).length;
    return { fake, inner, host, failures, statusPosts, aborted };
  };
  const files = (content: string) => [{ path: 'src/a.js', content }];
  const spec = (content: string) => ({ branch: BRANCH, base: 'main', files: files(content), message: 'work' });

  it('marks a pushed head once however often it is read, and marks the next head again', async () => {
    const { host, statusPosts } = setup();
    const first = await host.pushFiles(REPO, spec('one\n'));
    const opened = await host.openChange(REPO, { branch: BRANCH, base: 'main', title: 't', body: 'b' });
    const seen = await host.snapshot(REPO, opened.number);
    expect(seen.checks.map((c) => [c.headSha, c.name, c.state])).toEqual([[first, NO_CI_CONTEXT, 'success']]);
    await host.snapshot(REPO, opened.number);
    await host.snapshot(REPO, opened.number);
    expect(statusPosts()).toBe(1);
    const second = await host.pushFiles(REPO, spec('two\n'));
    const later = await host.snapshot(REPO, opened.number);
    expect(later.checks.map((c) => c.headSha)).toEqual([second]);
    expect(statusPosts()).toBe(2);
  });

  it('posts no status once the run is aborted and reports no failure', async () => {
    const { host, failures, statusPosts, aborted } = setup();
    await host.pushFiles(REPO, spec('one\n'));
    const opened = await host.openChange(REPO, { branch: BRANCH, base: 'main', title: 't', body: 'b' });
    aborted.abort();
    await expect(host.snapshot(REPO, opened.number)).rejects.toThrow();
    expect(statusPosts()).toBe(0);
    expect(failures).toEqual([]);
  });

  it('does not mark a head the guarded push did not produce', async () => {
    const { fake, host, statusPosts } = setup();
    const opened = await host
      .openChange(REPO, { branch: BRANCH, base: 'main', title: 't', body: 'b' })
      .catch(() => null);
    expect(opened).toBeNull();
    fake.commitOn(BRANCH, { 'src/a.js': 'human\n' });
    const created = await host.openChange(REPO, { branch: BRANCH, base: 'main', title: 't', body: 'b' });
    const seen = await host.snapshot(REPO, created.number);
    expect(seen.checks).toEqual([]);
    expect(statusPosts()).toBe(0);
  });

  it('keeps the first failure, posts nothing again and reports it once', async () => {
    const fake = new FakeGithub(REPO, null);
    const real = fake.transport('aw-nova');
    let posts = 0;
    const send = async (request: Parameters<typeof real>[0]) => {
      if (!request.path.includes('/statuses/')) return real(request);
      posts += 1;
      return { status: 403, body: { message: 'no' } };
    };
    const failures: unknown[] = [];
    const inner = github({ repo: REPO, base: 'main', send, log: () => {} });
    const host = withNoCiStatus(inner, {
      repo: REPO,
      base: 'main',
      send,
      log: () => {},
      onFailure: (error) => failures.push(error),
      signal: new AbortController().signal,
    });
    await host.pushFiles(REPO, spec('one\n'));
    const opened = await host.openChange(REPO, { branch: BRANCH, base: 'main', title: 't', body: 'b' });
    await expect(host.snapshot(REPO, opened.number)).rejects.toThrow('403');
    await expect(host.snapshot(REPO, opened.number)).rejects.toThrow('403');
    expect(posts).toBe(1);
    expect(failures).toHaveLength(1);
  });
});
