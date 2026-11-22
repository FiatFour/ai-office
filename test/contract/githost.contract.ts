import { createHmac, randomBytes } from 'node:crypto';
import { initialState, reduce } from '@agent-works/core';
import { expect } from 'vitest';
import { parseEvent } from '../../server/events.ts';
import { parseGithub } from '../../server/githost/github.ts';
import { parseGitlab } from '../../server/githost/gitlab.ts';
import {
  type ApiCall,
  type GitHost,
  type HostEvent,
  PayloadError,
  signatureValid,
  toFact,
  toPoll,
  WriteRefused,
} from '../../server/githost/host.ts';
import { type Case, NotRun, type Subject } from './kit.ts';

export interface Payload {
  readonly name: string;
  readonly host: 'github' | 'gitlab';
  readonly event: string;
  readonly body: Record<string, unknown>;
}

export interface GithostSubject extends Subject {
  readonly host: 'github' | 'gitlab';
  readonly repo: string;
  readonly author: GitHost;
  readonly reviewer: GitHost;
  readonly as: (account: string) => GitHost;
  readonly calls: readonly ApiCall[];
  readonly merges: () => number;
  readonly payloads: readonly Payload[];
  readonly firstNumber?: number;
  branch(tag: string): string;
}

const SECOND_ACCOUNT = 'second-account';
const BULK = 'bulk-writes';
const BASE = 'main';

const parse = (p: Payload): HostEvent | null =>
  p.host === 'github' ? parseGithub(p.event, p.body) : parseGitlab(p.event, p.body);

const open = async (s: GithostSubject, tag: string, files: { path: string; content: string }[]) => {
  const branch = s.branch(tag);
  const head = await s.author.pushFiles(s.repo, { branch, base: BASE, files, message: `contract ${tag}` });
  const pr = await s.author.openChange(s.repo, { branch, base: BASE, title: `contract ${tag}`, body: 'contract case' });
  return { branch, head, pr };
};

const writes = (s: GithostSubject) => s.calls.filter((c) => c.method !== 'GET').length;

