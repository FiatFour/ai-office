import { describe } from 'vitest';
import { github } from '../../server/githost/github.ts';
import { gitlab } from '../../server/githost/gitlab.ts';
import type { ApiCall, GitHost } from '../../server/githost/host.ts';
import { FakeGithub } from '../../server/test/fakes/github-api.ts';
import { FakeGitlab } from '../../server/test/fakes/gitlab-api.ts';
import { type GithostSubject, githostCases, payloadCases } from './githost.contract.ts';
import { registerCases } from './kit.ts';
import { recorded } from './payloads.ts';

const REPO = 'acme/app';

const subjectOn = (host: 'github' | 'gitlab'): GithostSubject => {
  const calls: ApiCall[] = [];
  const api = host === 'github' ? new FakeGithub() : new FakeGitlab();
  const client = (account: string, log: (call: ApiCall) => void): GitHost =>
    host === 'github'
      ? github({ repo: REPO, base: 'main', send: (api as FakeGithub).transport(account), log })
      : gitlab({ repo: REPO, base: 'main', send: (api as FakeGitlab).transport(account), log });
  return {
    has: new Set(['second-account', 'bulk-writes']),
    host,
    repo: REPO,
    author: client('aw-bot', (call) => calls.push(call)),
    reviewer: client('aw-reviewer', (call) => calls.push(call)),
    as: (account) => client(account, () => {}),
    calls,
    merges: () => api.calls.filter((c) => /\/merge$/.test(c.path)).length,
    payloads: recorded(host),
    firstNumber: 1,
    branch: (tag) => `aw/alpha/${tag}`,
  };
};

describe.each(['github', 'gitlab'] as const)('GitHost contract on %s, recorded payloads and fake host API', (host) => {
  registerCases(`${host}-recorded`, [...githostCases, ...payloadCases], () => subjectOn(host), 60_000);
});
