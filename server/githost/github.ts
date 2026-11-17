import { createHash } from 'node:crypto';
import type { CheckState, HostChangeState, Verdict } from '@agent-works/core';
import {
  type ApiCall,
  bool,
  type ChangeFact,
  type CheckFact,
  type CommentFact,
  count,
  field,
  firstTime,
  type GitHost,
  guard,
  type HostCheckState,
  HostError,
  type HostEvent,
  type HttpRequest,
  id,
  oneOf,
  optLine,
  optStr,
  type ReviewFact,
  str,
  type Transport,
  time,
  type WriteRule,
  ZERO_SHA,
} from './host.ts';

const CONCLUSION: Record<string, HostCheckState> = {
  success: 'success',
  neutral: 'success',
  skipped: 'skipped',
  failure: 'failure',
  cancelled: 'failure',
  timed_out: 'failure',
  action_required: 'failure',
  stale: 'failure',
  startup_failure: 'failure',
};
const RUN_DONE: Record<string, boolean> = {
  requested: false,
  queued: false,
  waiting: false,
  pending: false,
  in_progress: false,
  completed: true,
};
const STATUS: Record<string, CheckState> = {
  pending: 'pending',
  success: 'success',
  failure: 'failure',
  error: 'failure',
};
const PR_STATE: Record<string, HostChangeState> = { open: 'open', closed: 'closed' };
const REVIEW: Record<string, Verdict | null> = {
  approved: 'approve',
  changes_requested: 'changes',
  commented: 'comment',
  dismissed: null,
  pending: null,
  APPROVED: 'approve',
  CHANGES_REQUESTED: 'changes',
  COMMENTED: 'comment',
  DISMISSED: null,
  PENDING: null,
};
const EVENT: Record<Verdict, string> = { approve: 'APPROVE', changes: 'REQUEST_CHANGES', comment: 'COMMENT' };

const REPO = '[\\w.-]+/[\\w.-]+';
export const GITHUB_WRITES: readonly WriteRule[] = [
  ['POST', new RegExp(`^/repos/${REPO}/git/refs$`)],
  ['PUT', new RegExp(`^/repos/${REPO}/contents(?:/[\\w-][\\w.-]*)+$`)],
  ['POST', new RegExp(`^/repos/${REPO}/pulls$`)],
  ['POST', new RegExp(`^/repos/${REPO}/pulls/\\d+/reviews$`)],
  ['POST', new RegExp(`^/repos/${REPO}/issues/\\d+/comments$`)],
];

const repoOf = (b: unknown): string => str(b, 'repository.full_name');

const change = (repo: string, pr: unknown): ChangeFact => ({
  host: 'github',
  kind: 'change',
  repo,
  headRepo: field(pr, 'head.repo') === null ? '(deleted)' : str(pr, 'head.repo.full_name'),
  number: count(pr, 'number'),
  branch: str(pr, 'head.ref'),
  author: str(pr, 'user.login'),
  state: bool(pr, 'merged') || optStr(pr, 'merged_at') !== null ? 'merged' : oneOf(pr, 'state', PR_STATE),
  headSha: str(pr, 'head.sha'),
  url: str(pr, 'html_url'),
  at: time(pr, 'updated_at'),
});

const changeFromList = (repo: string, pr: unknown): ChangeFact =>
  change(repo, { ...(pr as object), merged: optStr(pr, 'merged_at') !== null });

const review = (repo: string, number: number, r: unknown): ReviewFact => ({
  host: 'github',
  kind: 'review',
  repo,
  number,
  reviewId: id(r, 'id'),
  reviewer: str(r, 'user.login'),
  verdict: oneOf(r, 'state', REVIEW),
  commitId: str(r, 'commit_id'),
  body: optStr(r, 'body') ?? '',
  at: time(r, 'submitted_at'),
});

const comment = (repo: string, number: number, c: unknown): CommentFact => ({
  host: 'github',
  kind: 'review_comment',
  repo,
  number,
  commentId: id(c, 'id'),
  reviewId: field(c, 'pull_request_review_id') === null ? null : id(c, 'pull_request_review_id'),
  author: str(c, 'user.login'),
  path: str(c, 'path'),
  line: optLine(c, 'line'),
  commitId: str(c, 'commit_id'),
  body: str(c, 'body'),
  at: time(c, 'updated_at'),
});

const status = (repo: string, s: unknown, sha = str(s, 'sha')): CheckFact => ({
  host: 'github',
  kind: 'check',
  repo,
  headSha: sha,
  name: str(s, 'context'),
  state: oneOf(s, 'state', STATUS),
  at: time(s, 'updated_at'),
});

const checkRun = (repo: string, run: unknown): CheckFact => ({
  host: 'github',
  kind: 'check',
  repo,
  headSha: str(run, 'head_sha'),
  name: str(run, 'name'),
  state: oneOf(run, 'status', RUN_DONE) ? oneOf(run, 'conclusion', CONCLUSION) : 'pending',
  at: firstTime(run, 'completed_at', 'started_at'),
});

const PARSERS: Record<string, (b: unknown) => HostEvent | null> = {
  push: (b) => ({
    host: 'github',
    kind: 'push',
    repo: repoOf(b),
    ref: str(b, 'ref'),
    headSha: str(b, 'after'),
    deleted: bool(b, 'deleted') || ZERO_SHA.test(str(b, 'after')),
    at: time(b, 'repository.pushed_at'),
  }),
  pull_request: (b) => change(repoOf(b), field(b, 'pull_request')),
  pull_request_review: (b) => review(repoOf(b), count(b, 'pull_request.number'), field(b, 'review')),
  pull_request_review_comment: (b) => comment(repoOf(b), count(b, 'pull_request.number'), field(b, 'comment')),
  status: (b) => status(repoOf(b), b),
  check_run: (b) => checkRun(repoOf(b), field(b, 'check_run')),
};

