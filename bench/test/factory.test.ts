import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../../server/agents/runtime.ts';
import { scripted } from '../../server/agents/scripted.ts';
import type { ChangeSnapshot, HttpRequest, ReviewFact } from '../../server/githost/host.ts';
import { FakeGithub } from '../../server/test/fakes/github-api.ts';
import { hasSqlite, tempDir } from '../../server/test/helpers.ts';
import { baselineArm, type FactoryEnv, factoryArm, removedVia, reviewSettled, ticketOf } from '../arms-live.ts';
import { type TaskA, TaskRefused } from '../model.ts';
import { checks, readRows, renderReport } from '../report.ts';
import { appendRow, runTask, verifyTask } from '../run.ts';
import { localRunner } from '../runner.ts';
import {
  AUTHOR,
  cleanupProblem,
  dropBase,
  failFast,
  namesOf,
  REVIEWER,
  scratchEnv,
  scratchRepoProblem,
  seedBase,
} from '../scratch.ts';
import { prepareTask } from '../workspace.ts';
import { FIXED, makeFixture } from './fixture.ts';

const REPO = 'acme/app-scratch';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  }).trim();

const bare = (): string => {
  const dir = tempDir('scratch-bare');
  execFileSync('git', ['init', '-q', '--bare', dir]);
  return dir;
};

const gitOf = (dir: string, ...args: string[]) =>
  execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const verified = async () => {
  const fx = makeFixture();
  const cache = tempDir('bench-cache');
  const scratch = join(cache, 'grading');
  const prepared = await prepareTask(fx.task, {
    cache,
    repoUrl: (repo) => join(fx.reposRoot, `${repo}.git`),
    runner: localRunner,
  });
  await verifyTask(fx.task, prepared, localRunner, scratch);
  return { fx, scratch, prepared, cache };
};