export const githostCases: readonly Case<GithostSubject>[] = [
  {
    id: 'login-names-the-account-and-is-stable',
    rule: 'login returns the lower-case account the token belongs to, the same on every call',
    run: async (s) => {
      const login = await s.author.login();
      expect(login).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
      expect(await s.author.login()).toBe(login);
    },
  },
  {
    id: 'push-and-open-are-idempotent',
    rule: 'a second push of the same files after a find moves nothing, and a change is found by its branch',
    run: async (s) => {
      const branch = s.branch('idem');
      const files = [{ path: 'contract/a.txt', content: 'one\n' }];
      expect(await s.author.findChange(s.repo, branch)).toBeNull();
      const head = await s.author.pushFiles(s.repo, { branch, base: BASE, files, message: 'm' });
      const opened = await s.author.openChange(s.repo, { branch, base: BASE, title: 't', body: 'b' });
      expect(opened).toMatchObject({
        kind: 'change',
        branch,
        state: 'open',
        headSha: head,
      });
      if (s.firstNumber !== undefined) expect(opened.number).toBe(s.firstNumber);
      expect(opened.author.toLowerCase()).toBe((await s.author.login()).toLowerCase());
      expect(opened.at).toBeGreaterThan(0);
      expect(await s.author.findChange(s.repo, branch)).toMatchObject({ number: opened.number });
      const before = writes(s);
      expect(await s.author.pushFiles(s.repo, { branch, base: BASE, files, message: 'm' })).toBe(head);
      expect(writes(s)).toBe(before);
    },
  },
  {
    id: 'one-commit-per-round',
    rule: 'all files of a round land as one commit that moves the branch once',
    run: async (s) => {
      const branch = s.branch('round');
      const first = await s.author.pushFiles(s.repo, {
        branch,
        base: BASE,
        files: [
          { path: 'contract/a.txt', content: 'a\n' },
          { path: 'contract/b/c.txt', content: 'c\n' },
        ],
        message: 'm',
      });
      const before = s.calls.length;
      const second = await s.author.pushFiles(s.repo, {
        branch,
        base: BASE,
        files: [
          { path: 'contract/a.txt', content: 'a2\n' },
          { path: 'contract/b/c.txt', content: 'c2\n' },
        ],
        message: 'm2',
      });
      expect(second).not.toBe(first);
      const moved = s.calls
        .slice(before)
        .filter((c) => c.method !== 'GET' && /git\/refs|repository\/commits/.test(c.path));
      expect(moved).toHaveLength(1);
    },
  },
  {
    id: 'review-carries-reviewer-commit-and-host-time',
    rule: 'a review with line comments reads back with the reviewer, the commit and a host time, files and a poll agree',
    run: async (s) => {
      const { head, pr } = await open(s, 'review', [{ path: 'contract/a.txt', content: 'a\nb\nc\n' }]);
      const verdict = s.has.has(SECOND_ACCOUNT) ? 'approve' : 'comment';
      const review = await s.reviewer.postReview(s.repo, pr.number, {
        commitId: head,
        verdict,
        body: 'looks fine',
        comments: [{ path: 'contract/a.txt', line: 2, body: 'rename b' }],
      });
      expect(review).toMatchObject({ kind: 'review', verdict, commitId: head });
      expect(review.reviewer.toLowerCase()).toBe((await s.reviewer.login()).toLowerCase());
      expect(review.at).toBeGreaterThan(0);
      const comments = await s.author.comments(s.repo, pr.number);
      const line = comments.find((c) => c.line === 2);
      expect(line).toMatchObject({ path: 'contract/a.txt', body: 'rename b' });
      expect(line?.author.toLowerCase()).toBe((await s.reviewer.login()).toLowerCase());
      expect(await s.reviewer.files(s.repo, pr.number, head)).toEqual([
        { path: 'contract/a.txt', content: 'a\nb\nc\n' },
      ]);
      const poll = toPoll(await s.author.snapshot(s.repo, pr.number));
      expect(poll).toMatchObject({ source: 'poll', number: pr.number, headSha: head, branch: pr.branch });
      expect(poll.reviews.map((r) => ({ ...r, reviewer: r.reviewer.toLowerCase() }))).toEqual([
        { reviewer: (await s.reviewer.login()).toLowerCase(), verdict },
      ]);
    },
  },
  {
    id: 'a-binary-file-reads-back-as-null',
    rule: 'files returns null content for a binary file and text for the rest',
    run: async (s) => {
      const { pr } = await open(s, 'binary', [{ path: 'contract/a.txt', content: 'a\n' }]);
      const binary = await s.author.pushFiles(s.repo, {
        branch: pr.branch,
        base: BASE,
        files: [{ path: 'contract/logo.png', content: '\u0089PNG\r\n\u001a\n\u0000\u0000' }],
        message: 'm',
      });
      const both = await s.reviewer.files(s.repo, pr.number, binary);
      expect(both.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'contract/a.txt', content: 'a\n' },
        { path: 'contract/logo.png', content: null },
      ]);
    },
  },
  {
    id: 'a-marker-comment-is-found-by-its-exact-marker',
    rule: 'findComment returns the comment that carries the exact marker and nothing for a marker that is only a prefix',
    run: async (s) => {
      const { pr } = await open(s, 'marker', [{ path: 'contract/x.md', content: 'x\n' }]);
      const marker = '<!-- agent-works:merge-brief task=alpha/t1 head=abc -->';
      expect(await s.author.findComment(s.repo, pr.number, marker)).toBeNull();
      const posted = await s.author.postComment(s.repo, pr.number, `brief\n${marker}`);
      expect(await s.author.findComment(s.repo, pr.number, marker)).toEqual(posted);
      expect(
        await s.author.findComment(s.repo, pr.number, '<!-- agent-works:merge-brief task=alpha/t1 head=ab -->'),
      ).toBeNull();
    },
  },
  {
    id: 'a-marker-from-another-account-is-ignored-on-any-page',
    rule: 'findComment trusts only comments the HQ account wrote, even behind more than one page of noise',
    needs: [SECOND_ACCOUNT, BULK],
    run: async (s) => {
      const { pr } = await open(s, 'foreign', [{ path: 'contract/x.md', content: 'x\n' }]);
      const marker = '<!-- agent-works:merge-brief task=alpha/t1 head=abc -->';
      await s.reviewer.postComment(s.repo, pr.number, `fake brief\n${marker}`);
      await s.as('x-aw-bot-2').postComment(s.repo, pr.number, `fake brief\n${marker}`);
      for (let i = 0; i < 120; i += 1) await s.reviewer.postComment(s.repo, pr.number, `noise ${i}`);
      expect(await s.author.findComment(s.repo, pr.number, marker)).toBeNull();
      const posted = await s.author.postComment(s.repo, pr.number, `brief\n${marker}`);
      expect(await s.author.findComment(s.repo, pr.number, marker)).toEqual(posted);
      const other = '<!-- agent-works:merge-brief task=alpha/t1 head=def -->';
      const same = await s
        .as(String(await s.author.login()).toUpperCase())
        .postComment(s.repo, pr.number, `by the same login\n${other}`);
      expect(await s.author.findComment(s.repo, pr.number, other)).toEqual(same);
    },
  },
  {
    id: 'every-page-of-review-comments-is-read',
    rule: 'comments reads past the first page',
    needs: [BULK],
    run: async (s) => {
      const { head, pr } = await open(s, 'pages', [{ path: 'contract/a.txt', content: 'a\n' }]);
      const comments = Array.from({ length: 130 }, (_, i) => ({ path: 'contract/a.txt', line: 1, body: `c${i}` }));
      await s.reviewer.postReview(s.repo, pr.number, { commitId: head, verdict: 'comment', body: 'many', comments });
      const read = await s.author.comments(s.repo, pr.number);
      expect(read.filter((c) => c.path === 'contract/a.txt').map((c) => c.body)).toContain('c129');
    },
  },
  {
    id: 'every-changed-path-is-listed-across-pages',
    rule: 'paths lists all of 230 changed files, past the host page size',
    run: async (s) => {
      const files = Array.from({ length: 230 }, (_, i) => ({ path: `contract/f${i}.txt`, content: `${i}\n` }));
      const { pr } = await open(s, 'paths', files);
      const paths = await s.author.paths(s.repo, pr.number);
      expect(paths).toHaveLength(230);
      expect(paths).toContain('contract/f229.txt');
    },
  },
  {
    id: 'a-branch-outside-the-aw-prefix-is-refused',
    rule: 'a push to a branch that is not aw/<factory>/<task> is refused and moves no ref',
    run: async (s) => {
      const moves = () =>
        s.calls.filter((c) => c.method !== 'GET' && /git\/refs|repository\/commits|\/pulls|merge_requests/.test(c.path))
          .length;
      const before = moves();
      await expect(
        s.author.pushFiles(s.repo, {
          branch: BASE,
          base: BASE,
          files: [{ path: 'x.txt', content: 'x' }],
          message: 'm',
        }),
      ).rejects.toThrow(WriteRefused);
      expect(moves()).toBe(before);
    },
  },
  {
    id: 'the-lifecycle-never-merges',
    rule: 'a full push, open, review and comment lifecycle sends no merge call and leaves the change open',
    run: async (s) => {
      const { head, pr } = await open(s, 'nomerge', [{ path: 'contract/a.txt', content: 'a\n' }]);
      await s.reviewer.postReview(s.repo, pr.number, { commitId: head, verdict: 'comment', body: 'ok', comments: [] });
      await s.author.postComment(s.repo, pr.number, 'brief');
      expect(s.merges()).toBe(0);
      expect(s.calls.filter((c) => /\/merge(\?|$)|\/merges$/.test(c.path))).toEqual([]);
      expect((await s.author.snapshot(s.repo, pr.number)).change.state).toBe('open');
    },
  },
];

