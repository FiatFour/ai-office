import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { type Script, scriptedArm } from '../arms.ts';
import { grade, NO_CHANGE, parseSpecs } from '../grade.ts';
import { type Change, TaskRefused } from '../model.ts';
import { canonical } from '../protected.ts';
import { runTask } from '../run.ts';
import { localRunner, type Runner } from '../runner.ts';
import { suspectReasons } from '../testside.ts';
import { insideOf, installedProblems, neutralisePackage } from '../workspace.ts';
import { FIXED, GUARDED, prepareFixture } from './fixture.ts';

const POSIX_ONLY = process.platform === 'win32';
const NODE_STAND_IN = Number(process.versions.node.split('.')[0]) >= 22;
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

const writeVerified = async (dir: string, fixPassed: number) =>
  writeFileSync(join(dir, 'verified.json'), JSON.stringify({ prepareMs: 0, fixPassed }));

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
  await writeVerified(s.prepared.dir, 0);
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
    '.mocharc.json',
    'packages/a/.mocharc.cjs',
    'postcss.config.js',
    'rollup.config.mjs',
    '.swcrc',
    '.c8rc.json',
    '.pnp.cjs',
    '.yarn/releases/yarn.cjs',
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
    writeFileSync(join(prepared.installed, 'src/stray.txt'), 'x\n');
    const files = [{ path: 'src/slug.js', content: GUARDED }];
    expect((await grade(fx.task, prepared, { files, deleted: [] }, localRunner, scratch)).outcome).toBe('fail');
    expect((await grade(fx.task, prepared, { files, deleted: ['src/stray.txt'] }, localRunner, scratch)).outcome).toBe(
      'pass',
    );
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
  const copyWith = (version: string, files: Record<string, string>, base: Record<string, string> = {}) => {
    const dir = installedWith({ name: 'ufo', version: '1.5.4' }, []);
    const copy = join(dir, 'node_modules/.pnpm', `ufo@${version}`, 'node_modules/ufo');
    for (const [root, set] of [
      [copy, files],
      [dir, base],
    ] as const)
      for (const [rel, text] of Object.entries(set)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
    return dir;
  };

  it('judges an equal-version copy by its content: source that differs from the base tree is reported, docs and dist are not', () => {
    const base = { 'src/index.ts': 'export const a = 1;\n', 'README.md': 'new\n' };
    expect(installedProblems(copyWith('1.5.4', { 'dist/index.mjs': 'x', 'README.md': 'old\n' }, base))).toEqual([]);
    expect(installedProblems(copyWith('1.5.4', { 'src/index.ts': 'export const a = 1;\n' }, base))).toEqual([]);
    const differing = installedProblems(copyWith('1.5.4', { 'src/index.ts': 'export const a = 2;\n' }, base));
    expect(differing).toEqual([expect.stringContaining('src/index.ts differs from the same file in the base tree')]);
    expect(installedProblems(copyWith('1.3.2', { 'src/index.ts': 'export const a = 2;\n' }, base))).toEqual([]);
  });

  it('reports a copy of the project that carries a hidden test, whatever its version', () => {
    const dir = copyWith('1.3.2', { 'test/found.test.ts': 'secret\n' });
    const hidden = tempDir('hidden');
    writeFileSync(join(hidden, 'x.test.ts'), 'secret\n');
    expect(installedProblems(dir, hidden)).toEqual([expect.stringContaining('is a copy of the hidden test x.test.ts')]);
    expect(installedProblems(dir)).toEqual([]);
  });

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

const NODE_REPORTER = fileURLToPath(new URL('../reporters/node-json.mjs', import.meta.url));
const EXIT_EARLY = {
  'package.json': '{"type":"module"}',
  'src/m.js': 'export const f=(x)=>{ if (x===2) process.exit(0); return x; };\n',
  'test/h.test.js': `import { test } from 'node:test';
import assert from 'node:assert';
import { f } from '../src/m.js';
test('a', () => assert.equal(f(1), 1));
test('b', () => assert.equal(f(2), 3));
`,
};

const reported = (files: Record<string, string>) => {
  const dir = tempDir('node-reporter');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const out = join(dir, 'result.json');
  spawnSync(
    'node',
    ['--test', `--test-reporter=${NODE_REPORTER}`, `--test-reporter-destination=${out}`, 'test/h.test.js'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  return (JSON.parse(readFileSync(out, 'utf8')) as { files: { passed: number; failed: number }[] }).files;
};

describe.skipIf(POSIX_ONLY)('the node:test report', () => {
  it.skipIf(!NODE_STAND_IN)(
    'counts a file that ends before it reports its tests as a failure, not as the stand-in pass node prints for it',
    () => {
      expect(reported(EXIT_EARLY)).toEqual([expect.objectContaining({ passed: 0, failed: 1 })]);
    },
  );

  it('counts real tests, skips excluded', () => {
    const files = {
      'package.json': '{"type":"module"}',
      'test/h.test.js': `import { test } from 'node:test';
test('a', () => {});
test('b', () => {});
test('c', { skip: true }, () => {});
test('d', () => { throw new Error('x'); });
`,
    };
    expect(reported(files)).toEqual([expect.objectContaining({ passed: 2, failed: 1 })]);
  });

  it.skipIf(!NODE_STAND_IN)(
    'fails a PR whose code calls process.exit(0) ahead of the hidden assertions, and marks the row suspect',
    async () => {
      const { fx, prepared, scratch } = await prepareFixture();
      const exit0: Change = { files: [{ path: 'src/slug.js', content: `process.exit(0);\n${FIXED}` }], deleted: [] };
      const g = await grade(fx.task, prepared, exit0, localRunner, scratch);
      expect(g.outcome).toBe('fail');
      expect(g.suspect).toEqual([expect.stringContaining('calls process.exit')]);
      await writeVerified(prepared.dir, 0);
      const row = await runTask(fx.task, 1, prepared, {
        arm: scriptedArm('baseline', { [fx.task.id]: exit0 }),
        runner: localRunner,
        scratch,
      });
      expect(row).toMatchObject({ flag: 'suspect', outcome: 'fail' });
    },
  );
});

describe.skipIf(POSIX_ONLY)('the tests the grader runs come from the base tree', () => {
  const plant = (installed: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(installed, rel, '..'), { recursive: true });
      writeFileSync(join(installed, rel), text);
    }
  };
  const PASSING = "import { test } from 'node:test';\ntest('x', () => {});\n";
  const fixed: Change['files'][number] = { path: 'src/slug.js', content: FIXED };

  it('drops a PR edit of a spec file the grader runs, hidden or not, and grades the rest', async () => {
    const { fx, prepared, scratch } = await prepareFixture({ specs: ['test/visible.test.js'] });
    for (const path of ['test/visible.test.js', 'test/slug-hidden.test.js', './test\\basic.test.js']) {
      const g = await grade(
        fx.task,
        prepared,
        { files: [fixed, { path, content: '// weakened\n' }], deleted: [] },
        localRunner,
        scratch,
      );
      expect(g.outcome).toBe('pass');
      expect(g.dropped).toEqual([canonical(path)]);
    }
    const gone = await grade(
      fx.task,
      prepared,
      { files: [fixed], deleted: ['test/visible.test.js'] },
      localRunner,
      scratch,
    );
    expect(gone).toMatchObject({ outcome: 'pass', dropped: ['test/visible.test.js'] });
  });

  it('grades fail with a note when the PR touches only test-side files', async () => {
    const { fx, prepared, scratch } = await prepareFixture({ specs: ['test/visible.test.js'] });
    const g = await grade(
      fx.task,
      prepared,
      { files: [{ path: 'test/visible.test.js', content: '// weakened\n' }], deleted: ['test/slug-hidden.test.js'] },
      localRunner,
      scratch,
    );
    expect(g).toMatchObject({
      outcome: 'fail',
      specs: null,
      dropped: ['test/visible.test.js', 'test/slug-hidden.test.js'],
    });
    expect(g.note).toMatch(/nothing to grade: .*only test-side files, dropped test\/visible\.test\.js/);
  });

  it('never lets a dropped test-side edit reach the graded tree', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    plant(prepared.installed, { 'src/cases.spec.ts': 'export const cases = [1];\n' });
    const seen: string[] = [];
    const spy: Runner = {
      async run({ cwd }) {
        seen.push(
          readFileSync(join(cwd, 'src/cases.spec.ts'), 'utf8'),
          existsSync(join(cwd, 'src/new.test.ts')) ? 'new' : 'no-new',
        );
        return localRunner.run({ argv: ['true'], cwd, image: '', network: false, timeoutMs: 1000 });
      },
    };
    await grade(
      fx.task,
      prepared,
      {
        files: [
          fixed,
          { path: 'src/cases.spec.ts', content: 'export const cases = [];\n' },
          { path: 'src/new.test.ts', content: 'x\n' },
        ],
        deleted: [],
      },
      spy,
      scratch,
    );
    expect(seen).toEqual(['export const cases = [1];\n', 'no-new']);
  });

  it.each([
    'test/helpers/util.js',
    'test/fixtures/data.json',
    'test/__snapshots__/a.test.js.snap',
    'src/cases.spec.ts',
    'src/cases.spec.js',
    'src/__snapshots__/x.snap',
    'src/a.test.mjs',
    'src/a_test.js',
    'scripts/setup.ts',
    'scripts/global.ts',
    'scripts/global.js',
    'packages/a/tests/x.js',
  ])('drops a PR that writes or deletes %s, which the base tree owns, and grades the rest', async (path) => {
    const { fx, prepared, scratch } = await prepareFixture();
    plant(prepared.installed, {
      'test/helpers/util.js': PASSING,
      'test/fixtures/data.json': '{}\n',
      'test/__snapshots__/a.test.js.snap': 'x\n',
      'src/cases.spec.ts': 'export const cases = [1, 2, 3];\n',
      'src/__snapshots__/x.snap': 'x\n',
      'src/a.test.mjs': PASSING,
      'src/a_test.js': PASSING,
      'packages/a/tests/x.js': PASSING,
      'vitest.config.ts': `import setup from './scripts/setup.ts';\nexport default { test: { globalSetup: ['./scripts/global.ts'] }, setup };\n`,
      'scripts/setup.ts': 'export default 1;\n',
      'scripts/global.ts': 'export default 1;\n',
    });
    for (const change of [
      { files: [fixed, { path, content: '// gutted\n' }], deleted: [] },
      { files: [fixed], deleted: [path] },
    ]) {
      const g = await grade(fx.task, prepared, change, localRunner, scratch);
      expect(g.outcome).toBe('pass');
      expect(g.dropped).toEqual([path]);
    }
  });

  const FORMS = (rel: string): string[] => {
    const [dir = '', name = rel] = [rel.slice(0, rel.lastIndexOf('/')), rel.slice(rel.lastIndexOf('/') + 1)];
    return [
      `${rel}/`,
      `${rel}//`,
      `${rel}/.`,
      `./${rel}`,
      `${dir}//${name}`,
      `${dir}/./${name}`,
      `${dir}/x/../${name}`,
      rel.replace(/\//g, '\\'),
      rel.toUpperCase(),
    ];
  };

  it.each(['src/cases.spec.ts', 'src/oddname.js'])(
    'acts on the same path it matched: every spelling of %s is dropped and the base file stays',
    async (rel) => {
      const { fx, prepared, scratch } = await prepareFixture();
      plant(prepared.installed, { 'src/cases.spec.ts': 'export const cases = [1];\n' });
      mkdirSync(join(prepared.hidden, 'src'), { recursive: true });
      writeFileSync(join(prepared.hidden, 'src/oddname.js'), 'export {};\n');
      plant(prepared.installed, { 'src/oddname.js': 'export {};\n' });
      const before = readFileSync(join(prepared.installed, rel), 'utf8');
      const seen: string[] = [];
      const spy: Runner = {
        async run(opts) {
          const file = join(opts.cwd, rel);
          seen.push(existsSync(file) ? readFileSync(file, 'utf8') : 'missing');
          return localRunner.run(opts);
        },
      };
      for (const form of FORMS(rel)) {
        for (const change of [
          { files: [fixed, { path: form, content: '// gutted\n' }], deleted: [] },
          { files: [fixed], deleted: [form] },
        ]) {
          const g = await grade(fx.task, prepared, change, spy, scratch);
          expect(g, form).toMatchObject({ outcome: 'pass', dropped: [canonical(form)] });
        }
      }
      expect(new Set(seen)).toEqual(new Set([before]));
      expect(seen).toHaveLength(FORMS(rel).length * 2);
    },
  );

  it.each([
    ['src'],
    ['src/'],
    ['test'],
    ['test/fixture'],
    ['.'],
    ['./'],
    [''],
    ['src/..'],
    ['../outside.js'],
    ['/etc/passwd'],
    ['C:/x.js'],
    ['.git/config'],
    ['.GIT/config'],
    ['package.json/'],
    ['node_modules/./x/'],
  ])('grades fail with a note, and does not throw, for a PR that deletes %j', async (path) => {
    const { fx, prepared, scratch } = await prepareFixture();
    mkdirSync(join(prepared.installed, 'test/fixture'), { recursive: true });
    writeFileSync(join(prepared.installed, 'test/fixture/a.json'), '{}\n');
    const g = await grade(fx.task, prepared, { files: [fixed], deleted: [path] }, localRunner, scratch);
    expect(g.outcome).toBe('fail');
    expect(g.note).toMatch(/refused|nothing to grade/);
    if (path === 'src' || path === 'src/') expect(g.note).toContain('src is a directory');
  });

  it('grades fail with a note for a PR that writes over a directory or under a file', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    for (const path of ['src', 'src/', 'src/slug.js/inner.js']) {
      const g = await grade(
        fx.task,
        prepared,
        { files: [{ path, content: 'x\n' }], deleted: [] },
        localRunner,
        scratch,
      );
      expect(g, path).toMatchObject({ outcome: 'fail', note: expect.stringMatching(/refused/) });
    }
    const inner = await grade(
      fx.task,
      prepared,
      { files: [{ path: 'src/slug.js/inner.js', content: 'x\n' }], deleted: [] },
      localRunner,
      scratch,
    );
    expect(inner.note).toContain('cannot be applied');
  });

  it('resolves a workspace path the way it canonicalises it', () => {
    const root = join(tmpdir(), 'aw-inside');
    expect(insideOf(root, 'a/b/')).toBe(join(root, 'a/b'));
    expect(insideOf(root, 'a\\b/./c')).toBe(join(root, 'a/b/c'));
    for (const bad of ['.', './', 'a/..', '../x', '/x']) expect(() => insideOf(root, bad), bad).toThrow(TaskRefused);
  });

  it('drops a PR that empties a spec the hidden spec imports, the path-to-regexp-433 scenario', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    plant(prepared.installed, { 'src/cases.spec.js': `export const cases = ['a', 'b'];\n` });
    const hidden = join(prepared.hidden, 'test/slug-hidden.test.js');
    writeFileSync(
      hidden,
      `import { cases } from '../src/cases.spec.js';\n${readFileSync(hidden, 'utf8')}test('cases', () => assert.ok(cases.length === 2));\n`,
    );
    const emptied = { path: 'src/cases.spec.js', content: 'export const cases = [];\n' };
    const g = await grade(fx.task, prepared, { files: [fixed, emptied], deleted: [] }, localRunner, scratch);
    expect(g).toMatchObject({ outcome: 'pass', dropped: ['src/cases.spec.js'] });
  });

  it('drops a same-stem file over a hidden test whose name matches no test pattern', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    mkdirSync(join(prepared.hidden, 'src'), { recursive: true });
    writeFileSync(join(prepared.hidden, 'src/oddname.js'), 'export {};\n');
    const g = await grade(
      fx.task,
      prepared,
      { files: [fixed, { path: 'src/oddname.ts', content: 'export {};\n' }], deleted: [] },
      localRunner,
      scratch,
    );
    expect(g).toMatchObject({ outcome: 'pass', dropped: ['src/oddname.ts'] });
  });

  it('grades a run against the passing-test count recorded for the upstream fix', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    const files = [{ path: 'src/slug.js', content: FIXED }];
    const run = async (fixPassed: number) => {
      await writeVerified(prepared.dir, fixPassed);
      return runTask(fx.task, 1, prepared, {
        arm: scriptedArm('baseline', { [fx.task.id]: { files } }),
        runner: localRunner,
        scratch,
      });
    };
    expect((await run(4)).outcome).toBe('pass');
    expect(await run(5)).toMatchObject({ outcome: 'fail' });
    expect((await run(5)).note).toMatch(/4 tests passed, the upstream fix passes 5/);
  });

  it('fails a suite that ran fewer passing tests than the upstream fix did, whatever the files say', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    const green = (cwd: string, hidden: readonly string[]) => hidden.map((h) => spec(cwd, h, 3, 0));
    const run = (floor: number) => grade(fx.task, prepared, NO_CHANGE, reportingRunner(green), scratch, floor);
    expect((await run(6)).outcome).toBe('pass');
    const gutted = await run(7);
    expect(gutted.outcome).toBe('fail');
    expect(gutted.note).toBe('6 tests passed, the upstream fix passes 7: a suite that shrank cannot pass');
  });

  it('ignores a test file the PR adds, so an honest new test neither fails the PR nor runs', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    const added = {
      path: 'test/new-thing.test.js',
      content: `import { test } from 'node:test';\ntest('x', () => { throw new Error('x'); });\n`,
    };
    expect(await grade(fx.task, prepared, { files: [fixed, added], deleted: [] }, localRunner, scratch)).toMatchObject({
      outcome: 'pass',
      suspect: [],
    });
  });

  it('keeps the code under test editable: a source file a hidden spec imports is not test-side', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    expect((await grade(fx.task, prepared, { files: [fixed], deleted: [] }, localRunner, scratch)).outcome).toBe(
      'pass',
    );
  });
});