const withActions = (source: string) => {
  mkdirSync(join(source, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(source, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
  writeFileSync(join(source, '.github', 'dependabot.yml'), 'version: 2\n');
  git(source, 'add', '-A', '-f');
  git(source, 'commit', '-q', '--amend', '--no-edit');
};

describe.skipIf(process.platform === 'win32')('seeding the scratch host', () => {
  it('pushes one orphan commit of the sealed tree and nothing that starts Actions, names the fix or holds a hidden test', async () => {
    const { fx, prepared, cache } = await verified();
    withActions(prepared.source);
    const remote = bare();
    const seed = await seedBase(prepared.source, remote, 'bench-base/t-0a1b2c3d', join(cache, 'scratch'));
    expect(seed.branch).toBe('bench-base/t-0a1b2c3d');
    expect(gitOf(remote, 'rev-parse', seed.branch)).toBe(seed.sha);
    const files = gitOf(remote, 'ls-tree', '-r', '--name-only', seed.branch).split('\n');
    expect(files.filter((f) => f.startsWith('.github'))).toEqual([]);
    expect(files).toContain('src/slug.js');
    expect(files).not.toContain('test/slug-hidden.test.js');
    expect(gitOf(remote, 'rev-list', '--all', '--count')).toBe('1');
    expect(gitOf(remote, 'rev-list', '--parents', '-n', '1', seed.branch).split(' ')).toHaveLength(1);
    expect(() => gitOf(remote, 'cat-file', '-e', `${fx.fixSha}^{commit}`)).toThrow();
    expect(() => gitOf(remote, 'cat-file', '-e', `${fx.baseSha}^{commit}`)).toThrow();
    expect(gitOf(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/bench-base/t-0a1b2c3d');
  });

  it('writes only bench base refs and drops them again, twice without error', async () => {
    const { prepared, cache } = await verified();
    const remote = bare();
    const work = join(cache, 'scratch');
    await expect(seedBase(prepared.source, remote, 'main', work)).rejects.toThrow(TaskRefused);
    await expect(dropBase(remote, 'main', work)).rejects.toThrow(TaskRefused);
    await seedBase(prepared.source, remote, 'bench-base/t-0a1b2c3d', work);
    await dropBase(remote, 'bench-base/t-0a1b2c3d', work);
    await dropBase(remote, 'bench-base/t-0a1b2c3d', work);
    expect(gitOf(remote, 'for-each-ref')).toBe('');
  });

  it('reseeds a branch a crashed run left behind', async () => {
    const { prepared, cache } = await verified();
    const remote = bare();
    const work = join(cache, 'scratch');
    const first = await seedBase(prepared.source, remote, 'bench-base/t-0a1b2c3d', work);
    writeFileSync(join(prepared.source, 'src', 'extra.js'), 'export {};\n');
    git(prepared.source, 'add', '-A');
    git(prepared.source, 'commit', '-q', '--amend', '--no-edit');
    const second = await seedBase(prepared.source, remote, 'bench-base/t-0a1b2c3d', work);
    expect(second.sha).not.toBe(first.sha);
    expect(gitOf(remote, 'rev-parse', 'bench-base/t-0a1b2c3d')).toBe(second.sha);
  });
});

describe('what the cleanup may touch on the host', () => {
  const call = (method: HttpRequest['method'], path: string, body?: unknown): HttpRequest =>
    body === undefined ? { method, path } : { method, path, body };
  const home = `/repos/${REPO}`;

  it('closes a PR and deletes a bench work branch and refuses everything else', () => {
    expect(cleanupProblem(call('PATCH', `${home}/pulls/7`, { state: 'closed' }), REPO)).toBeNull();
    expect(cleanupProblem(call('DELETE', `${home}/git/refs/heads/aw/bench/t-0a1b2c3d`), REPO)).toBeNull();
    expect(cleanupProblem(call('GET', `${home}/pulls?state=open`), REPO)).toBeNull();
    for (const bad of [
      call('DELETE', `${home}/git/refs/heads/main`),
      call('DELETE', `${home}/git/refs/heads/aw/alpha/t1`),
      call('DELETE', `${home}/git/refs/heads/bench-base/t-0a1b2c3d`),
      call('PATCH', `${home}/pulls/7`, { state: 'open' }),
      call('PATCH', `${home}/pulls/7`, { state: 'closed', title: 'x' }),
      call('PUT', `${home}/pulls/7/merge`),
      call('POST', `${home}/pulls/7/merge`),
      call('DELETE', '/repos/acme/other-scratch/git/refs/heads/aw/bench/t-0a1b2c3d'),
    ])
      expect(cleanupProblem(bad, REPO), `${bad.method} ${bad.path}`).not.toBeNull();
  });

  it('accepts a scratch repo by its name and refuses a repo that is not one', () => {
    expect(scratchRepoProblem('FiatFour/agent-works-scratch')).toBeNull();
    for (const repo of ['FiatFour/ai-office', 'FiatFour/agent-works', 'ai-office', 'a/b-scratch/c'])
      expect(scratchRepoProblem(repo), repo).not.toBeNull();
  });

  it('names the base and the work branch from the ticket id and nothing else', () => {
    expect(namesOf('bench/t-0a1b2c3d')).toEqual({ base: 'bench-base/t-0a1b2c3d', work: 'aw/bench/t-0a1b2c3d' });
  });
});

describe('a failed session', () => {
  it('is remembered, and no later session starts on any worker', async () => {
    let started = 0;
    const flaky: AgentRuntime = {
      id: 'scripted',
      async run() {
        started += 1;
        throw new Error('login expired');
      },
    };
    const crew = failFast({ nova: flaky, vega: flaky });
    const job = { role: 'author' } as unknown as Parameters<AgentRuntime['run']>[0];
    expect(crew.failure()).toBeNull();
    await expect(crew.workers.nova?.run(job)).rejects.toThrow('login expired');
    await expect(crew.workers.vega?.run(job)).rejects.toThrow('an earlier session failed: login expired');
    expect(started).toBe(1);
    expect(crew.failure()).toBe('login expired');
  });
});

describe('the settled review', () => {
  const snap = (headSha: string, reviews: Array<Partial<ReviewFact> & { mark?: string }>): ChangeSnapshot =>
    ({
      change: { headSha },
      checks: [],
      reviews: reviews.map(({ mark, ...r }) => ({
        kind: 'review',
        commitId: headSha,
        body: `ok\n\n<!-- agent-works:review worker=${REVIEWER} verdict=${mark ?? 'approve'} -->`,
        ...r,
      })),
    }) as unknown as ChangeSnapshot;

  it('needs a review of the current head by the reviewer that asks for no change', () => {
    expect(reviewSettled(snap('h2', [{}]), REVIEWER)).toBe(true);
    expect(reviewSettled(snap('h2', [{ mark: 'comment' }]), REVIEWER)).toBe(true);
    expect(reviewSettled(snap('h2', []), REVIEWER)).toBe(false);
  });

  it('does not count a stale head, a request for changes or another worker', () => {
    expect(reviewSettled(snap('h2', [{ commitId: 'h1' }]), REVIEWER)).toBe(false);
    expect(reviewSettled(snap('h2', [{ mark: 'changes' }]), REVIEWER)).toBe(false);
    expect(
      reviewSettled(snap('h2', [{ body: '<!-- agent-works:review worker=other verdict=approve -->' }]), REVIEWER),
    ).toBe(false);
  });
});

describe('the files a PR removed', () => {
  it('pages through the host listing and reads deletions and rename sources', async () => {
    const pages: Record<string, unknown[]> = {
      '1': Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'modified' })),
      '2': [
        { filename: 'gone.ts', status: 'removed' },
        { filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed' },
      ],
    };
    const seen: string[] = [];
    const removed = await removedVia(
      async ({ path }) => {
        seen.push(path);
        return { status: 200, body: pages[/[?&]page=(\d+)/.exec(path)?.[1] ?? ''] ?? [] };
      },
      REPO,
      9,
    );
    expect(removed).toEqual(['gone.ts', 'old.ts']);
    expect(seen).toHaveLength(2);
    await expect(removedVia(async () => ({ status: 403, body: {} }), REPO, 9)).rejects.toThrow('status 403');
  });
});

describe.skipIf(!hasSqlite || process.platform === 'win32')('the factory arm on a local bare repo', () => {
  const FIX2 = `${FIXED}// tidy\n`;

  const usageOf = (runtime: AgentRuntime): AgentRuntime => ({
    id: runtime.id,
    async run(job) {
      const result = await runtime.run(job);
      return {
        ...result,
        usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 1000, webRequests: 0 },
      };
    },
  });

  const setup = (over: { script?: 'changes-then-approve' | 'approve'; fail?: boolean; keep?: boolean } = {}) => {
    const fake = new FakeGithub(REPO);
    const remote = bare();
    const log: string[] = [];
    const send = fake.transport('aw-nova');
    const make = (ticketId: string): AgentRuntime =>
      usageOf(
        over.fail === true
          ? { id: 'scripted', run: async () => Promise.reject(new Error('the agent crashed')) }
          : scripted({
              scripts: {
                [ticketId]: {
                  author: [
                    { files: [{ path: 'src/slug.js', content: FIXED }] },
                    { files: [{ path: 'src/slug.js', content: FIX2 }] },
                  ],
                  reviews:
                    over.script === 'approve'
                      ? [{ verdict: 'approve', body: 'ok', comments: [] }]
                      : [
                          {
                            verdict: 'changes',
                            body: 'tidy',
                            comments: [{ path: 'src/slug.js', line: 1, body: 'tidy' }],
                          },
                          { verdict: 'approve', body: 'ok', comments: [] },
                        ],
                },
              },
            }),
      );
    const env = (task: TaskA, workRoot: string): FactoryEnv => {
      const inner = scratchEnv({
        repo: REPO,
        remote,
        send,
        log: (call) => log.push(`${call.method} ${call.path}`),
        workers: () => {
          const runtime = make(ticketOf(task as TaskA).id);
          return { [AUTHOR]: runtime, [REVIEWER]: runtime };
        },
        workRoot,
        pollMs: 30,
        settleMs: 10,
        reviewPollMs: 30,
        ...(over.keep === true ? { keep: true } : {}),
      });
      return {
        ...inner,
        async open(t, ticket, prepared) {
          const handle = await inner.open(t, ticket, prepared);
          const files = gitOf(remote, 'ls-tree', '-r', '--name-only', handle.base).split('\n');
          fake.commitOn(
            handle.base,
            Object.fromEntries(files.map((f) => [f, gitOf(remote, 'show', `${handle.base}:${f}`)])),
          );
          return handle;
        },
      };
    };
    return { fake, remote, log, env };
  };

  it('runs the crew on a seeded base, grades the PR head, counts rounds and tokens, and cleans up', async () => {
    const { fx, scratch, prepared, cache } = await verified();
    const { fake, remote, log, env } = setup();
    const row = await runTask(fx.task, 1, prepared, {
      arm: factoryArm(env(fx.task, join(cache, 'scratch'))),
      runner: localRunner,
      scratch,
    });
    expect(row).toMatchObject({
      task: 'slug-1',
      set: 'A',
      arm: 'factory',
      scripted: false,
      outcome: 'pass',
      reviewRounds: 1,
      flag: null,
      tokens: { input: 4, output: 40, cacheRead: 400, cacheCreation: 4000 },
    });
    expect(row.wallMs).toBeGreaterThan(0);
    expect(row.note).toContain('PR #1 head reviewed with no change requested');
    expect(fake.prs.map((p) => p.state)).toEqual(['closed']);
    expect(fake.refs.has(`aw/${ticketOf(fx.task).id}`)).toBe(false);
    expect(gitOf(remote, 'for-each-ref')).toBe('');
    expect(log.some((line) => /\/merge/.test(line))).toBe(false);
    expect(fake.calls.some((c) => /\/merge/.test(c.path))).toBe(false);
  });

  it('leaves the PR and the branches for inspection when asked to keep them', async () => {
    const { fx, scratch, prepared, cache } = await verified();
    const { fake, remote, env } = setup({ script: 'approve', keep: true });
    const row = await runTask(fx.task, 1, prepared, {
      arm: factoryArm(env(fx.task, join(cache, 'scratch'))),
      runner: localRunner,
      scratch,
    });
    expect(row).toMatchObject({ outcome: 'pass', reviewRounds: 0 });
    expect(fake.prs.map((p) => p.state)).toEqual(['open']);
    expect(gitOf(remote, 'for-each-ref', '--format=%(refname)')).toBe(
      `refs/heads/${namesOf(ticketOf(fx.task).id).base}`,
    );
  });

  it('clears a PR and a branch a crashed run left, then opens a fresh PR', async () => {
    const { fx, scratch, prepared, cache } = await verified();
    const { fake, env } = setup({ script: 'approve' });
    const names = namesOf(ticketOf(fx.task).id);
    fake.commitOn(names.work, { 'src/slug.js': 'export const slug = () => "stale";\n' });
    await fake.transport('aw-nova')({
      method: 'POST',
      path: `/repos/${REPO}/pulls`,
      body: { title: 'stale', body: 'b', head: names.work, base: 'main', draft: false },
    });
    const row = await runTask(fx.task, 1, prepared, {
      arm: factoryArm(env(fx.task, join(cache, 'scratch'))),
      runner: localRunner,
      scratch,
    });
    expect(row.outcome).toBe('pass');
    expect(fake.prs.map((p) => p.state)).toEqual(['closed', 'closed']);
    expect(fake.prs[1]?.title).not.toBe('stale');
  });

  it('cleans up and records an error row when the crew fails', async () => {
    const { fx, scratch, prepared, cache } = await verified();
    const { fake, remote, env } = setup({ fail: true });
    const row = await runTask(fx.task, 1, prepared, {
      arm: factoryArm(env(fx.task, join(cache, 'scratch'))),
      runner: localRunner,
      scratch,
    });
    expect(row.outcome).toBe('error');
    expect(row.note).toContain('a session failed, no retry: the agent crashed');
    expect(gitOf(remote, 'for-each-ref')).toBe('');
    expect(fake.prs.filter((p) => p.state === 'open')).toEqual([]);
  });

  it('writes rows of the baseline shape that the report compares with the baseline arm on the same task', async () => {
    const { fx, scratch, prepared, cache } = await verified();
    const { env } = setup();
    const out = join(tempDir('bench-out'), 'rows.jsonl');
    const ok = (out: string) => ({ code: 0, out, err: '', timedOut: false });
    const stream = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: { input_tokens: 2, output_tokens: 5 },
    });
    const baseline = await runTask(fx.task, 1, prepared, {
      arm: baselineArm(() => ({
        async exec(argv) {
          if (argv[0] === 'claude') return ok(stream);
          if (argv.includes('rev-parse')) return ok('base\n');
          if (argv.includes('--diff-filter=D')) return ok('');
          if (argv.includes('--numstat')) return ok('1\t1\tsrc/slug.js\0');
          return ok(FIXED);
        },
      })),
      runner: localRunner,
      scratch,
    });
    const factory = await runTask(fx.task, 1, prepared, {
      arm: factoryArm(env(fx.task, join(cache, 'scratch'))),
      runner: localRunner,
      scratch,
    });
    appendRow(out, baseline);
    appendRow(out, factory);
    const rows = readRows(out);
    expect(Object.keys(rows[1] ?? {}).sort()).toEqual(Object.keys(rows[0] ?? {}).sort());
    expect(rows.map((r) => [r.arm, r.scripted, r.outcome])).toEqual([
      ['baseline', false, 'pass'],
      ['factory', false, 'pass'],
    ]);
    const report = renderReport(rows, '2026-11-19');
    expect(report).toContain('| slug-1 |');
    expect(checks(rows).find((c) => c.name === 'Set A hidden-test pass rate')?.value).toBe(
      'factory 1 of 1 (100%); baseline 1 of 1 (100%)',
    );
    if (process.env.AW_DRYRUN_OUT !== undefined) {
      mkdirSync(process.env.AW_DRYRUN_OUT, { recursive: true });
      copyFileSync(out, join(process.env.AW_DRYRUN_OUT, 'rows.jsonl'));
      writeFileSync(join(process.env.AW_DRYRUN_OUT, 'report.md'), report);
    }
    expect(existsSync(out) && readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
