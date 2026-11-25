import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { type HostFault, memorySubject } from './fakes/githost.ts';
import { fakeSubject, type SandboxFault } from './fakes/sandbox.ts';
import { type GithostSubject, githostCases, type Payload, payloadCases } from './githost.contract.ts';
import { attempt, withDeadline } from './kit.ts';
import { recorded } from './payloads.ts';
import { sandboxCases } from './sandbox.contract.ts';

const ROOM = process.platform === 'win32' ? 240_000 : 60_000;

const SANDBOX_BREAKS: Record<SandboxFault, string[]> = {
  'leaks-secrets': ['export-is-sanitized', 'every-protected-file-is-removed'],
  'runs-as-root': ['cage-is-hardened', 'throwaway-has-no-network-and-is-hardened'],
  'open-network': ['cage-has-no-route-out-but-the-proxy'],
  'silent-denials': ['cage-has-no-route-out-but-the-proxy'],
  'release-twice': ['release-is-idempotent'],
  'keeps-containers': ['remove-all-leaves-nothing'],
  'accepts-cage-source': ['cage-workdir-is-refused-as-a-source'],
  'throwaway-networked': ['throwaway-has-no-network-and-is-hardened'],
  'filters-run-on-host': ['source-filters-never-run-on-the-host'],
  'empty-export-ok': ['a-failed-archive-refuses-the-export'],
  'vague-missing-image': ['a-missing-image-names-the-build-command'],
  'half-started-on-error': ['a-bad-source-leaves-nothing-behind', 'a-failed-archive-refuses-the-export'],
  'exec-anywhere': ['exec-needs-a-running-cage'],
  'allow-anything': ['allow-takes-a-host-rule-only'],
  'work-read-only': ['cage-files-belong-to-the-host-user'],
};

const failing = async (faults: SandboxFault[]): Promise<string[]> => {
  const subject = fakeSubject(tempDir('self-sandbox'), faults);
  const failed: string[] = [];
  for (const item of sandboxCases) if ((await attempt(item, subject)).status === 'fail') failed.push(item.id);
  return failed;
};

describe('the SandboxDriver contract against an in-memory fake', () => {
  it(
    'passes every case on the fake that keeps every rule',
    async () => {
      expect(await failing([])).toEqual([]);
    },
    ROOM,
  );

  it('names every fault in the table, and every case is broken by one', () => {
    const covered = new Set(Object.values(SANDBOX_BREAKS).flat());
    expect(sandboxCases.filter((item) => !covered.has(item.id)).map((item) => item.id)).toEqual([]);
  });

  it.each(Object.entries(SANDBOX_BREAKS))(
    'fails %s on the cases that guard it',
    async (fault, expected) => {
      const failed = await failing([fault as SandboxFault]);
      expect(failed).toEqual(expect.arrayContaining(expected));
      expect(failed.length).toBeGreaterThan(0);
    },
    ROOM,
  );
});

const HOST_BREAKS: Record<HostFault, string[]> = {
  'rewrites-on-repeat': ['push-and-open-are-idempotent'],
  'two-moves-per-round': ['one-commit-per-round'],
  'review-loses-commit': ['review-carries-reviewer-commit-and-host-time'],
  'binary-as-text': ['a-binary-file-reads-back-as-null'],
  'marker-by-prefix': ['a-marker-comment-is-found-by-its-exact-marker'],
  'foreign-marker-trusted': ['a-marker-from-another-account-is-ignored-on-any-page'],
  'one-page-only': ['every-changed-path-is-listed-across-pages', 'every-page-of-review-comments-is-read'],
  'any-branch': ['a-branch-outside-the-aw-prefix-is-refused'],
  merges: ['the-lifecycle-never-merges'],
  'login-drifts': ['login-names-the-account-and-is-stable'],
};

const PAYLOADS = recorded('github');
const brokenPayload = (mutate: (body: Record<string, unknown>) => void, name: string): Payload[] =>
  PAYLOADS.map((p) => {
    if (p.name !== name) return p;
    const body = structuredClone(p.body);
    mutate(body);
    return { ...p, body };
  });

const failingCases = async (subject: GithostSubject, cases = [...githostCases, ...payloadCases]): Promise<string[]> => {
  const failed: string[] = [];
  for (const item of cases) if ((await attempt(item, subject)).status === 'fail') failed.push(item.id);
  return failed;
};

describe('the GitHost contract against an in-memory fake', () => {
  it('declares that its logins keep their case, so the contract compares them byte for byte', () => {
    expect(memorySubject([], PAYLOADS).exactLogin).toBe(true);
  });

  it('passes every host case on the fake that keeps every rule, and says why it skips none', async () => {
    const subject = memorySubject([], PAYLOADS);
    expect(await failingCases(subject)).toEqual([]);
    const skipped: string[] = [];
    for (const item of githostCases)
      if ((await attempt(item, memorySubject([], PAYLOADS))).status === 'not-run') skipped.push(item.id);
    expect(skipped).toEqual([]);
  });

  it('fails the first-number check when the host numbers its first change differently', async () => {
    const subject = { ...memorySubject([], PAYLOADS), firstNumber: 99 };
    expect(await failingCases(subject, [...githostCases])).toContain('push-and-open-are-idempotent');
  });

  it('breaks every host case with one fault', () => {
    expect(githostCases.map((item) => item.id).filter((id) => !Object.values(HOST_BREAKS).flat().includes(id))).toEqual(
      [],
    );
  });

  it.each(Object.entries(HOST_BREAKS))('fails %s on the cases that guard it', async (fault, ids) => {
    expect(await failingCases(memorySubject([fault as HostFault], PAYLOADS), [...githostCases])).toEqual(
      expect.arrayContaining(ids),
    );
  });

  it('reports a case that needs a second account as not run, with the reason, when the host has one account', async () => {
    const one = memorySubject([], PAYLOADS, ['bulk-writes']);
    const marker = githostCases.find((item) => item.id === 'a-marker-from-another-account-is-ignored-on-any-page');
    expect(await attempt(marker as (typeof githostCases)[number], one)).toMatchObject({
      status: 'not-run',
      reason: 'needs second-account',
    });
  });

  it.each([
    [
      'a payload that loses its host time',
      brokenPayload((b) => {
        (b.review as Record<string, unknown>).submitted_at = 'yesterday';
      }, 'github/pull_request_review.json'),
    ],
    [
      'a payload of an event the parser does not know',
      PAYLOADS.map((p, i) => (i === 0 ? { ...p, event: 'bogus' } : p)),
    ],
    ['an empty payload set', []],
  ])('fails the payload cases on %s', async (_name, payloads) => {
    const failed = await failingCases(memorySubject([], payloads), [...payloadCases]);
    expect(failed.length).toBeGreaterThan(0);
  });
});

describe('a case that never returns', () => {
  it('becomes a failed outcome with the time it was given, instead of a row nobody wrote', async () => {
    const outcome = await withDeadline(new Promise(() => {}), 20);
    expect(outcome).toMatchObject({ status: 'fail', reason: 'timed out after 20 ms' });
  });

  it('keeps the outcome of a case that returns in time', async () => {
    const outcome = await withDeadline(Promise.resolve({ status: 'pass', reason: null, error: null }), 1000);
    expect(outcome.status).toBe('pass');
  });
});