describe('the static scan of the files a PR changes', () => {
  it.each([
    ["import { expect } from 'vitest';", 'imports vitest'],
    ["const c = require('chai');", 'imports chai'],
    ["import { test } from 'node:test';", 'imports node:test'],
    ["import assert from 'node:assert/strict';", 'imports node:assert or assert'],
    ["import assert from 'assert';", 'imports node:assert or assert'],
    ['expect.extend({ toBe: () => ({ pass: true }) });', 'calls expect.extend'],
    ['chai.Assertion.prototype.assert = () => {};', 'touches Assertion.prototype'],
    ['process.exit(0);', 'calls process.exit'],
    ['process.reallyExit(0);', 'calls process.exit'],
    ['globalThis.expect = () => {};', 'reaches the test globals'],
    ["writeFileSync('.aw-bench/result.json', '{}');", 'names the grader work directory'],
  ])('flags %s', (line, reason) => {
    expect(suspectReasons('src/x.ts', 'export {};\n', `export {};\n${line}\n`)).toEqual([`src/x.ts ${reason}`]);
  });

  it('flags only what the PR adds, not a use the base file already had, and reads code files only', () => {
    expect(suspectReasons('src/cli.ts', 'process.exit(1);\n', 'process.exit(1);\nconst x = 1;\n')).toEqual([]);
    expect(suspectReasons('src/cli.ts', 'process.exit(1);\n', 'process.exit(1);\nprocess.exit(2);\n')).toHaveLength(1);
    expect(suspectReasons('docs/notes.md', '', 'call process.exit(0) from vitest')).toEqual([]);
  });

  it.skipIf(POSIX_ONLY)(
    'records that a patched assert passes the grader in the same process, and flags the row instead',
    async () => {
      const { fx, prepared, scratch } = await prepareFixture();
      const forged: Change = {
        files: [
          {
            path: 'src/slug.js',
            content: `import assert from 'node:assert/strict';\nassert.equal = () => {};\nexport const slug = () => 'x';\n`,
          },
        ],
        deleted: [],
      };
      const g = await grade(fx.task, prepared, forged, localRunner, scratch);
      expect(g.outcome).toBe('pass');
      expect(g.suspect).toEqual([expect.stringContaining('imports node:assert or assert')]);
    },
  );
});

