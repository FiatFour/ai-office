import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '../../server/test/helpers.ts';
import type { TaskA } from '../model.ts';

export const BUGGY = `export const slug = (s) => s.toLowerCase().replace(/ /g, '-');\n`;
export const FIXED = `export const slug = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-');\n`;
export const HIDDEN_NEW = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../src/slug.js';
test('collapses runs of spaces and trims', () => {
  assert.equal(slug('  Hello   World '), 'hello-world');
});
`;
const OLD_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../src/slug.js';
test('lowercases', () => {
  assert.equal(slug('Hello World'), 'hello-world');
});
`;
const FIXED_TEST = `${OLD_TEST}test('tabs', () => {
  assert.equal(slug('a\\tb'), 'a-b');
});
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  }).trim();

const put = (root: string, rel: string, content: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

export interface Fixture {
  readonly reposRoot: string;
  readonly fixSha: string;
  readonly baseSha: string;
  readonly task: TaskA;
}

export const makeFixture = (over: Partial<TaskA> = {}, options: { duplicate?: boolean } = {}): Fixture => {
  const reposRoot = tempDir('bench-repos');
  const work = tempDir('bench-work');
  git(work, 'init', '-q', '-b', 'main');
  put(work, 'package.json', '{"type":"module"}\n');
  put(work, 'src/slug.js', BUGGY);
  put(work, 'test/basic.test.js', OLD_TEST);
  put(work, 'test/visible.test.js', OLD_TEST.replace('lowercases', 'visible'));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  const baseSha = git(work, 'rev-parse', 'HEAD');
  put(work, 'src/slug.js', FIXED);
  put(work, 'test/basic.test.js', FIXED_TEST);
  put(
    work,
    'test/slug-hidden.test.js',
    options.duplicate === true ? OLD_TEST.replace('lowercases', 'visible') : HIDDEN_NEW,
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fix: slug');
  const fixSha = git(work, 'rev-parse', 'HEAD');
  mkdirSync(join(reposRoot, 'acme'), { recursive: true });
  git(work, 'clone', '-q', '--bare', work, join(reposRoot, 'acme', 'proj.git'));
  const task: TaskA = {
    set: 'A',
    id: 'slug-1',
    repo: 'acme/proj',
    issue: 1,
    title: 'slug mishandles runs of whitespace',
    body: 'slug("  a   b ") should be "a-b".',
    fixSha,
    hiddenPaths: ['test/slug-hidden.test.js', 'test/basic.test.js'],
    installCommand: null,
    testCommand: ['node', '--test'],
    expect: '(pass|# pass) [1-9]',
    baseFail: '(fail|# fail) [1-9]',
    image: 'unused-by-the-local-runner',
    timeoutMs: 60_000,
    confirmed: false,
    ...over,
  };
  return { reposRoot, fixSha, baseSha, task };
};
