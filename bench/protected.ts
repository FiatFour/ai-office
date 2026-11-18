import { posix } from 'node:path';

const PROTECTED: readonly RegExp[] = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.pnpm-store(\/|$)/i,
  /(^|\/)\.aw-bench(\/|$)/i,
  /(^|\/)package\.json$/i,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(vitest|vite|jest|mocha|ava|babel)\.(config|workspace)[^/]*$/i,
  /(^|\/)\.(mocharc|babelrc)[^/]*$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)\.(npmrc|pnpmfile\.cjs|yarnrc(\.yml)?|nvmrc|env[^/]*)$/i,
];

export const normal = (path: string): string => posix.normalize(path.replace(/\\/g, '/'));

export const protectedReason = (path: string): string | null => {
  const rel = normal(path);
  return PROTECTED.some((pattern) => pattern.test(rel))
    ? `${path} is runner, package or dependency state the grader owns`
    : null;
};
