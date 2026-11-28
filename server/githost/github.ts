import { createHash } from 'node:crypto';
import type { CheckState, HostChangeState, Verdict } from '@agent-works/core';
import { logExcerpt } from './ci-log.ts';
import {
  type ApiCall,
  allPages,
  bool,
  branchProblem,
  type ChangeFact,
  type CheckFact,
  type CheckFailure,
  type CommentFact,
  carriedList,
  contentText,
  count,
  field,
  filePathProblem,
  firstTime,
  type GitHost,
  guard,
  type HostCheckState,
  HostError,
  type HostEvent,
  type HttpRequest,
  id,
  isPlaced,
  MAX_FAILURES,
  MAX_LOGS,
  once,
  oneOf,
  optLine,
  optStr,
  orNull,
  outputOf,
  type ReviewFact,
  type Scope,
  str,
  type Transport,
  time,
  unknownKey,
  type WriteRule,
  ZERO_SHA,
} from './host.ts';
import { SEGMENT } from './sanitize.ts';

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

const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const route = (tail: string) => new RegExp(`^/${tail}$`);
const MODES: ReadonlySet<unknown> = new Set(['100644']);
const EVENTS: ReadonlySet<unknown> = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

const treeProblem = (body: Record<string, unknown>): string | null => {
  if (!Array.isArray(body.tree) || body.tree.length === 0) return 'the tree lists no file';
  for (const entry of body.tree as Array<Record<string, unknown>>) {
    const extra = unknownKey(entry, ['path', 'mode', 'type', 'content']);
    if (extra !== null) return extra;
    if (entry.type !== 'blob' || !MODES.has(entry.mode) || typeof entry.content !== 'string')
      return 'a tree entry is not a plain text file';
    const problem = filePathProblem(entry.path);
    if (problem !== null) return problem;
  }
  return null;
};

const reviewProblem = (body: Record<string, unknown>): string | null => {
  if (!EVENTS.has(body.event)) return `the review event ${JSON.stringify(body.event)} is unknown`;
  const comments = Array.isArray(body.comments) ? body.comments : [];
  for (const c of comments) {
    const extra = unknownKey(c, ['path', 'line', 'side', 'body']);
    if (extra !== null) return extra;
  }
  return null;
};

