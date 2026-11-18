import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { type Script, scriptedArm } from '../arms.ts';
import { grade, NO_CHANGE, parseSpecs } from '../grade.ts';
import type { Change } from '../model.ts';
import { runTask, verifyTask } from '../run.ts';
import { localRunner, type Runner } from '../runner.ts';
import { installedProblems, neutralisePackage } from '../workspace.ts';
import { FIXED, prepareFixture } from './fixture.ts';

const POSIX_ONLY = process.platform === 'win32';
const HACK = fileURLToPath(new URL('./hack.json', import.meta.url));

const spec = (cwd: string, rel: string, passed: number, failed: number) => ({ file: join(cwd, rel), passed, failed });

const reportingRunner = (counts: (cwd: string, hidden: readonly string[]) => unknown[], code = 0): Runner => ({
  async run({ cwd }) {
    const hidden = ['test/slug-hidden.test.js', 'test/basic.test.js'];
    writeFileSync(join(cwd, '.aw-bench/result.json'), JSON.stringify({ files: counts(cwd, hidden) }));
    return { code, out: '', err: '', timedOut: false };
  },
});

const FAKE_RUNNER = (outcome: 'fail' | 'pass') => `#!/bin/sh
cat > .aw-bench/result.json <<'JSON'
{"testResults":[{"name":"/work/test/slug-hidden.test.js","status":"${outcome === 'pass' ? 'passed' : 'failed'}","assertionResults":[{"status":"${outcome === 'pass' ? 'passed' : 'failed'}"}]}]}
JSON
exit ${outcome === 'pass' ? 0 : 1}
`;

const withRunnerBinary = async () => {
  const s = await prepareFixture({
    reporter: 'vitest',
    hiddenPaths: ['test/slug-hidden.test.js'],
    specs: ['test/slug-hidden.test.js'],
    testCommand: ['sh', 'node_modules/.bin/vitest'],
  });
  const bin = join(s.prepared.installed, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'vitest'), FAKE_RUNNER('fail'));
  chmodSync(join(bin, 'vitest'), 0o755);
  await verifyTask(s.fx.task, s.prepared, localRunner, s.scratch);
  return s;
};

