import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Usage } from '../../server/agents/runtime.ts';
import { scripted } from '../../server/agents/scripted.ts';
import { github } from '../../server/githost/github.ts';
import { cagesMode } from '../../server/modes/cages.ts';
import { FakeGithub } from '../../server/test/fakes/github-api.ts';
import { hasSqlite, tempDir } from '../../server/test/helpers.ts';
import { baselineArm, factoryArm, removedPaths, ticketOf, tokensOf } from '../arms-live.ts';
import { grade } from '../grade.ts';
import { runTask, verifyTask } from '../run.ts';
import { localRunner } from '../runner.ts';
import { prepareTask } from '../workspace.ts';
import { FIXED, GUARDED, makeFixture } from './fixture.ts';

const STREAM = readFileSync(
  fileURLToPath(new URL('../../server/test/fixtures/claude-stream-author.jsonl', import.meta.url)),
  'utf8',
);

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
  return { fx, scratch, prepared };
};

describe.skipIf(process.platform === 'win32')('baseline arm', () => {
  it('runs one Claude Code author session, carries its usage and grades the committed files', async () => {
    const { fx, scratch, prepared } = await verified();
    const seen: string[][] = [];
    const arm = baselineArm(() => ({
      async exec(argv, options) {
        seen.push([...argv]);
        if (argv[0] === 'claude') return { code: 0, out: STREAM, err: '', timedOut: false, ...(options ? {} : {}) };
        if (argv.includes('rev-parse')) return { code: 0, out: 'base\n', err: '', timedOut: false };
        if (argv.includes('--diff-filter=D')) return { code: 0, out: 'old.txt\0', err: '', timedOut: false };
        if (argv.includes('--numstat')) return { code: 0, out: '1\t1\tsrc/slug.js\0', err: '', timedOut: false };
        return { code: 0, out: FIXED, err: '', timedOut: false };
      },
    }));
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ arm: 'baseline', outcome: 'pass', reviewRounds: null });
    expect(row.tokens?.output).toBeGreaterThan(0);
    expect(seen.filter((argv) => argv[0] === 'claude')).toHaveLength(1);
  });

  it('carries the server-side web requests of the session into the arm run', async () => {
    const { fx, prepared } = await verified();
    const stream = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } },
    });
    const arm = baselineArm(() => ({
      async exec(argv) {
        if (argv[0] === 'claude') return { code: 0, out: stream, err: '', timedOut: false };
        if (argv.includes('rev-parse')) return { code: 0, out: 'base\n', err: '', timedOut: false };
        if (argv.includes('--diff-filter=D')) return { code: 0, out: '', err: '', timedOut: false };
        if (argv.includes('--numstat')) return { code: 0, out: '1\t1\tsrc/slug.js\0', err: '', timedOut: false };
        return { code: 0, out: FIXED, err: '', timedOut: false };
      },
    }));
    expect((await arm.run(fx.task, prepared, new AbortController().signal)).webRequests).toBe(2);
  });

  it('carries the files the session deleted, renames included, into the graded change', async () => {
    const { fx, prepared } = await verified();
    const repo = tempDir('bench-cage-repo');
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    for (const [rel, text] of [
      ['old.txt', 'a\n'],
      ['keep.txt', 'b\n'],
    ] as const)
      writeFileSync(join(repo, rel), text);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const arm = baselineArm(() => ({
      async exec(argv) {
        const git2 = argv.slice(argv.indexOf('git') + 1).filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c');
        if (git2[0] === 'diff' && git2.includes('--numstat')) {
          renameSync(join(repo, 'old.txt'), join(repo, 'new.txt'));
          git('add', '-A');
          git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'rename');
        }
        if (argv[0] === 'claude') return { code: 0, out: STREAM, err: '', timedOut: false };
        const ran = spawnSync(argv[0] ?? 'git', argv.slice(1), { cwd: repo, encoding: 'utf8' });
        return { code: ran.status ?? 1, out: ran.stdout, err: ran.stderr, timedOut: false };
      },
    }));
    const run = await arm.run(fx.task, prepared, new AbortController().signal);
    expect(run.deleted).toEqual(['old.txt']);
    expect(run.files.map((f) => f.path)).toEqual(['new.txt']);
  });

  it('keeps the issue text and drops everything that names the project, its issue number or the fix', () => {
    const task = {
      ...makeFixture().task,
      id: 'ufo-214',
      issue: 214,
      body: 'broken, see https://github.com/nuxt/nuxt/issues/25998 and github.com/unjs/ufo/blob/main/x.ts#L3 or https://www.npmjs.com/package/ufo ok',
    };
    const ticket = ticketOf(task);
    expect(ticket).toMatchObject({ kind: 'defect', title: task.title, url: null });
    expect(ticket.body).toBe('broken, see [link removed] and [link removed] or [link removed] ok');
    expect(JSON.stringify(ticket)).not.toMatch(/ufo|214|github|npm/i);
    expect(ticketOf({ ...task, body: '' }).body).toBe(task.title);
    expect(ticketOf({ ...task, id: 'ufo-221' }).id).not.toBe(ticket.id);
  });

  it('adds up every token column of every session, cache reads included', () => {
    const usage = (n: number): Usage => ({
      inputTokens: n,
      outputTokens: 2 * n,
      cacheReadTokens: 3 * n,
      cacheCreationTokens: 4 * n,
      webRequests: n,
    });
    expect(tokensOf([usage(1), null, usage(10)])).toEqual({ input: 11, output: 22, cacheRead: 33, cacheCreation: 44 });
    expect(tokensOf([null])).toBeNull();
  });

  it('reads deletions and rename sources from a pull request file list', () => {
    expect(
      removedPaths([
        { status: 'removed', filename: 'gone.ts' },
        { status: 'renamed', filename: 'new.ts', previous_filename: 'old.ts' },
        { status: 'modified', filename: 'same.ts' },
        { status: 'added', filename: 'fresh.ts' },
      ]),
    ).toEqual(['gone.ts', 'old.ts']);
  });
});

