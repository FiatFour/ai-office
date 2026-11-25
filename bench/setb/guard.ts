import { posix } from 'node:path';

const PROTECTED = new Set(['codeowners', 'docs/codeowners']);

const norm = (path: string): string => posix.normalize(path.replace(/\\/g, '/'));

export const touchesWorkflows = (path: string): boolean => {
  const rel = norm(path)
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
  return rel === '.github' || rel.startsWith('.github/') || PROTECTED.has(rel);
};

export const workflowPaths = (paths: readonly string[]): string[] => paths.filter(touchesWorkflows);