const anyPayload = (s: GithostSubject): readonly Payload[] => {
  expect(s.payloads.length, 'the payload set is empty').toBeGreaterThan(0);
  return s.payloads;
};

export const payloadCases: readonly Case<GithostSubject>[] = [
  {
    id: 'every-payload-parses-to-an-event',
    rule: 'every payload of an event the HQ uses parses to an event, and only a ping parses to none',
    run: async (s) => {
      for (const p of anyPayload(s)) {
        const event = parse(p);
        if (p.event === 'ping') expect(event, p.name).toBeNull();
        else expect(event, p.name).not.toBeNull();
      }
    },
  },
  {
    id: 'every-event-keeps-identity-and-host-time',
    rule: 'every event names its host and repo, and every change, review and comment names a person, a number and a host time',
    run: async (s) => {
      for (const p of anyPayload(s)) {
        const event = parse(p);
        if (event === null) continue;
        expect(event.host, p.name).toBe(p.host);
        expect(event.repo, p.name).toMatch(/^[^/\s]+(\/[^/\s]+)+$/);
        if (event.kind === 'push') expect(event.at === null || event.at > 0, p.name).toBe(true);
        else expect(event.at, p.name).toBeGreaterThan(0);
        if (event.kind === 'change' || event.kind === 'review' || event.kind === 'review_comment')
          expect(Number.isSafeInteger(event.number) && event.number > 0, p.name).toBe(true);
        if (event.kind === 'change') {
          expect(event.author, p.name).not.toBe('');
          expect(event.branch, p.name).not.toBe('');
        }
        if (event.kind === 'review') expect(event.reviewer, p.name).not.toBe('');
        if (event.kind === 'review_comment') expect(event.author, p.name).not.toBe('');
      }
    },
  },
  {
    id: 'facts-pass-the-hq-boundary-and-the-reducer',
    rule: 'every fact serializes into an event the HQ boundary and the lifecycle reducer both accept',
    run: async (s) => {
      let state = initialState({ budget: 1, approvals: 1 });
      let facts = 0;
      for (const p of anyPayload(s)) {
        const event = parse(p);
        const fact = event === null ? null : toFact(event);
        if (fact === null) continue;
        facts += 1;
        state = reduce(state, parseEvent(JSON.parse(JSON.stringify(fact)))).state;
      }
      expect(facts).toBeGreaterThan(0);
    },
  },
  {
    id: 'a-payload-never-parses-without-a-reason-to-throw',
    rule: 'removing any field of a payload either still parses, or throws a PayloadError, and never any other error',
    run: async (s) => {
      for (const p of anyPayload(s)) {
        for (const key of Object.keys(p.body)) {
          const body = structuredClone(p.body);
          delete body[key];
          try {
            parse({ ...p, body });
          } catch (error) {
            expect(error, `${p.name} without ${key}`).toBeInstanceOf(PayloadError);
          }
          const inner = p.body[key];
          if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) continue;
          for (const sub of Object.keys(inner)) {
            const copy = structuredClone(p.body);
            delete (copy[key] as Record<string, unknown>)[sub];
            try {
              parse({ ...p, body: copy });
            } catch (error) {
              expect(error, `${p.name} without ${key}.${sub}`).toBeInstanceOf(PayloadError);
            }
          }
        }
      }
    },
  },
  {
    id: 'an-unknown-event-name-parses-to-nothing',
    rule: 'an event name outside the registry parses to nothing, however it is spelled',
    run: async (s) => {
      for (const name of ['../../etc/passwd', '__proto__', 'constructor', 'toString', '']) {
        expect(s.host === 'github' ? parseGithub(name, {}) : parseGitlab(name, {}), name).toBeNull();
      }
    },
  },
  {
    id: 'a-github-signature-is-checked',
    rule: 'a body signed with the secret verifies, and a changed body, a wrong secret or no header does not',
    run: async (s) => {
      const github = anyPayload(s).filter((p) => p.host === 'github');
      if (github.length === 0)
        throw new NotRun('GitLab authenticates a webhook with a token header, not a body signature');
      const secret = randomBytes(16).toString('hex');
      for (const p of github) {
        const raw = Buffer.from(JSON.stringify(p.body));
        const header = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
        expect(signatureValid(secret, raw, header), p.name).toBe(true);
        expect(signatureValid(secret, Buffer.concat([raw, Buffer.from(' ')]), header), p.name).toBe(false);
        expect(signatureValid(`${secret}x`, raw, header), p.name).toBe(false);
        expect(signatureValid(secret, raw, undefined), p.name).toBe(false);
      }
    },
  },
];