describe.skipIf(POSIX_ONLY)('the answer stays out of the grader, channel by channel', () => {
  it('refuses the verifier hack that replaces the test runner binary, and does not run it', async () => {
    const { fx, prepared, scratch } = await withRunnerBinary();
    const hack = (JSON.parse(readFileSync(HACK, 'utf8')) as Record<string, Script>)['ufo-214'] as Script;
    const row = await runTask(fx.task, 1, prepared, {
      arm: scriptedArm('factory', { [fx.task.id]: hack }),
      runner: localRunner,
      scratch,
    });
    expect(row.outcome).toBe('fail');
    expect(row.note).toMatch(/the PR is refused: node_modules\/\.bin\/vitest/);
  });

  it('refuses a forged runner that would report a pass, so a clean fix is the only pass', async () => {
    const { fx, prepared, scratch } = await withRunnerBinary();
    const forged: Change = { files: [{ path: 'node_modules/.bin/vitest', content: FAKE_RUNNER('pass') }], deleted: [] };
    expect((await grade(fx.task, prepared, forged, localRunner, scratch)).outcome).toBe('fail');
    const forgedReport: Change = {
      files: [{ path: '.aw-bench/result.json', content: '{"testResults":[]}' }],
      deleted: [],
    };
    expect((await grade(fx.task, prepared, forgedReport, localRunner, scratch)).note).toMatch(/refused/);
  });

  it.each([
    'node_modules/.bin/vitest',
    'Node_Modules/x/index.js',
    'packages/a/node_modules/b.js',
    'package.json',
    './package.json',
    'sub\\package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'packages/a/vitest.workspace.ts',
    'vite.config.mjs',
    'jest.config.js',
    'tsconfig.json',
    'tsconfig.build.json',
    '.npmrc',
    '.env.local',
    '.aw-bench/node-json.mjs',
    '.pnpm-store/v3/x',
  ])('refuses the PR path %s, written or deleted', async (path) => {
    const { fx, prepared, scratch } = await prepareFixture();
    for (const change of [
      { files: [{ path, content: 'x' }], deleted: [] },
      { files: [], deleted: [path] },
    ]) {
      const g = await grade(fx.task, prepared, change, localRunner, scratch);
      expect(g).toMatchObject({ outcome: 'fail', specs: null });
      expect(g.note).toMatch(/the PR is refused/);
    }
  });

  it('refuses a PR edit of a spec file the grader runs, hidden or not', async () => {
    const { fx, prepared, scratch } = await prepareFixture({ specs: ['test/visible.test.js'] });
    for (const path of ['test/visible.test.js', 'test/slug-hidden.test.js', './test\\basic.test.js']) {
      const g = await grade(
        fx.task,
        prepared,
        { files: [{ path, content: '// weakened\n' }], deleted: [] },
        localRunner,
        scratch,
      );
      expect(g.note).toMatch(/is a graded test file/);
    }
    const gone = await grade(fx.task, prepared, { files: [], deleted: ['test/visible.test.js'] }, localRunner, scratch);
    expect(gone.note).toMatch(/is a graded test file/);
  });

  it('lets an ordinary source, test and doc path through', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    const change: Change = {
      files: [
        { path: 'src/slug.js', content: FIXED },
        { path: 'test/helper.js', content: 'export {};\n' },
        { path: 'docs/package-notes.md', content: 'x\n' },
      ],
      deleted: [],
    };
    expect((await grade(fx.task, prepared, change, localRunner, scratch)).outcome).toBe('pass');
  });

  it('refuses a PR path that goes through a symbolic link in the tree', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    symlinkSync('src', join(prepared.installed, 'alias'));
    const g = await grade(
      fx.task,
      prepared,
      { files: [{ path: 'alias/slug.js', content: FIXED }], deleted: [] },
      localRunner,
      scratch,
    );
    expect(g).toMatchObject({ outcome: 'fail' });
    expect(g.note).toMatch(/symbolic link/);
    const viaDelete = await grade(fx.task, prepared, { files: [], deleted: ['alias/slug.js'] }, localRunner, scratch);
    expect(viaDelete.note).toMatch(/symbolic link/);
  });

  it('applies a PR deletion, so removing a stray file can fix the run', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    writeFileSync(
      join(prepared.installed, 'test/poison.test.js'),
      `import { test } from 'node:test';\ntest('poison', () => { throw new Error('x'); });\n`,
    );
    const files = [{ path: 'src/slug.js', content: FIXED }];
    expect((await grade(fx.task, prepared, { files, deleted: [] }, localRunner, scratch)).outcome).toBe('fail');
    expect(
      (await grade(fx.task, prepared, { files, deleted: ['test/poison.test.js'] }, localRunner, scratch)).outcome,
    ).toBe('pass');
  });

  it('needs every hidden spec in the structured report with a nonzero pass count', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    const hiddenOnly = (cwd: string, hidden: readonly string[]) => hidden.slice(0, 1).map((h) => spec(cwd, h, 3, 0));
    const skipped = (cwd: string, hidden: readonly string[]) => hidden.map((h) => spec(cwd, h, 0, 0));
    const allGreen = (cwd: string, hidden: readonly string[]) => hidden.map((h) => spec(cwd, h, 1, 0));
    const oneRed = (cwd: string, hidden: readonly string[]) => hidden.map((h, i) => spec(cwd, h, 1, i === 0 ? 1 : 0));
    const outcomes = await Promise.all(
      [hiddenOnly, skipped, oneRed, allGreen].map(
        async (counts) => (await grade(fx.task, prepared, NO_CHANGE, reportingRunner(counts), scratch)).outcome,
      ),
    );
    expect(outcomes).toEqual(['fail', 'fail', 'fail', 'pass']);
  });

  it('fails a nonzero exit and an unparseable report even when every spec reads green', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    const green = (cwd: string, hidden: readonly string[]) => hidden.map((h) => spec(cwd, h, 1, 0));
    expect((await grade(fx.task, prepared, NO_CHANGE, reportingRunner(green, 1), scratch)).outcome).toBe('fail');
    const garbage: Runner = {
      async run({ cwd }) {
        writeFileSync(join(cwd, '.aw-bench/result.json'), 'not json');
        return { code: 0, out: 'Tests 9 passed', err: '', timedOut: false };
      },
    };
    expect((await grade(fx.task, prepared, NO_CHANGE, garbage, scratch)).specs).toBeNull();
  });
});

