import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../agents/runtime.ts';
import { scripted } from '../agents/scripted.ts';
import { github } from '../githost/github.ts';
import { gitlab } from '../githost/gitlab.ts';
import type { ApiCall, GitHost } from '../githost/host.ts';
import { type RunningHq, startHq } from '../hq.ts';
import { type ActionItem, cagesMode } from '../modes/cages.ts';
import { exportEvents } from '../modes/events-export.ts';
import type { Denial } from '../sandbox/firewall.ts';
import type { Snapshot } from '../snapshot.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { FakeGitlab } from './fakes/gitlab-api.ts';
import { SCRIPTS, TICKETS } from './fixtures/factory.ts';
import { hasSqlite, tempDir } from './helpers.ts';

class FakeProxy {
  sink: (denial: Denial) => void = () => {};
  readonly allowed = new Set<string>();
  denies = 0;
  reach = async (agent: string, host: string) => {
    if (this.allowed.has(host)) return true;
    this.denies += 1;
    this.sink({ host, port: 443, agent, reason: 'not on the allowlist', at: new Date().toISOString() });
    return false;
  };
  allow = async (host: string) => {
    this.allowed.add(host);
  };
}

const running: RunningHq[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((hq) => hq.close()));
});

interface Setup {
  readonly home?: string;
  readonly host: GitHost;
  readonly reviewHost?: GitHost;
  readonly proxy?: FakeProxy;
  readonly runtime?: AgentRuntime;
}

const boot = async ({ home = tempDir('cages'), host, reviewHost, proxy = new FakeProxy(), runtime }: Setup) => {
  const agent = runtime ?? scripted({ scripts: SCRIPTS, egress: proxy, retryMs: 10 });
  const hq = await startHq({
    home,
    port: 0,
    makeDriver: async (_hq, onDenial) => {
      proxy.sink = onDenial;
      return null;
    },
    mode: cagesMode({
      host,
      ...(reviewHost === undefined ? {} : { reviewHost }),
      repo: 'acme/app',
      base: 'main',
      tickets: TICKETS,
      author: 'nova',
      reviewer: 'vega',
      workers: { nova: agent, vega: agent },
      egress: proxy,
      pollMs: 30,
    }),
  });
  running.push(hq);
  return { hq, home, proxy };
};

