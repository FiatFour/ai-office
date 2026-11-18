import { posix } from 'node:path';

export const RUNNER_CONFIG =
  /(^|\/)((vitest|vite|jest|mocha|ava|babel|postcss|rollup|c8|nyc)\.(config|workspace)[^/]*|\.(mocharc|babelrc|postcssrc|swcrc|c8rc|nycrc)[^/]*)$/i;

const PROTECTED: readonly RegExp[] = [
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

export const normal = (path: string): string => posix.normalize(path.replace(/\\/g, '/'));

export const protectedReason = (path: string): string | null => {
  const rel = normal(path);
  return PROTECTED.some((pattern) => pattern.test(rel))
    ? `${path} is runner, package or dependency state the grader owns`
    : null;
};

export const isTestSide = (path: string): boolean => TEST_SIDE.some((pattern) => pattern.test(normal(path)));
