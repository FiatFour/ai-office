import { expect, it } from 'vitest';
import { githostCases, payloadCases } from './githost.contract.ts';
import { recordExpected } from './kit.ts';
import { WEBHOOK_CASE } from './live-github.ts';
import { sandboxCases } from './sandbox.contract.ts';

const EXPECTED: Record<string, readonly string[]> = {
  docker: sandboxCases.map((item) => item.id),
  podman: sandboxCases.map((item) => item.id),
  'github-recorded': [...githostCases, ...payloadCases].map((item) => item.id),
  'gitlab-recorded': [...githostCases, ...payloadCases].map((item) => item.id),
  'github-live': [...githostCases.map((item) => item.id), WEBHOOK_CASE, ...payloadCases.map((item) => item.id)],
};

it('states the cases each driver must run, from the contract and not from the registration', () => {
  for (const [driver, ids] of Object.entries(EXPECTED)) {
    expect(new Set(ids).size).toBe(ids.length);
    recordExpected(driver, ids);
  }
});