const post = async (hq: RunningHq, path: string, body: unknown) => {
  const res = await fetch(`${hq.url}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const until = async (hq: RunningHq, test: (s: Snapshot) => boolean, ms = 4000): Promise<Snapshot> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const snap = hq.snapshot();
    if (test(snap)) return snap;
    if (Date.now() > deadline)
      throw new Error(`timed out; boxes ${JSON.stringify(snap.state.boxes)} actions ${JSON.stringify(snap.actions)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

const station = (task: string) => (s: Snapshot) => s.state.boxes[task]?.state;
const action = (kind: ActionItem['kind']) => (s: Snapshot) => s.actions.find((a) => a.kind === kind);

const twoAccounts = () => {
  const fake = new FakeGithub();
  const calls: ApiCall[] = [];
  const log = (c: ApiCall) => calls.push(c);
  return {
    fake,
    calls,
    hosts: {
      host: github({ send: fake.transport('aw-nova'), log }),
      reviewHost: github({ send: fake.transport('vega'), log }),
    },
  };
};

describe.skipIf(!hasSqlite)('one ticket through the cages mode', () => {
  it('opens a PR on the prefixed branch that links the work order, gets a peer review with line comments, and reaches merge-ready with a brief', async () => {
    const { fake, calls, hosts } = twoAccounts();
    const { hq } = await boot(hosts);
    expect((await post(hq, '/api/tickets', { id: 'alpha/t2' })).json).toEqual({
      task: 'alpha/t2',
      branch: 'aw/alpha/t2',
    });
    const ready = await until(hq, (s) => action('ready_to_merge')(s) !== undefined);
    expect(fake.prs).toHaveLength(1);
    expect(fake.prs[0]).toMatchObject({ head: 'aw/alpha/t2', author: 'aw-nova' });
    expect(fake.prs[0]?.body).toContain('https://example.invalid/work-orders/alpha-t2');
    const reviews = fake.reviews.filter((r) => r.pr === 1);
    expect(reviews.map((r) => [r.user, r.state])).toEqual([
      ['vega', 'CHANGES_REQUESTED'],
      ['vega', 'APPROVED'],
    ]);
    expect(fake.comments.find((c) => c.line === 3)).toMatchObject({ user: 'vega', path: 'docs/note.md' });
    expect(new Set(reviews.map((r) => r.commit)).size).toBe(2);
    expect(ready.mode?.rounds['alpha/t2']).toBe(1);
    expect(fake.filesAt('aw/alpha/t2').get('docs/note.md')).toContain('second draft');
    const brief = fake.issueComments.find((c) => c.body.includes('agent-works:merge-brief'));
    expect(brief?.body).toContain('Round 1: vega (scripted) gave changes');
    expect(brief?.body).toContain('asked: docs/note.md:3 Say "second draft".');
    expect(brief?.body).toContain('- Screenshots: not collected, ');
    expect(brief?.body).toContain('Cross-runtime review not collected');
    expect(ready.mode?.reviewGap).toContain('Codex is deferred');
    expect(calls.filter((c) => /\/merge/.test(c.path))).toEqual([]);
  });

  it('closes the task within one poll after a person merges on the host, and never calls a merge endpoint', async () => {
    const { fake, calls, hosts } = twoAccounts();
    const { hq } = await boot(hosts);
    await post(hq, '/api/tickets', { id: 'alpha/t1' });
    await until(hq, (s) => station('alpha/t1')(s) === 'merge' && action('ready_to_merge')(s) !== undefined);
    fake.mergeByHuman(1);
    const merged = Date.now();
    await until(hq, (s) => station('alpha/t1')(s) === 'shipped');
    expect(Date.now() - merged).toBeLessThan(1000);
    expect(hq.snapshot().actions.filter((a) => a.kind === 'ready_to_merge')).toEqual([]);
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((c) => /merge/.test(c.path))).toEqual([]);
    expect(fake.calls.filter((c) => /\/merge$/.test(c.path))).toEqual([]);
    const out = join(tempDir('export'), 'events.jsonl');
    const written = await exportEvents(hq.url, out);
    const lines = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(written);
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    expect(lines.some((l) => l.event.source === 'poll' && l.event.state === 'merged')).toBe(true);
  });

  it('stops after three fix rounds and files an Action item for the human', async () => {
    const { fake, hosts } = twoAccounts();
    const { hq } = await boot(hosts);
    await post(hq, '/api/tickets', { id: 'alpha/stubborn' });
    const snap = await until(hq, (s) => action('round_limit')(s) !== undefined);
    expect(action('round_limit')(snap)).toMatchObject({ task: 'alpha/stubborn', fixRounds: 3 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.reviews.filter((r) => r.state === 'CHANGES_REQUESTED')).toHaveLength(4);
    expect(fake.filesAt('aw/alpha/stubborn').get('src/word.txt')).toBe('word version 3\n');
    expect(station('alpha/stubborn')(hq.snapshot())).toBe('qc');
  });

  it('turns a blocked website into an Action item, and the worker retry succeeds after Allow', async () => {
    const { fake, hosts } = twoAccounts();
    const { hq, proxy } = await boot(hosts);
    await post(hq, '/api/tickets', { id: 'alpha/web' });
    const blocked = await until(hq, (s) => action('website')(s) !== undefined);
    expect(action('website')(blocked)).toMatchObject({ host: 'api.stripe.com', agent: 'nova' });
    expect(fake.prs).toHaveLength(0);
    expect((await post(hq, '/api/actions/allow', { host: 'evil.example' })).status).toBe(400);
    expect((await post(hq, '/api/actions/allow', { host: 'api.stripe.com' })).json).toEqual({
      allowed: 'api.stripe.com',
    });
    await until(hq, (s) => station('alpha/web')(s) === 'merge');
    expect(fake.prs).toHaveLength(1);
    expect(proxy.denies).toBeGreaterThan(0);
    expect(hq.snapshot().actions.filter((a) => a.kind === 'website')).toEqual([]);
  });

  it('with one account, posts the changes verdict as a comment, keeps the fix round, and keeps an approval out of the count', async () => {
    const fake = new FakeGithub();
    const host = github({ send: fake.transport('fiatfour'), log: () => {} });
    const { hq } = await boot({ host });
    await post(hq, '/api/tickets', { id: 'alpha/t2' });
    await until(hq, (s) => fake.reviews.length === 2 && station('alpha/t2')(s) === 'qc');
    expect(fake.reviews.map((r) => r.state)).toEqual(['COMMENTED', 'COMMENTED']);
    expect(fake.reviews[0]?.body).toContain('"changes"');
    expect(hq.snapshot().mode?.rounds['alpha/t2']).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(station('alpha/t2')(hq.snapshot())).toBe('qc');
    expect(fake.issueComments).toEqual([]);
  });

  it('runs the same ticket on GitLab', async () => {
    const fake = new FakeGitlab();
    const calls: ApiCall[] = [];
    const log = (c: ApiCall) => calls.push(c);
    const { hq } = await boot({
      host: gitlab({ send: fake.transport('aw-nova'), log }),
      reviewHost: gitlab({ send: fake.transport('vega'), log }),
    });
    await post(hq, '/api/tickets', { id: 'alpha/t1' });
    await until(hq, (s) => action('ready_to_merge')(s) !== undefined);
    expect(fake.mrs).toHaveLength(1);
    expect(fake.mrs[0]).toMatchObject({ source: 'aw/alpha/t1', author: 'aw-nova' });
    expect(fake.approvals).toEqual([expect.objectContaining({ iid: 1, user: 'vega' })]);
    expect(fake.notes.some((n) => n.body.includes('agent-works:merge-brief'))).toBe(true);
    expect(calls.filter((c) => /merge(?!_requests)/.test(c.path))).toEqual([]);
  });
});

describe.skipIf(!hasSqlite)('a restart during the CODE station', () => {
  const killedAfter = (real: GitHost, method: 'openChange' | 'postReview' | 'postComment') => {
    const state = { dead: false };
    const host = new Proxy(real, {
      get(target, key) {
        const value = target[key as keyof GitHost];
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          if (state.dead) throw new Error('HQ is dead');
          const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (key === method) {
            state.dead = true;
            throw new Error(`HQ was killed after ${method}`);
          }
          return out;
        };
      },
    });
    return { host, state };
  };
  const counted = () => {
    const runs: string[] = [];
    const inner = scripted({ scripts: SCRIPTS });
    const runtime: AgentRuntime = {
      id: 'scripted',
      run: (job) => {
        runs.push(job.role);
        return inner.run(job);
      },
    };
    return { runtime, runs };
  };

  it('resumes the task and opens no second PR when HQ died after the PR opened and before it saw the PR', async () => {
    const { fake, hosts } = twoAccounts();
    const home = tempDir('cages-restart');
    const killed = killedAfter(hosts.host, 'openChange');
    const first = await boot({ home, host: killed.host, reviewHost: hosts.reviewHost });
    await post(first.hq, '/api/tickets', { id: 'alpha/t1' });
    await until(first.hq, () => killed.state.dead);
    await first.hq.close();
    expect(fake.prs).toHaveLength(1);
    const again = counted();
    const second = await boot({ home, ...hosts, runtime: again.runtime });
    await until(second.hq, (s) => station('alpha/t1')(s) === 'merge');
    expect(fake.prs).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.path))).toHaveLength(1);
    expect(again.runs).toEqual(['reviewer']);
  });

  it('posts no second review when HQ died after posting one', async () => {
    const { fake, hosts } = twoAccounts();
    const home = tempDir('cages-restart-review');
    const killed = killedAfter(hosts.reviewHost, 'postReview');
    const first = await boot({ home, host: hosts.host, reviewHost: killed.host });
    await post(first.hq, '/api/tickets', { id: 'alpha/t1' });
    await until(first.hq, () => killed.state.dead);
    await first.hq.close();
    const again = counted();
    const second = await boot({ home, ...hosts, runtime: again.runtime });
    await until(second.hq, (s) => station('alpha/t1')(s) === 'merge');
    expect(fake.reviews).toHaveLength(1);
    expect(again.runs).toEqual([]);
  });

  it('posts no second merge brief when HQ died after posting it', async () => {
    const { fake, hosts } = twoAccounts();
    const home = tempDir('cages-restart-brief');
    const killed = killedAfter(hosts.host, 'postComment');
    const first = await boot({ home, host: killed.host, reviewHost: hosts.reviewHost });
    await post(first.hq, '/api/tickets', { id: 'alpha/t1' });
    await until(first.hq, () => killed.state.dead);
    await first.hq.close();
    const second = await boot({ home, ...hosts });
    await until(second.hq, (s) => action('ready_to_merge')(s) !== undefined);
    expect(fake.issueComments.filter((c) => c.body.includes('agent-works:merge-brief'))).toHaveLength(1);
  });

  it('resumes the task when HQ stopped while the author was still working', async () => {
    const { fake, hosts } = twoAccounts();
    const slow = scripted({ scripts: SCRIPTS, workMs: 400 });
    const home = tempDir('cages-restart-slow');
    const first = await boot({ home, ...hosts, runtime: slow });
    await post(first.hq, '/api/tickets', { id: 'alpha/t1' });
    await until(first.hq, (s) => (s.mode?.jobs ?? []).includes('alpha/t1'));
    await first.hq.close();
    expect(fake.prs).toHaveLength(0);
    const second = await boot({ home, ...hosts, runtime: scripted({ scripts: SCRIPTS }) });
    await until(second.hq, (s) => station('alpha/t1')(s) === 'merge');
    expect(fake.prs).toHaveLength(1);
  });
});