export const GITHUB_EVENTS: readonly string[] = [...Object.keys(PARSERS), 'ping'];

export const parseGithub = (event: string, body: unknown): HostEvent | null => {
  const parse = Object.hasOwn(PARSERS, event) ? PARSERS[event] : undefined;
  return parse === undefined ? null : parse(body);
};

const blobSha = (content: string): string => {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

const segments = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export interface GithubOptions {
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
}

export const github = ({ send, log }: GithubOptions): GitHost => {
  const api = guard('github', GITHUB_WRITES, send, log);
  const call = (method: HttpRequest['method'], path: string, body?: unknown) =>
    api(body === undefined ? { method, path } : { method, path, body });
  const missing = async (path: string): Promise<unknown | null> => {
    try {
      return await call('GET', path);
    } catch (error) {
      if (error instanceof HostError && error.status === 404) return null;
      throw error;
    }
  };
  const owner = (repo: string) => repo.split('/')[0] ?? '';

  return {
    id: 'github',
    detect: (remote) => /(^|[@/])github\.com[:/]/i.test(remote),
    parseDelivery: parseGithub,

    async findChange(repo, branch) {
      const list = (await call(
        'GET',
        `/repos/${repo}/pulls?state=open&head=${owner(repo)}:${encodeURIComponent(branch)}&per_page=10`,
      )) as unknown[];
      const open = list.map((pr) => changeFromList(repo, pr)).filter((pr) => pr.branch === branch);
      return open.sort((a, b) => a.number - b.number)[0] ?? null;
    },

    async openChange(repo, spec) {
      const pr = await call('POST', `/repos/${repo}/pulls`, {
        title: spec.title,
        body: spec.body,
        head: spec.branch,
        base: spec.base,
        draft: false,
      });
      return changeFromList(repo, pr);
    },

    async pushFiles(repo, spec) {
      const ref = await missing(`/repos/${repo}/git/ref/heads/${segments(spec.branch)}`);
      let head = ref === null ? '' : str(ref, 'object.sha');
      if (ref === null) {
        const base = await call('GET', `/repos/${repo}/git/ref/heads/${segments(spec.base)}`);
        head = str(base, 'object.sha');
        await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${spec.branch}`, sha: head });
      }
      for (const file of spec.files) {
        const path = `/repos/${repo}/contents/${segments(file.path)}`;
        const existing = await missing(`${path}?ref=${encodeURIComponent(spec.branch)}`);
        const sha = existing === null ? null : str(existing, 'sha');
        if (sha === blobSha(file.content)) continue;
        const put = await call('PUT', path, {
          message: spec.message,
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          branch: spec.branch,
          ...(sha === null ? {} : { sha }),
        });
        head = str(put, 'commit.sha');
      }
      return head;
    },

    async snapshot(repo, number) {
      const pr = await call('GET', `/repos/${repo}/pulls/${number}`);
      const now = change(repo, pr);
      const reviews = (await call('GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`)) as unknown[];
      const combined = await call('GET', `/repos/${repo}/commits/${now.headSha}/status`);
      const runs = await call('GET', `/repos/${repo}/commits/${now.headSha}/check-runs?per_page=100`);
      return {
        change: now,
        reviews: reviews.filter((r) => optStr(r, 'submitted_at') !== null).map((r) => review(repo, number, r)),
        checks: [
          ...(field(combined, 'statuses') as unknown[]).map((s) => status(repo, s, now.headSha)),
          ...(field(runs, 'check_runs') as unknown[]).map((run) => checkRun(repo, run)),
        ],
      };
    },

    async comments(repo, number) {
      const list = (await call('GET', `/repos/${repo}/pulls/${number}/comments?per_page=100`)) as unknown[];
      return list.map((c) => comment(repo, number, c));
    },

    async files(repo, number, headSha) {
      const list = (await call('GET', `/repos/${repo}/pulls/${number}/files?per_page=100`)) as unknown[];
      const files = [];
      for (const entry of list.filter((f) => str(f, 'status') !== 'removed')) {
        const path = str(entry, 'filename');
        const got = await call('GET', `/repos/${repo}/contents/${segments(path)}?ref=${headSha}`);
        files.push({ path, content: Buffer.from(str(got, 'content'), 'base64').toString('utf8') });
      }
      return files;
    },

    async postReview(repo, number, draft) {
      const body = (event: string, text: string) => ({
        commit_id: draft.commitId,
        event,
        body: text,
        comments: draft.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
      });
      try {
        return review(
          repo,
          number,
          await call('POST', `/repos/${repo}/pulls/${number}/reviews`, body(EVENT[draft.verdict], draft.body)),
        );
      } catch (error) {
        if (
          !(error instanceof HostError && error.status === 422 && /own pull request/i.test(JSON.stringify(error.body)))
        )
          throw error;
        const text = `${draft.body}\n\n(The reviewer's verdict was "${draft.verdict}". GitHub refuses it on a PR the same account opened, so it is posted as a comment.)`;
        return review(
          repo,
          number,
          await call('POST', `/repos/${repo}/pulls/${number}/reviews`, body('COMMENT', text)),
        );
      }
    },

    async findComment(repo, number, marker) {
      const list = (await call('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`)) as unknown[];
      const found = list.find((c) => str(c, 'body').includes(marker));
      return found === undefined ? null : { id: id(found, 'id'), url: str(found, 'html_url') };
    },

    async postComment(repo, number, text) {
      const posted = await call('POST', `/repos/${repo}/issues/${number}/comments`, { body: text });
      return { id: id(posted, 'id'), url: str(posted, 'html_url') };
    },
  };
};
