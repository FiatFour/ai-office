import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { type Arm, scriptedArm } from '../arms.ts';
import { grade } from '../grade.ts';
import { parseTask } from '../model.ts';
import { runTask, verifyTask } from '../run.ts';
import { localRunner } from '../runner.ts';
import { gitProblems, prepareTask, sealedProblems } from '../workspace.ts';
import { BUGGY, FIXED, HIDDEN_NEW, makeFixture } from './fixture.ts';

const setup = async (over = {}) => {
  const fx = makeFixture(over);
  const cache = tempDir('bench-cache');
  const scratch = join(cache, 'grading');
  const prepared = await prepareTask(fx.task, {
    cache,
    repoUrl: (repo) => join(fx.reposRoot, `${repo}.git`),
    runner: localRunner,
  });
  return { fx, cache, scratch, prepared };
};

describe('task setup', () => {
  it('builds a cage source at the reverted base without the hidden tests, history or fix commit', async () => {
    const { fx, prepared } = await setup();
    expect(prepared.baseSha).toBe(fx.baseSha);
    expect(existsSync(join(prepared.source, 'test/slug-hidden.test.js'))).toBe(false);
    expect(readFileSync(join(prepared.source, 'src/slug.js'), 'utf8')).toBe(BUGGY);
    expect(readFileSync(join(prepared.source, 'test/basic.test.js'), 'utf8')).not.toContain('tabs');
    expect(sealedProblems(prepared.source, prepared.hidden, fx.task.hiddenPaths)).toEqual([]);
    expect(await gitProblems(prepared.source, fx.fixSha)).toEqual([]);
    expect(readFileSync(join(prepared.hidden, 'test/slug-hidden.test.js'), 'utf8')).toBe(HIDDEN_NEW);
  });

  it('shows the hidden tests fail at the reverted base and pass on the fix', async () => {
    const { fx, scratch, prepared } = await setup();
    const sanity = await verifyTask(fx.task, prepared, localRunner, scratch);
    expect(sanity.failsAtBase).toBe(true);
    const fixed = await grade(fx.task, prepared, [{ path: 'src/slug.js', content: FIXED }], localRunner, scratch);
    expect(fixed.outcome).toBe('pass');
  });

  it('refuses to build a source that holds a hidden test under another name', async () => {
    const fx = makeFixture({ hiddenPaths: ['test/slug-hidden.test.js', 'test/basic.test.js'] }, { duplicate: true });
    const cache = tempDir('bench-cache');
    await expect(
      prepareTask(fx.task, { cache, repoUrl: (r) => join(fx.reposRoot, `${r}.git`), runner: localRunner }),
    ).rejects.toThrow(
      /is not sealed: hidden test test\/slug-hidden.test.js is present in the cage tree as test\/visible.test.js/,
    );
  });

  it('refuses hidden tests that already pass at the base', async () => {
    const { fx, scratch, prepared } = await setup({ testCommand: ['node', '--test', 'test/visible.test.js'] });
    await expect(verifyTask(fx.task, prepared, localRunner, scratch)).rejects.toThrow(
      /do not fail at the reverted base|gave pass/,
    );
  });

  it('refuses a base failure that is not a test failure, such as a crash before any test runs', async () => {
    const { fx, scratch, prepared } = await setup({ testCommand: ['node', '-e', 'process.exit(1)'] });
    await expect(verifyTask(fx.task, prepared, localRunner, scratch)).rejects.toThrow(/not as a test failure/);
  });

  it('reports a cage source that keeps history or can reach the fix commit', async () => {
    const fx = makeFixture();
    const clone = join(tempDir('seal-clone'), 'c');
    execFileSync('git', ['clone', '-q', join(fx.reposRoot, 'acme/proj.git'), clone]);
    expect(await gitProblems(clone, fx.fixSha)).toEqual([
      'the cage source has 2 commits, not 1',
      'the fix commit is reachable from the cage source',
      'the cage source keeps remote or tag refs',
    ]);
  });

  it('reports a cage tree that holds a hidden test, by content, whatever its name', () => {
    const dir = tempDir('seal');
    const hidden = join(dir, 'hidden');
    const tree = join(dir, 'tree');
    for (const root of [hidden, tree]) {
      fs.mkdirSync(join(root, 'test'), { recursive: true });
    }
    fs.writeFileSync(join(hidden, 'test/h.test.js'), 'secret');
    fs.writeFileSync(join(tree, 'test/renamed.js'), 'secret');
    expect(sealedProblems(tree, hidden, ['test/h.test.js'])).toEqual([
      'hidden test test/h.test.js is present in the cage tree as test/renamed.js',
    ]);
  });
});