describe.skipIf(!hasSqlite || process.platform === 'win32')('factory arm', () => {
  const open =
    (fake: FakeGithub, reviews: 'approve' | 'changes-then-approve', removed: string[] = [], fix = FIXED) =>
    async (task: { id: string }, ticket: { id: string }) => {
      const send = (account: string) => fake.transport(account);
      const agent = scripted({
        scripts: {
          [ticket.id]: {
            author: [
              { files: [{ path: 'src/slug.js', content: fix }] },
              { files: [{ path: 'src/slug.js', content: `${fix}// tidy\n` }] },
            ],
            reviews:
              reviews === 'approve'
                ? [{ verdict: 'approve', body: 'ok', comments: [] }]
                : [
                    { verdict: 'changes', body: 'tidy', comments: [{ path: 'src/slug.js', line: 1, body: 'tidy' }] },
                    { verdict: 'approve', body: 'ok', comments: [] },
                  ],
          },
        },
      });
      void task;
      const host = github({ repo: 'acme/app', base: 'main', send: send('aw-nova'), log: () => {} });
      return {
        host,
        repo: 'acme/app',
        base: 'main',
        home: tempDir('bench-hq'),
        reviewer: 'vega',
        removed: async () => removed,
        mode: cagesMode({
          host,
          reviewHost: github({ repo: 'acme/app', base: 'main', send: send('vega'), log: () => {} }),
          repo: 'acme/app',
          base: 'main',
          tickets: { [ticket.id]: { ...ticket, kind: 'defect', title: 't', body: 'b', url: null, risk: null } },
          author: 'nova',
          reviewer: 'vega',
          workers: { nova: agent, vega: agent },
          pollMs: 30,
          settleMs: 10,
        }),
      };
    };

  it('drives the real HQ cages mode to a ready PR, counts review rounds and grades the PR head', async () => {
    const { fx, scratch, prepared } = await verified();
    const fake = new FakeGithub();
    const arm = factoryArm({ open: open(fake, 'changes-then-approve') });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ arm: 'factory', outcome: 'pass', reviewRounds: 1 });
    expect(fake.prs).toHaveLength(1);
    expect(fake.calls.filter((c) => /\/merge/.test(c.path))).toEqual([]);
  });

  it('carries the paths the PR removed or renamed away into the change it grades', async () => {
    const { fx, scratch, prepared } = await verified();
    writeFileSync(join(prepared.installed, 'src/stray.txt'), 'x\n');
    const fake = new FakeGithub();
    const without = await runTask(fx.task, 1, prepared, {
      arm: factoryArm({ open: open(fake, 'approve', [], GUARDED) }),
      runner: localRunner,
      scratch,
    });
    const withIt = await runTask(fx.task, 1, prepared, {
      arm: factoryArm({ open: open(new FakeGithub(), 'approve', ['src/stray.txt'], GUARDED) }),
      runner: localRunner,
      scratch,
    });
    expect([without.outcome, withIt.outcome]).toEqual(['fail', 'pass']);
  });

  it('grades the PR head, so a PR that never touches the bug is a fail', async () => {
    const { fx, scratch, prepared } = await verified();
    const fake = new FakeGithub();
    const g = await grade(
      fx.task,
      prepared,
      { files: [{ path: 'README.md', content: 'x\n' }], deleted: [] },
      localRunner,
      scratch,
    );
    expect(g.outcome).toBe('fail');
    expect(fake.prs).toHaveLength(0);
  });
});
