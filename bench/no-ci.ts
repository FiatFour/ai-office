import { githubScope } from '../server/githost/github.ts';
import { type ApiCall, type GitHost, guard, type Transport, type WriteRule } from '../server/githost/host.ts';

export const NO_CI_CONTEXT = 'aw-bench/no-ci';
export const NO_CI_DESCRIPTION = 'No CI is configured in the bench repo, so the harness marks this head as passing';

export const NO_CI_WRITES: readonly WriteRule[] = [
  {
    method: 'POST',
    path: /^\/statuses\/[0-9a-f]{40}$/,
    keys: ['state', 'context', 'description'],
    body: (b) =>
      b.state === 'success' && b.context === NO_CI_CONTEXT && b.description === NO_CI_DESCRIPTION
        ? null
        : 'only the no-ci success status may be posted',
  },
];

export interface NoCiOptions {
  readonly repo: string;
  readonly base: string;
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
  readonly onFailure: (error: unknown) => void;
}

export const withNoCiStatus = (inner: GitHost, o: NoCiOptions): GitHost => {
  const api = guard('github', NO_CI_WRITES, githubScope(o.repo, o.base), o.send, o.log);
  const produced = new Set<string>();
  const marked = new Set<string>();
  let failed: unknown = null;

  const mark = async (head: string): Promise<void> => {
    marked.add(head);
    try {
      await api({
        method: 'POST',
        path: `/repos/${o.repo}/statuses/${head}`,
        body: { state: 'success', context: NO_CI_CONTEXT, description: NO_CI_DESCRIPTION },
      });
    } catch (error) {
      failed = error;
      o.onFailure(error);
      throw error;
    }
  };

  return {
    ...inner,
    async pushFiles(repo, spec) {
      const head = await inner.pushFiles(repo, spec);
      produced.add(head);
      return head;
    },
    async snapshot(repo, number) {
      const seen = await inner.snapshot(repo, number);
      if (failed !== null) throw failed;
      const head = seen.change.headSha;
      if (!produced.has(head) || marked.has(head)) return seen;
      if (seen.checks.some((c) => c.headSha === head && c.name === NO_CI_CONTEXT && c.state === 'success')) return seen;
      await mark(head);
      return inner.snapshot(repo, number);
    },
  };
};