export const GITHUB_WRITES: readonly WriteRule[] = [
  { method: 'POST', path: route('git/trees'), keys: ['base_tree', 'tree'], body: treeProblem },
  {
    method: 'POST',
    path: route('git/commits'),
    keys: ['message', 'tree', 'parents'],
    body: (b) => (Array.isArray(b.parents) && b.parents.length === 1 ? null : 'a commit needs exactly one parent'),
  },
  {
    method: 'POST',
    path: route('git/refs'),
    keys: ['ref', 'sha'],
    body: (b) => branchProblem(typeof b.ref === 'string' ? b.ref.replace(/^refs\/heads\//, '') : null),
  },
  {
    method: 'PATCH',
    path: route(`git/refs/heads/aw/${SEGMENT}/${SEGMENT}`),
    keys: ['sha', 'force'],
    body: (b) => (b.force === undefined || b.force === false ? null : 'a ref update may not force'),
  },
  {
    method: 'POST',
    path: route('pulls'),
    keys: ['title', 'body', 'head', 'base', 'draft'],
    body: (b, scope) =>
      branchProblem(b.head) ??
      (b.base === scope.base ? null : `a PR must target ${scope.base}`) ??
      (b.draft === false ? null : 'a PR opens ready, not draft'),
  },
  {
    method: 'POST',
    path: route('pulls/\\d+/reviews'),
    keys: ['commit_id', 'event', 'body', 'comments'],
    body: reviewProblem,
  },
  { method: 'POST', path: route('issues/\\d+/comments'), keys: ['body'] },
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
  line:
    field(c, 'line') === null && Object.hasOwn(c as object, 'original_line')
      ? optLine(c, 'original_line')
      : optLine(c, 'line'),
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

const textAt = (value: unknown): string => (typeof value === 'string' ? value : '');

/** What a check run says about itself, for one that has no job log. */
const reportOf = (run: unknown): string | null => {
  const output = (run as { output?: { title?: unknown; summary?: unknown; text?: unknown } }).output;
  return logExcerpt([output?.title, output?.summary, output?.text].map(textAt).filter(Boolean).join('\n'));
};

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

const OWN_PULL_REQUEST = /own pull request/i;
const OUTSIDE_THE_DIFF = /could not be resolved|must be part of the diff/i;

const ownPullRequestNote = (verdict: string) =>
  `\n\n(The reviewer's verdict was "${verdict}". GitHub refuses it on a PR the same account opened, so it is posted as a comment.)`;

const OUTSIDE_NOTE =
  'GitHub refused the inline comments because a line is not in the diff, so every comment is listed here:';
const UNPLACED_NOTE = 'These comments have no line in the diff, so they are listed here:';

export interface GithubOptions {
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
  readonly repo: string;
  readonly base: string;
}

export const githubScope = (repo: string, base: string): Scope => {
  if (!REPO.test(repo)) throw new Error(`the GitHub repo ${JSON.stringify(repo)} is not <owner>/<name>`);
  return { home: `/repos/${repo}`, base };
};

export const github = ({ send, log, repo, base }: GithubOptions): GitHost => {
  const api = guard('github', GITHUB_WRITES, githubScope(repo, base), send, log);
  const call = (method: HttpRequest['method'], path: string, body?: unknown) =>
    api(body === undefined ? { method, path } : { method, path, body });
  const get = (path: string) => call('GET', path);
  const missing = (path: string) => orNull(get(path));
  const owner = (repo: string) => repo.split('/')[0] ?? '';
  const login = once(async () => str(await get('/user'), 'login').toLowerCase());

  const statusesOf = (repo: string, sha: string) =>
    allPages(get, `/repos/${repo}/commits/${sha}/status`, (b) => field(b, 'statuses') as unknown[]);
  const runsOf = (repo: string, sha: string) =>
    allPages(get, `/repos/${repo}/commits/${sha}/check-runs`, (b) => field(b, 'check_runs') as unknown[]);

  /** An Actions check run has the id of its job, whose log is the output. */
  const jobLog = async (repo: string, run: unknown): Promise<string | null> => {
    if ((run as { app?: { slug?: unknown } }).app?.slug !== 'github-actions') return null;
    const log = await get(`/repos/${repo}/actions/jobs/${id(run, 'id')}/logs`);
    return typeof log === 'string' ? logExcerpt(log) : null;
  };

  const failures = async (repo: string, headSha: string): Promise<CheckFailure[]> => {
    const [statuses, runs] = await Promise.all([statusesOf(repo, headSha), runsOf(repo, headSha)]);
    // A matrix that fails fast cancels its other jobs. Their logs say nothing, so they come last.
    const cancelled = (run: unknown) => Number(field(run, 'conclusion') === 'cancelled');
    const failedRuns = runs
      .filter((run) => checkRun(repo, run).state === 'failure')
      .sort((a, b) => cancelled(a) - cancelled(b));
    const fromRuns = failedRuns.slice(0, MAX_FAILURES).map(async (run, index) => ({
      name: str(run, 'name'),
      output: index < MAX_LOGS ? ((await outputOf(() => jobLog(repo, run))) ?? reportOf(run)) : null,
    }));
    const fromStatuses = statuses
      .filter((s) => status(repo, s, headSha).state === 'failure')
      .map(async (s) => ({
        name: str(s, 'context'),
        output: logExcerpt(textAt((s as { description?: unknown }).description)),
      }));
    return (await Promise.all([...fromRuns, ...fromStatuses])).slice(0, MAX_FAILURES);
  };

  const listTree = async (repo: string, commit: string): Promise<{ root: string; entries: unknown[] }> => {
    const root = str(await get(`/repos/${repo}/git/commits/${commit}`), 'tree.sha');
    const listing = await get(`/repos/${repo}/git/trees/${root}?recursive=1`);
    if (bool(listing, 'truncated')) throw new Error(`the tree of ${commit} is too large to list in one call`);
    return { root, entries: field(listing, 'tree') as unknown[] };
  };

  const paths = async (repo: string, number: number): Promise<string[]> => {
    const list = await allPages(get, `/repos/${repo}/pulls/${number}/files`);
    return list.filter((f) => str(f, 'status') !== 'removed').map((f) => str(f, 'filename'));
  };

  return {
    id: 'github',
    login,

    async findChange(repo, branch) {
      const list = await allPages(
        get,
        `/repos/${repo}/pulls?state=open&head=${owner(repo)}:${encodeURIComponent(branch)}`,
      );
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
      const parent = str(ref ?? (await get(`/repos/${repo}/git/ref/heads/${segments(spec.base)}`)), 'object.sha');
      const { root: baseTree, entries } = await listTree(repo, parent);
      const blobs = new Map(entries.map((e) => [str(e, 'path'), str(e, 'sha')]));
      const changed = spec.files.filter((file) => blobs.get(file.path) !== blobSha(file.content));
      if (changed.length === 0) return parent;
      const tree = await call('POST', `/repos/${repo}/git/trees`, {
        base_tree: baseTree,
        tree: changed.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
      });
      const commit = await call('POST', `/repos/${repo}/git/commits`, {
        message: spec.message,
        tree: str(tree, 'sha'),
        parents: [parent],
      });
      const head = str(commit, 'sha');
      if (ref === null) await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${spec.branch}`, sha: head });
      else await call('PATCH', `/repos/${repo}/git/refs/heads/${segments(spec.branch)}`, { sha: head, force: false });
      return head;
    },

    async snapshot(repo, number) {
      const pr = await get(`/repos/${repo}/pulls/${number}`);
      const now = change(repo, pr);
      const [reviews, statuses, runs] = await Promise.all([
        allPages(get, `/repos/${repo}/pulls/${number}/reviews`),
        statusesOf(repo, now.headSha),
        runsOf(repo, now.headSha),
      ]);
      return {
        change: now,
        reviews: reviews.filter((r) => optStr(r, 'submitted_at') !== null).map((r) => review(repo, number, r)),
        checks: [...statuses.map((s) => status(repo, s, now.headSha)), ...runs.map((run) => checkRun(repo, run))],
      };
    },

    async comments(repo, number) {
      return (await allPages(get, `/repos/${repo}/pulls/${number}/comments`)).map((c) => comment(repo, number, c));
    },

    failures,

    paths,

    async files(repo, number, headSha) {
      const files = [];
      for (const path of await paths(repo, number)) {
        const got = await get(`/repos/${repo}/contents/${segments(path)}?ref=${headSha}`);
        files.push({ path, content: contentText(got) });
      }
      return files;
    },

    async tree(repo, sha) {
      return (await listTree(repo, sha)).entries
        .filter((e) => str(e, 'type') === 'blob')
        .map((e) => ({ path: str(e, 'path'), mode: str(e, 'mode'), sha: str(e, 'sha') }));
    },

    async blob(repo, sha) {
      return Buffer.from(str(await get(`/repos/${repo}/git/blobs/${sha}`), 'content'), 'base64');
    },

    async postReview(repo, number, draft) {
      let event: string = EVENT[draft.verdict];
      let own = false;
      let comments = draft.comments.filter(isPlaced);
      const unplaced = draft.comments.filter((c) => !isPlaced(c));
      let dropped = false;
      const compose = () => {
        const base = own ? `${draft.body}${ownPullRequestNote(draft.verdict)}` : draft.body;
        if (dropped) return carriedList(base, OUTSIDE_NOTE, draft.comments);
        return unplaced.length === 0 ? base : carriedList(base, UNPLACED_NOTE, unplaced);
      };
      for (;;) {
        try {
          const posted = await call('POST', `/repos/${repo}/pulls/${number}/reviews`, {
            commit_id: draft.commitId,
            event,
            body: compose(),
            comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
          });
          return review(repo, number, posted);
        } catch (error) {
          if (!(error instanceof HostError && error.status === 422)) throw error;
          const refusal = JSON.stringify(error.body);
          if (event !== 'COMMENT' && OWN_PULL_REQUEST.test(refusal)) {
            event = 'COMMENT';
            own = true;
          } else if (comments.length > 0 && OUTSIDE_THE_DIFF.test(refusal)) {
            dropped = true;
            comments = [];
          } else throw error;
        }
      }
    },

    async findComment(repo, number, marker) {
      const self = await login();
      const list = await allPages(get, `/repos/${repo}/issues/${number}/comments`);
      const found = list.find(
        (c) => str(c, 'user.login').toLowerCase() === self && str(c, 'body').split('\n').includes(marker),
      );
      return found === undefined ? null : { id: id(found, 'id'), url: str(found, 'html_url') };
    },

    async postComment(repo, number, text) {
      const posted = await call('POST', `/repos/${repo}/issues/${number}/comments`, { body: text });
      return { id: id(posted, 'id'), url: str(posted, 'html_url') };
    },
  };
};
