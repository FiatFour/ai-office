import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { type Arm, scriptedArm } from '../arms.ts';
import { grade, NO_CHANGE } from '../grade.ts';
import { parseTask } from '../model.ts';
import { runTask, verifyTask } from '../run.ts';
import { localRunner, type Runner } from '../runner.ts';
import { fixChange, gitProblems, mirrorPath, prepareTask, sealedProblems } from '../workspace.ts';
import { BUGGY, FIXED, HIDDEN_NEW, makeFixture } from './fixture.ts';

const POSIX_ONLY = process.platform === 'win32';

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

describe.skipIf(POSIX_ONLY)('task setup', () => {
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

  it('strips the upstream links from the package metadata of the cage source and the installed copy', async () => {
    const { prepared } = await setup();
    for (const dir of [prepared.source, prepared.installed]) {
      const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      expect(meta).toEqual({ name: 'slug', version: '1.0.0', type: 'module' });
    }
  });

  it('refuses an install that leaves a newer copy of the project itself in node_modules', async () => {
    const fx = makeFixture({
      installCommand: ['sh', '-c', 'mkdir -p node_modules/.pnpm/slug@9.0.0 && mkdir -p node_modules/.pnpm/slug@0.5.0'],
    });
    await expect(
      prepareTask(fx.task, {
        cache: tempDir('bench-cache'),
        repoUrl: (r) => join(fx.reposRoot, `${r}.git`),
        runner: localRunner,
      }),
    ).rejects.toThrow(/is not sealed: node_modules\/\.pnpm\/slug@9\.0\.0 is 9\.0\.0, newer than the base 1\.0\.0/);
  });

  it('reports a tag ref and nothing else when the cage source is one commit with a tag', async () => {
    const dir = tempDir('seal-tag');
    execFileSync('sh', [
      '-c',
      `cd ${dir} && git init -q -b main && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m one && git tag v1`,
    ]);
    expect(await gitProblems(dir, 'a'.repeat(40))).toEqual(['the cage source keeps remote or tag refs']);
  });

  it('turns the upstream fix into a change that leaves out hidden tests and protected paths', async () => {
    const { fx, cache } = await setup();
    const change = await fixChange(fx.task, mirrorPath(cache, fx.task.repo));
    expect(change.files.map((f) => f.path)).toEqual(['src/slug.js']);
    expect(change.deleted).toEqual([]);
  });

  it('leaves out a test file the fix changed that is not hidden, since the grader restores it from the base', async () => {
    const { fx, cache } = await setup({
      hiddenPaths: ['test/slug-hidden.test.js'],
      specs: ['test/slug-hidden.test.js'],
    });
    const change = await fixChange(fx.task, mirrorPath(cache, fx.task.repo));
    expect(change.files.map((f) => f.path)).toEqual(['src/slug.js']);
  });

  it('shows the hidden tests fail at the reverted base and pass on the fix', async () => {
    const { fx, scratch, prepared } = await setup();
    const sanity = await verifyTask(fx.task, prepared, localRunner, scratch);
    expect(sanity.failsAtBase).toBe(true);
    const fixed = await grade(
      fx.task,
      prepared,
      { files: [{ path: 'src/slug.js', content: FIXED }], deleted: [] },
      localRunner,
      scratch,
    );
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

  it('records the passing-test count of the upstream fix, and refuses a task whose own fix does not grade pass', async () => {
    const { fx, scratch, prepared } = await setup();
    await verifyTask(fx.task, prepared, localRunner, scratch);
    const { fixPassed } = JSON.parse(readFileSync(join(prepared.dir, 'verified.json'), 'utf8')) as {
      fixPassed: number;
    };
    expect(fixPassed).toBe(4);
    let calls = 0;
    const brokenFix: Runner = {
      run: (spec) =>
        calls++ === 0 ? localRunner.run(spec) : Promise.resolve({ code: 1, out: '', err: 'boom', timedOut: false }),
    };
    await expect(verifyTask(fx.task, prepared, brokenFix, scratch)).rejects.toThrow(/the upstream fix grades fail/);
  });

  it('refuses a run on a task verified by a harness that did not record the count', async () => {
    const { fx, scratch, prepared } = await setup();
    fs.writeFileSync(join(prepared.dir, 'verified.json'), JSON.stringify({ prepareMs: 1 }));
    const arm = scriptedArm('baseline', { [fx.task.id]: { files: [] } });
    await expect(runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch })).rejects.toThrow(
      /rerun prepare to record the test count/,
    );
  });

  it('refuses hidden tests that already pass at the base', async () => {
    const { fx, scratch, prepared } = await setup();
    const passing: Runner = {
      async run(spec) {
        const files = fx.task.hiddenPaths.map((file) => ({ file: join(spec.cwd, file), passed: 1, failed: 0 }));
        fs.writeFileSync(join(spec.cwd, '.aw-bench/result.json'), JSON.stringify({ files }));
        return { code: 0, out: '', err: '', timedOut: false };
      },
    };
    await expect(verifyTask(fx.task, prepared, passing, scratch)).rejects.toThrow(/gave pass/);
  });

  it('refuses hidden tests that never run at the base', async () => {
    const { fx, scratch, prepared } = await setup({ testCommand: ['node', '--test', 'test/visible.test.js'] });
    await expect(verifyTask(fx.task, prepared, localRunner, scratch)).rejects.toThrow(/not as a test failure/);
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

describe.skipIf(POSIX_ONLY)('refusals', () => {
  const base = {
    set: 'A',
    id: 'x',
    repo: 'a/b',
    issue: 1,
    title: 't',
    testCommand: ['true'],
    specs: ['t.js'],
    reporter: 'vitest',
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

describe.skipIf(POSIX_ONLY)('rows', () => {
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

  it('cannot be passed by a test command that exits 0 without a structured report', async () => {
    const { fx, scratch, prepared } = await verified();
    for (const testCommand of [['true'], ['node', '-e', 'console.log("Tests 1 passed (1)\\n# pass 1")']]) {
      const g = await grade({ ...fx.task, testCommand }, prepared, NO_CHANGE, localRunner, scratch);
      expect(g).toMatchObject({ outcome: 'fail', specs: null });
      expect(g.note).toMatch(/no structured test report/);
    }
  });

  it('fails a PR file that leaves the workspace without writing it', async () => {
    const { fx, scratch, prepared } = await verified();
    const g = await grade(
      fx.task,
      prepared,
      { files: [{ path: '../escape.txt', content: 'x' }], deleted: [] },
      localRunner,
      scratch,
    );
    expect(g).toMatchObject({ outcome: 'fail' });
    expect(g.note).toMatch(/leaves the workspace/);
    expect(existsSync(join(scratch, '..', 'escape.txt'))).toBe(false);
  });

  it('records timeout, not pass, for a run past the limit, even when the arm ignores the abort signal', async () => {
    const { fx: base, scratch, prepared } = await verified();
    const fx = { ...base, task: { ...base.task, timeoutMs: 150 } };
    const hang = scriptedArm('factory', { 'slug-1': { files: [], hang: true } });
    const stubborn: Arm = { name: 'baseline', scripted: false, run: () => new Promise(() => {}) };
    for (const arm of [hang, stubborn]) {
      const row = await Promise.race([
        runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch, settleMs: 200 }),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
      ]);
      expect(row).not.toBe('hung');
      expect(row).toMatchObject({ outcome: 'timeout' });
      expect((row as { wallMs: number }).wallMs).toBeLessThan(2500);
    }
  });

  it('records error when the arm throws', async () => {
    const { fx, scratch, prepared } = await verified();
    const arm = scriptedArm('factory', { 'slug-1': { files: [], fail: 'job failed: boom' } });
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch });
    expect(row).toMatchObject({ outcome: 'error', note: 'job failed: boom' });
  });

  it('keeps the tail of a long failure in the row note and the whole message in the run log', async () => {
    const { fx, scratch, prepared } = await verified();
    const message = `${'opening prose '.repeat(60)}MALFORMED-VERDICT-AT-THE-END`;
    const arm = scriptedArm('factory', { 'slug-1': { files: [], fail: message } });
    const logged: string[] = [];
    const row = await runTask(fx.task, 1, prepared, { arm, runner: localRunner, scratch, log: (l) => logged.push(l) });
    expect(row.outcome).toBe('error');
    expect(row.note.length).toBeLessThanOrEqual(300);
    expect(row.note.endsWith('MALFORMED-VERDICT-AT-THE-END')).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(message);
  });

  it('records a timeout when the hidden tests themselves run too long', async () => {
    const { fx, scratch, prepared } = await verified();
    const slow = { ...fx.task, testCommand: ['node', '-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 200 };
    expect((await grade(slow, prepared, NO_CHANGE, localRunner, scratch)).outcome).toBe('timeout');
  });
});
