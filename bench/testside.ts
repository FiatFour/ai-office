import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { canonical, isTestSide, keyOf, RUNNER_CONFIG } from './protected.ts';
import { readTree } from './workspace.ts';

const CODE = /\.[cm]?[jt]sx?$/i;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const SWAPS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]/g;
// A runner config may name a file with a bare path ('src/setup-env.ts'); it resolves against the config directory.
const LITERAL = /['"]([^'"\s/][^'"\s]*)['"]|['"](\.{1,2}\/[^'"]+)['"]/g;

const stemOf = (rel: string): string => rel.replace(/\.[^./]+$/, '');

export interface TestSide {
  readonly files: ReadonlySet<string>;
  readonly stems: ReadonlySet<string>;
}

const candidates = (from: string, specifier: string): string[] => {
  const target = posix.join(posix.dirname(from), specifier);
  const ext = posix.extname(target);
  const swapped = (SWAPS[ext] ?? []).map((e) => target.slice(0, -ext.length) + e);
  return [
    target,
    ...EXTENSIONS.map((e) => target + e),
    ...swapped,
    ...EXTENSIONS.map((e) => posix.join(target, `index${e}`)),
  ];
};

export const testSideOf = (tree: string, hidden: string): TestSide => {
  const treeRels = readTree(tree).map(canonical);
  const present = new Set(treeRels);
  const files = new Set([...readTree(hidden).map(canonical), ...treeRels.filter(isTestSide)]);
  const queue = treeRels.filter((rel) => RUNNER_CONFIG.test(rel));
  const seen = new Set<string>();
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    files.add(rel);
    const text = readFileSync(join(tree, rel), 'utf8');
    const specifiers = [...text.matchAll(IMPORT)].map((m) => m[1] ?? '');
    if (RUNNER_CONFIG.test(rel)) specifiers.push(...[...text.matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? ''));
    for (const specifier of specifiers) queue.push(...candidates(rel, specifier).filter((c) => present.has(c)));
  }
  return { files: new Set([...files].map(keyOf)), stems: new Set([...files].map((f) => keyOf(stemOf(f)))) };
};

export const refusesTestSide = (side: TestSide, path: string): boolean => {
  const key = keyOf(path);
  return side.files.has(key) || side.stems.has(stemOf(key));
};

export const isNewTestFile = (side: TestSide, path: string): boolean =>
  isTestSide(path) && !refusesTestSide(side, path);

const SUSPECT: ReadonlyArray<readonly [string, RegExp]> = [
  ['imports vitest', /['"]vitest(\/[^'"]*)?['"]/g],
  ['imports chai', /['"]chai(\/[^'"]*)?['"]/g],
  ['imports node:test', /['"]node:test['"]/g],
  ['imports node:assert or assert', /['"](node:)?assert(\/strict)?['"]/g],
  ['calls expect.extend', /\bexpect\s*\.\s*extend\b/g],
  ['touches Assertion.prototype', /\bAssertion\s*\.\s*prototype\b/g],
  ['calls process.exit', /\bprocess\s*\.\s*(exit|reallyExit|abort)\b/g],
  ['reaches the test globals', /\bglobalThis\s*\.\s*(expect|vi|it|test|describe|assert)\b/g],
  ['names the grader work directory', /\.aw-bench/g],
];

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

export const suspectReasons = (path: string, before: string, after: string): string[] =>
  !CODE.test(path)
    ? []
    : SUSPECT.filter(([, pattern]) => count(after, pattern) > count(before, pattern)).map(
        ([reason]) => `${path} ${reason}`,
      );