describe('refusals', () => {
  const base = {
    set: 'A',
    id: 'x',
    repo: 'a/b',
    issue: 1,
    title: 't',
    testCommand: ['true'],
    expect: '.',
    image: 'i',
  };

  it('refuses a task with no hidden-test commit and says why', () => {
    expect(() => parseTask({ ...base, fixSha: 'a'.repeat(40), hiddenPaths: [] }, 'x.json')).toThrow(
      /names no hidden-test commit/,
    );
    expect(() => parseTask({ ...base, fixSha: 'abc', hiddenPaths: ['t.js'] }, 'x.json')).toThrow(
      /names no hidden-test commit/,
    );
  });

  it('refuses a hidden path that escapes the workspace', () => {
    const fix = 'a'.repeat(40);
    expect(() => parseTask({ ...base, fixSha: fix, hiddenPaths: ['../x'] }, 'x.json')).toThrow(
      /not a safe relative path/,
    );
    expect(() => parseTask({ ...base, fixSha: fix, hiddenPaths: ['/etc/passwd'] }, 'x.json')).toThrow(
      /not a safe relative path/,
    );
  });

  it('refuses a hidden path the fix commit does not touch', async () => {
    const fx = makeFixture({ hiddenPaths: ['test/nothing.test.js'] });
    const cache = tempDir('bench-cache');
    await expect(
      prepareTask(fx.task, { cache, repoUrl: (r) => join(fx.reposRoot, `${r}.git`), runner: localRunner }),
    ).rejects.toThrow(/not in the fix commit/);
  });

  it('refuses to run a task whose hidden tests were never checked at the base', async () => {
    const { fx, scratch, prepared } = await setup();
    await expect(
      runTask(fx.task, 1, prepared, { arm: scriptedArm('baseline', {}), runner: localRunner, scratch }),
    ).rejects.toThrow(/never verified/);
  });
});

describe('rows', () => {
  const verified = async (over = {}) => {
    const s = await setup(over);
    await verifyTask(s.fx.task, s.prepared, localRunner, s.scratch);
    return s;
  };

  it('records pass with every column filled when the PR fixes the bug', async () => {
    const { fx, scratch, prepared } = await verified();
    const tokens = { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 };
    const arm = scriptedArm('factory', {
      'slug-1': { files: [{ path: 'src/slug.js', content: FIXED }], reviewRounds: 2, tokens },
    });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({
      task: 'slug-1',
      set: 'A',
      arm: 'factory',
      run: 1,
      outcome: 'pass',
      reviewRounds: 2,
      tokens,
    });
    expect(row.wallMs).toBeGreaterThanOrEqual(row.agentMs);
  });

  it('records fail when the PR does not fix the bug', async () => {
    const { fx, scratch, prepared } = await verified();
    const arm = scriptedArm('factory', { 'slug-1': { files: [{ path: 'README.md', content: 'unrelated\n' }] } });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row.outcome).toBe('fail');
  });

  it('cannot be passed by overwriting a hidden test', async () => {
    const { fx, scratch, prepared } = await verified();
    const arm = scriptedArm('factory', {
      'slug-1': {
        files: [{ path: 'test/slug-hidden.test.js', content: `import {test} from 'node:test';test('x',()=>{});\n` }],
      },
    });
    expect((await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch })).outcome).toBe('fail');
  });

  it('cannot be passed by a test command that exits 0 without running a test', async () => {
    const { fx, scratch, prepared } = await verified();
    const empty = { ...fx.task, testCommand: ['true'] };
    const g = await grade(empty, prepared, [], localRunner, scratch);
    expect(g).toMatchObject({ outcome: 'fail' });
    expect(g.note).toMatch(/lacks/);
  });

  it('refuses a PR file that leaves the workspace', async () => {
    const { fx, scratch, prepared } = await verified();
    await expect(
      grade(fx.task, prepared, [{ path: '../escape.txt', content: 'x' }], localRunner, scratch),
    ).rejects.toThrow(/leaves the workspace/);
  });

  it('records timeout, not pass, for a run past the limit, even when the arm ignores the abort signal', async () => {
    const { fx, scratch, prepared } = await verified({ timeoutMs: 150 });
    const hang = scriptedArm('factory', { 'slug-1': { files: [], hang: true } });
    const stubborn: Arm = { name: 'baseline', run: () => new Promise(() => {}) };
    for (const arm of [hang, stubborn]) {
      const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
      expect(row.outcome).toBe('timeout');
      expect(row.wallMs).toBeLessThan(5000);
    }
  });

  it('records error when the arm throws', async () => {
    const { fx, scratch, prepared } = await verified();
    const arm = scriptedArm('factory', { 'slug-1': { files: [], fail: 'job failed: boom' } });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ outcome: 'error', note: 'job failed: boom' });
  });

  it('records a timeout when the hidden tests themselves run too long', async () => {
    const { fx, scratch, prepared } = await verified();
    const slow = { ...fx.task, testCommand: ['sleep', '5'], timeoutMs: 200 };
    expect((await grade(slow, prepared, [], localRunner, scratch)).outcome).toBe('timeout');
  });
});