describe('the structured report of the runner', () => {
  it('counts vitest assertions by status and a file that failed to load as a failure', () => {
    const report = {
      testResults: [
        { name: '/work/a.test.ts', status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'failed' }] },
        { name: '/work/b.test.ts', status: 'failed', assertionResults: [] },
        { name: '/work/c.test.ts', status: 'passed', assertionResults: [{ status: 'skipped' }, { status: 'passed' }] },
      ],
    };
    expect(parseSpecs('vitest', JSON.stringify(report))).toEqual([
      { file: '/work/a.test.ts', passed: 1, failed: 1 },
      { file: '/work/b.test.ts', passed: 0, failed: 1 },
      { file: '/work/c.test.ts', passed: 1, failed: 0 },
    ]);
  });

  it.each(['', 'null', '[]', '{}', '{"testResults":[{"name":1}]}'])('reads %j as no report', (text) => {
    expect(parseSpecs('vitest', text)).toBeNull();
    expect(parseSpecs('node-test', text)).toBeNull();
  });
});

describe('the installed dependencies and package metadata in the cage', () => {
  const installedWith = (pkg: object, entries: string[]) => {
    const dir = tempDir('installed');
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    for (const entry of entries) mkdirSync(join(dir, 'node_modules', entry), { recursive: true });
    return dir;
  };

  it('reports a copy of the project itself that is newer than the base, and passes older or equal ones', () => {
    const pkg = { name: 'ufo', version: '1.5.4' };
    expect(installedProblems(installedWith(pkg, ['.pnpm/ufo@1.3.2', '.pnpm/ufo@1.5.4', '.pnpm/ufo-x@9.0.0']))).toEqual(
      [],
    );
    const newer = installedProblems(installedWith(pkg, ['.pnpm/ufo@1.6.0_peer']));
    expect(newer).toHaveLength(1);
    expect(newer[0]).toContain('node_modules/.pnpm/ufo@1.6.0_peer');
    expect(installedProblems(installedWith(pkg, ['.pnpm/ufo@next']))).toHaveLength(1);
  });

  it('reports a newer top-level copy and a scoped one', () => {
    const top = installedWith({ name: 'ufo', version: '1.0.0' }, ['ufo']);
    writeFileSync(join(top, 'node_modules/ufo/package.json'), '{"version":"2.0.0"}');
    expect(installedProblems(top)).toHaveLength(1);
    const scoped = installedWith({ name: '@a/b', version: '1.0.0' }, ['.pnpm/@a+b@1.0.1']);
    expect(installedProblems(scoped)).toHaveLength(1);
  });

  it('strips the upstream repository, homepage and bugs links and keeps the rest', () => {
    const dir = installedWith(
      {
        name: 'ufo',
        version: '1.0.0',
        repository: 'unjs/ufo',
        homepage: 'https://x',
        bugs: { url: 'https://y' },
        license: 'MIT',
      },
      [],
    );
    neutralisePackage(dir);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({
      name: 'ufo',
      version: '1.0.0',
      license: 'MIT',
    });
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  });
});
