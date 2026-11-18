import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scripted } from '../../server/agents/scripted.ts';
import { github } from '../../server/githost/github.ts';
import { cagesMode } from '../../server/modes/cages.ts';
import { FakeGithub } from '../../server/test/fakes/github-api.ts';
import { hasSqlite, tempDir } from '../../server/test/helpers.ts';
import { baselineArm, factoryArm, ticketOf } from '../arms-live.ts';
import { grade } from '../grade.ts';
import { runTask, verifyTask } from '../run.ts';
import { localRunner } from '../runner.ts';
import { prepareTask } from '../workspace.ts';
import { FIXED, makeFixture } from './fixture.ts';

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
        if (argv.includes('--numstat')) return { code: 0, out: '1\t1\tsrc/slug.js\0', err: '', timedOut: false };
        return { code: 0, out: FIXED, err: '', timedOut: false };
      },
    }));
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ arm: 'baseline', outcome: 'pass', reviewRounds: null });
    expect(row.tokens?.output).toBeGreaterThan(0);
    expect(seen.filter((argv) => argv[0] === 'claude')).toHaveLength(1);
  });

  it('puts the issue text, not the fix, in the ticket', () => {
    const { task } = makeFixture();
    expect(ticketOf(task)).toMatchObject({ id: 'bench/slug-1', kind: 'defect', title: task.title, body: task.body });
  });
});

describe.skipIf(!hasSqlite || process.platform === 'win32')('factory arm', () => {
  const open =
    (fake: FakeGithub, reviews: 'approve' | 'changes-then-approve') =>
    async (task: { id: string }, ticket: { id: string }) => {
      const send = (account: string) => fake.transport(account);
      const agent = scripted({
        scripts: {
          [ticket.id]: {
            author: [
              { files: [{ path: 'src/slug.js', content: FIXED }] },
              { files: [{ path: 'src/slug.js', content: `${FIXED}// tidy\n` }] },
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

  it('grades the PR head, so a PR that never touches the bug is a fail', async () => {
    const { fx, scratch, prepared } = await verified();
    const fake = new FakeGithub();
    const g = await grade(fx.task, prepared, [{ path: 'README.md', content: 'x\n' }], localRunner, scratch);
    expect(g.outcome).toBe('fail');
    expect(fake.prs).toHaveLength(0);
  });
});
