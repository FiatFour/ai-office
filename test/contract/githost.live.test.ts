import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { github } from '../../server/githost/github.ts';
import { type ApiCall, cliTransport } from '../../server/githost/host.ts';
import { type GithostSubject, githostCases, payloadCases } from './githost.contract.ts';
import { registerCases, registerNotRun } from './kit.ts';
import { type Deliveries, forwardDeliveries, tidy, WEBHOOK_CASE } from './live-github.ts';

const repo = process.env.AW_LIVE_GITHUB ?? '';

registerNotRun('gitlab-live', 'not run, no account (gate G0): GitLab has no account, so no live GitLab lane');

if (repo === '') {
  registerNotRun(
    'github-live',
    'AW_LIVE_GITHUB is unset: the live lane needs a gh login and the private scratch repo, which public CI has neither of, and the scratch repo runs no Actions',
  );
} else {
  describe(`GitHost contract live on ${repo}`, () => {
    const run = randomBytes(3).toString('hex');
    const branches: string[] = [];
    const calls: ApiCall[] = [];
    let deliveries: Deliveries;
    const client = github({ repo, base: 'main', send: cliTransport('gh'), log: (call) => calls.push(call) });
    const subject: GithostSubject = {
      has: new Set(),
      host: 'github',
      repo,
      author: client,
      reviewer: client,
      as: () => {
        throw new Error('a live run has one account');
      },
      calls,
      merges: () => calls.filter((c) => /\/merge$/.test(c.path)).length,
      get payloads() {
        return deliveries.payloads;
      },
      branch: (tag) => {
        const branch = `aw/contract/${run}-${tag}`;
        branches.push(branch);
        return branch;
      },
    };

    beforeAll(async () => {
      deliveries = await forwardDeliveries(repo);
    }, 120_000);

    afterAll(async () => {
      await deliveries?.stop();
      const left = await tidy(repo, branches);
      expect(left).toEqual([]);
    }, 180_000);

    registerCases('github-live', githostCases, () => subject, 180_000);

    registerCases(
      'github-live',
      [
        {
          id: WEBHOOK_CASE,
          rule: 'the host delivers the push, change, review and review comment webhooks, every one signed with the secret',
          run: async () => {
            const want = ['push', 'pull_request', 'pull_request_review', 'pull_request_review_comment'];
            const deadline = Date.now() + 90_000;
            while (!want.every((e) => deliveries.payloads.some((p) => p.event === e)) && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, 1000));
            expect(want.filter((e) => !deliveries.payloads.some((p) => p.event === e))).toEqual([]);
            expect(deliveries.rejected).toBe(0);
          },
        },
        ...payloadCases,
      ],
      () => subject,
      180_000,
    );

    it('left no merge call in the log', () => {
      expect(subject.merges()).toBe(0);
    });
  });
}
