import { posix } from 'node:path';
import type { GitHost } from '../../server/githost/host.ts';
import { TaskRefused } from '../model.ts';

export const touchesWorkflows = (path: string): boolean => {
  const rel = posix.normalize(path.replace(/\\/g, '/')).replace(/^\/+/, '').toLowerCase();
  return rel === '.github' || rel.startsWith('.github/');
};

export const workflowPaths = (paths: readonly string[]): string[] => paths.filter(touchesWorkflows);

export const guardWorkflows = (host: GitHost): GitHost =>
  Object.create(host, {
    pushFiles: {
      value: async (repo: string, spec: Parameters<GitHost['pushFiles']>[1]) => {
        const hit = workflowPaths(spec.files.map((f) => f.path));
        if (hit.length > 0)
          throw new TaskRefused(`a Set B PR may not touch .github, refused before push: ${hit.join(', ')}`);
        return host.pushFiles(repo, spec);
      },
    },
  });
