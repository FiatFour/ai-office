import { posix } from 'node:path';
import { TaskRefused } from './model.ts';

export const RUNNER_CONFIG =
  /(^|\/)((vitest|vite|jest|mocha|ava|babel|postcss|rollup|c8|nyc)\.(config|workspace)[^/]*|\.(mocharc|babelrc|postcssrc|swcrc|c8rc|nycrc)[^/]*)$/i;

const PROTECTED: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.pnpm-store(\/|$)/i,
  /(^|\/)\.aw-bench(\/|$)/i,
  /(^|\/)package\.json$/i,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/i,
  RUNNER_CONFIG,
  /(^|\/)\.pnp[^/]*$/i,
  /(^|\/)\.yarn(\/|$)/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)\.(npmrc|pnpmfile\.cjs|yarnrc(\.yml)?|nvmrc|env[^/]*)$/i,
];

const TEST_SIDE: readonly RegExp[] = [
  /(^|\/)([^/]*[._-])?(spec|test)\.[^/]+$/i,
  /(^|\/)test-[^/]+$/i,
  /(^|\/)[^/]*\.snap$/i,
  /(^|\/)(__snapshots__|__tests__|__mocks__|__fixtures__|test|tests|fixtures|e2e)(\/|$)/i,
];

export const canonical = (path: string): string => {
  const rel = posix.normalize(path.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (rel === '' || rel === '.') throw new TaskRefused(`${path} names the workspace root`);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[a-z]:\//i.test(rel) || rel.includes('\0'))
    throw new TaskRefused(`${path} leaves the workspace`);
  return rel;
};

export const keyOf = (path: string): string => canonical(path).normalize('NFC').toLowerCase();

export const protectedReason = (path: string): string | null => {
  const rel = canonical(path);
  return PROTECTED.some((pattern) => pattern.test(rel))
    ? `${path} is runner, package or dependency state the grader owns`
    : null;
};

export const isTestSide = (path: string): boolean => TEST_SIDE.some((pattern) => pattern.test(canonical(path)));