describe.skipIf(POSIX_ONLY)('the row flags', () => {
  it('flags a row contaminated when the agent made server-side web requests, and suspect when its PR touches test machinery', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    await writeVerified(prepared.dir, 0);
    const run = (script: Script) =>
      runTask(fx.task, 1, prepared, {
        arm: scriptedArm('baseline', { [fx.task.id]: script }),
        runner: localRunner,
        scratch,
      });
    const files = [{ path: 'src/slug.js', content: FIXED }];
    expect(await run({ files })).toMatchObject({ flag: null, outcome: 'pass' });
    expect(await run({ files, webRequests: 2 })).toMatchObject({ flag: 'contaminated', outcome: 'pass' });
    expect((await run({ files, webRequests: 2 })).note).toMatch(/^2 server-side web requests;/);
    expect(await run({ files, webRequests: 0 })).toMatchObject({ flag: null });
  });

  it('records the dropped test-side paths in the row note and still grades the code fix', async () => {
    const { fx, prepared, scratch } = await prepareFixture();
    await writeVerified(prepared.dir, 0);
    const files = [
      { path: 'src/slug.js', content: FIXED },
      { path: 'test/slug-hidden.test.js', content: '// weakened\n' },
    ];
    const row = await runTask(fx.task, 1, prepared, {
      arm: scriptedArm('baseline', { [fx.task.id]: { files } }),
      runner: localRunner,
      scratch,
    });
    expect(row).toMatchObject({ outcome: 'pass', flag: null });
    expect(row.note).toMatch(/dropped test-side edits test\/slug-hidden\.test\.js;/);
  });
});
