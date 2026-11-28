import type { HostChangeState } from '@agent-works/core';
import { logExcerpt } from './ci-log.ts';
import {
  type ApiCall,
  allPages,
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
  type HostEvent,
  type HttpRequest,
  id,
  isPlaced,
  MAX_FAILURES,
  MAX_LOGS,
  once,
  oneOf,
  optLine,
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

const MR_STATE: Record<string, HostChangeState> = {
  opened: 'open',
  locked: 'open',
  closed: 'closed',
  merged: 'merged',
};
const PIPELINE: Record<string, HostCheckState> = {
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  pending: 'pending',
  running: 'pending',
  scheduled: 'pending',
  manual: 'pending',
  canceling: 'pending',
  skipped: 'skipped',
  success: 'success',
  failed: 'failure',
  canceled: 'failure',
};

const PROJECT_PATH = /^[A-Za-z0-9_][\w-]*(?:\.[\w-]+)*(?:\/[A-Za-z0-9_][\w-]*(?:\.[\w-]+)*)+$/;
const route = (tail: string) => new RegExp(`^/${tail}$`);
const ACTIONS: ReadonlySet<unknown> = new Set(['create', 'update']);

const commitProblem = (body: Record<string, unknown>, scope: Scope): string | null => {
  const problem = branchProblem(body.branch);
  if (problem !== null) return problem;
  if (body.start_branch !== undefined && body.start_branch !== scope.base)
    return `a new branch must start from ${scope.base}`;
  if (!Array.isArray(body.actions) || body.actions.length === 0) return 'the commit lists no file';
  for (const action of body.actions as Array<Record<string, unknown>>) {
    const extra = unknownKey(action, ['action', 'file_path', 'content']);
    if (extra !== null) return extra;
    if (!ACTIONS.has(action.action) || typeof action.content !== 'string')
      return 'a commit action is not a plain create or update';
    const bad = filePathProblem(action.file_path);
    if (bad !== null) return bad;
  }
  return null;
};

const POSITION_KEYS = ['position_type', 'base_sha', 'start_sha', 'head_sha', 'new_path', 'new_line'];

export const GITLAB_WRITES: readonly WriteRule[] = [
  {
    method: 'POST',
    path: route('repository/commits'),
    keys: ['branch', 'start_branch', 'commit_message', 'actions'],
    body: commitProblem,
  },
  {
    method: 'POST',
    path: route('merge_requests'),
    keys: ['source_branch', 'target_branch', 'title', 'description'],
    body: (b, scope) =>
      branchProblem(b.source_branch) ?? (b.target_branch === scope.base ? null : `an MR must target ${scope.base}`),
  },
  {
    method: 'POST',
    path: route('merge_requests/\\d+/discussions'),
    keys: ['body', 'position'],
    body: (b) => unknownKey(b.position, POSITION_KEYS),
  },
  { method: 'POST', path: route('merge_requests/\\d+/notes'), keys: ['body'] },
  { method: 'POST', path: route('merge_requests/\\d+/approve'), keys: ['sha'] },
];

const repoOf = (b: unknown): string => str(b, 'project.path_with_namespace');

const noteUrl = (repo: string, number: number, note: string): string =>
  `https://gitlab.com/${repo}/-/merge_requests/${number}#note_${note}`;

const authorOf = (actor: unknown, authorId: string): string =>
  id(actor, 'id') === authorId ? str(actor, 'username') : `gitlab-id-${authorId}`;

const mrFromApi = (repo: string, mr: unknown): ChangeFact => ({
  host: 'gitlab',
  kind: 'change',
  repo,
  headRepo:
    id(mr, 'source_project_id') === id(mr, 'target_project_id')
      ? repo
      : `gitlab-project-${id(mr, 'source_project_id')}`,
  number: count(mr, 'iid'),
  branch: str(mr, 'source_branch'),
  author: str(mr, 'author.username'),
  state: oneOf(mr, 'state', MR_STATE),
  headSha: str(mr, 'sha'),
  url: str(mr, 'web_url'),
  at: time(mr, 'updated_at'),
});

const note = (repo: string, number: number, n: unknown): CommentFact => {
  const position = field(n, 'position') ?? null;
  return {
    host: 'gitlab',
    kind: 'review_comment',
    repo,
    number,
    commentId: id(n, 'id'),
    reviewId: null,
    author: str(n, 'author.username'),
    path: position === null ? null : str(position, 'new_path'),
    line: position === null ? null : optLine(position, 'new_line'),
    commitId: position === null ? null : str(position, 'head_sha'),
    body: str(n, 'body'),
    at: time(n, 'updated_at'),
  };
};

const PARSERS: Record<string, (b: unknown) => HostEvent | null> = {
  'Push Hook': (b) => ({
    host: 'gitlab',
    kind: 'push',
    repo: repoOf(b),
    ref: str(b, 'ref'),
    headSha: str(b, 'after'),
    deleted: ZERO_SHA.test(str(b, 'after')),
    at: (field(b, 'commits') as unknown[]).length === 0 ? null : time(b, 'commits.0.timestamp'),
  }),
  'Merge Request Hook': (b) => {
    const mr = field(b, 'object_attributes');
    const repo = repoOf(b);
    const headRepo = str(mr, 'source.path_with_namespace');
    const number = count(mr, 'iid');
    const headSha = str(mr, 'last_commit.id');
    const at = time(mr, 'updated_at');
    if (str(mr, 'action') === 'approved')
      return {
        host: 'gitlab',
        kind: 'review',
        repo,
        number,
        reviewId: `approval-${id(b, 'user.id')}-${headSha}`,
        reviewer: str(b, 'user.username'),
        verdict: 'approve',
        commitId: headSha,
        body: '',
        at,
      };
    return {
      host: 'gitlab',
      kind: 'change',
      repo,
      headRepo,
      number,
      branch: str(mr, 'source_branch'),
      author: authorOf(field(b, 'user'), id(mr, 'author_id')),
      state: oneOf(mr, 'state', MR_STATE),
      headSha,
      url: str(mr, 'url'),
      at,
    };
  },
  'Note Hook': (b) => {
    const attributes = field(b, 'object_attributes');
    if (str(attributes, 'noteable_type') !== 'MergeRequest') return null;
    const position = (attributes as Record<string, unknown>).position ?? null;
    return {
      host: 'gitlab',
      kind: 'review_comment',
      repo: repoOf(b),
      number: count(b, 'merge_request.iid'),
      commentId: id(attributes, 'id'),
      reviewId: null,
      author: str(b, 'user.username'),
      path: position === null ? null : str(position, 'new_path'),
      line: position === null ? null : optLine(position, 'new_line'),
      commitId: position === null ? str(b, 'merge_request.last_commit.id') : str(position, 'head_sha'),
      body: str(attributes, 'note'),
      at: time(attributes, 'updated_at'),
    };
  },
  'Pipeline Hook': (b) => {
    const pipeline = field(b, 'object_attributes');
    return {
      host: 'gitlab',
      kind: 'check',
      repo: repoOf(b),
      headSha: str(pipeline, 'sha'),
      name: `pipeline ${id(pipeline, 'id')}`,
      state: oneOf(pipeline, 'status', PIPELINE),
      at: firstTime(pipeline, 'finished_at', 'created_at'),
    };
  },
};

export const GITLAB_EVENTS: readonly string[] = Object.keys(PARSERS);

export const parseGitlab = (event: string, body: unknown): HostEvent | null => {
  const parse = Object.hasOwn(PARSERS, event) ? PARSERS[event] : undefined;
  return parse === undefined ? null : parse(body);
};

export interface GitlabOptions {
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
  readonly repo: string;
  readonly base: string;
}

export const gitlabScope = (repo: string, base: string): Scope => {
  if (!PROJECT_PATH.test(repo)) throw new Error(`the GitLab project ${JSON.stringify(repo)} is not a namespace path`);
  return { home: `/projects/${encodeURIComponent(repo)}`, base };
};

const MAX_TREE = 50_000;

export const gitlab = ({ send, log, repo, base }: GitlabOptions): GitHost => {
  const api = guard('gitlab', GITLAB_WRITES, gitlabScope(repo, base), send, log);
  const call = (method: HttpRequest['method'], path: string, body?: unknown) =>
    api(body === undefined ? { method, path } : { method, path, body });
  const get = (path: string) => call('GET', path);
  const login = once(async () => str(await get('/user'), 'username').toLowerCase());
  const project = (repo: string) => `/projects/${encodeURIComponent(repo)}`;
  const exists = async (path: string) => (await orNull(call('GET', path))) !== null;

  const pipelines = async (repo: string, sha: string): Promise<CheckFact[]> => {
    const list = await allPages(get, `${project(repo)}/pipelines?sha=${sha}`);
    return list.map((p) => ({
      host: 'gitlab',
      kind: 'check',
      repo,
      headSha: str(p, 'sha'),
      name: `pipeline ${id(p, 'id')}`,
      state: oneOf(p, 'status', PIPELINE),
      at: time(p, 'updated_at'),
    }));
  };

  /** The failed jobs of the commit's failed pipelines. A pipeline with none, such as a canceled one, is named itself. */
  const failures = async (repo: string, headSha: string): Promise<CheckFailure[]> => {
    const failed = (await pipelines(repo, headSha)).filter((p) => p.state === 'failure');
    const found: { name: string; job: string | null }[] = [];
    for (const pipeline of failed) {
      const number = pipeline.name.slice('pipeline '.length);
      const jobs = (await allPages(get, `${project(repo)}/pipelines/${number}/jobs?scope[]=failed`)).filter(
        (job) => (job as { allow_failure?: unknown }).allow_failure !== true,
      );
      if (jobs.length === 0) found.push({ name: pipeline.name, job: null });
      for (const job of jobs) found.push({ name: str(job, 'name'), job: id(job, 'id') });
    }
    return Promise.all(
      found.slice(0, MAX_FAILURES).map(async ({ name, job }, index) => ({
        name,
        output:
          job === null || index >= MAX_LOGS
            ? null
            : await outputOf(async () => {
                const trace = await get(`${project(repo)}/jobs/${job}/trace`);
                return typeof trace === 'string' ? logExcerpt(trace) : null;
              }),
      })),
    );
  };

  const paths = async (repo: string, number: number): Promise<string[]> => {
    const diffs = await allPages(get, `${project(repo)}/merge_requests/${number}/diffs`);
    return diffs.filter((d) => field(d, 'deleted_file') !== true).map((d) => str(d, 'new_path'));
  };

  return {
    id: 'gitlab',
    login,

    async findChange(repo, branch) {
      const list = await allPages(
        get,
        `${project(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
      );
      const open = list.map((mr) => mrFromApi(repo, mr)).filter((mr) => mr.branch === branch);
      return open.sort((a, b) => a.number - b.number)[0] ?? null;
    },

    async openChange(repo, spec) {
      const mr = await call('POST', `${project(repo)}/merge_requests`, {
        source_branch: spec.branch,
        target_branch: spec.base,
        title: spec.title,
        description: spec.body,
      });
      return mrFromApi(repo, mr);
    },

    async pushFiles(repo, spec) {
      const branchPath = `${project(repo)}/repository/branches/${encodeURIComponent(spec.branch)}`;
      const branchExists = await exists(branchPath);
      const ref = branchExists ? spec.branch : spec.base;
      const actions = [];
      for (const file of spec.files) {
        const path = `${project(repo)}/repository/files/${encodeURIComponent(file.path)}/raw?ref=${encodeURIComponent(ref)}`;
        const raw = await orNull(call('GET', path));
        const current = raw === null ? null : String(raw);
        if (current === file.content) continue;
        actions.push({ action: current === null ? 'create' : 'update', file_path: file.path, content: file.content });
      }
      if (actions.length === 0) return str(await call('GET', branchPath), 'commit.id');
      const commit = await call('POST', `${project(repo)}/repository/commits`, {
        branch: spec.branch,
        ...(branchExists ? {} : { start_branch: spec.base }),
        commit_message: spec.message,
        actions,
      });
      return str(commit, 'id');
    },

    async snapshot(repo, number) {
      const mr = await call('GET', `${project(repo)}/merge_requests/${number}`);
      const now = mrFromApi(repo, mr);
      const approvals = await call('GET', `${project(repo)}/merge_requests/${number}/approvals`);
      const reviews: ReviewFact[] = (field(approvals, 'approved_by') as unknown[]).map((a) => ({
        host: 'gitlab',
        kind: 'review',
        repo,
        number,
        reviewId: `approval-${id(a, 'user.id')}-${now.headSha}`,
        reviewer: str(a, 'user.username'),
        verdict: 'approve',
        commitId: now.headSha,
        body: '',
        at: time(approvals, 'updated_at'),
      }));
      return { change: now, reviews, checks: await pipelines(repo, now.headSha) };
    },

    async comments(repo, number) {
      const list = await allPages(get, `${project(repo)}/merge_requests/${number}/notes`);
      return list.filter((n) => field(n, 'system') !== true).map((n) => note(repo, number, n));
    },

    failures,

    paths,

    async files(repo, number, headSha) {
      const files = [];
      for (const path of await paths(repo, number)) {
        const got = await get(`${project(repo)}/repository/files/${encodeURIComponent(path)}?ref=${headSha}`);
        files.push({ path, content: contentText(got) });
      }
      return files;
    },

    async tree(repo, sha) {
      const listed = await allPages(
        get,
        `${project(repo)}/repository/tree?ref=${sha}&recursive=true`,
        undefined,
        MAX_TREE,
      );
      return listed
        .filter((e) => str(e, 'type') === 'blob')
        .map((e) => ({ path: str(e, 'path'), mode: str(e, 'mode'), sha: str(e, 'id') }));
    },

    async blob(repo, sha) {
      return Buffer.from(str(await get(`${project(repo)}/repository/blobs/${sha}`), 'content'), 'base64');
    },

    async postReview(repo, number, draft) {
      const mr = await call('GET', `${project(repo)}/merge_requests/${number}`);
      const refs = field(mr, 'diff_refs');
      const placed = draft.comments.filter(isPlaced);
      const unplaced = draft.comments.filter((c) => !isPlaced(c));
      for (const c of placed)
        await call('POST', `${project(repo)}/merge_requests/${number}/discussions`, {
          body: c.body,
          position: {
            position_type: 'text',
            base_sha: str(refs, 'base_sha'),
            start_sha: str(refs, 'start_sha'),
            head_sha: draft.commitId,
            new_path: c.path,
            new_line: c.line,
          },
        });
      if (draft.verdict === 'approve')
        await call('POST', `${project(repo)}/merge_requests/${number}/approve`, { sha: draft.commitId });
      const carried =
        unplaced.length === 0
          ? draft.body
          : carriedList(draft.body, 'These comments have no line in the diff, so they are listed here:', unplaced);
      const text = `${carried}\n\nVerdict: ${draft.verdict}`;
      const summary = await call('POST', `${project(repo)}/merge_requests/${number}/notes`, { body: text });
      return {
        host: 'gitlab',
        kind: 'review',
        repo,
        number,
        reviewId: `note-${id(summary, 'id')}`,
        reviewer: str(summary, 'author.username'),
        verdict: draft.verdict === 'approve' ? 'approve' : 'comment',
        commitId: draft.commitId,
        body: text,
        at: time(summary, 'created_at'),
      };
    },

    async findComment(repo, number, marker) {
      const self = await login();
      const list = await allPages(get, `${project(repo)}/merge_requests/${number}/notes`);
      const found = list.find(
        (n) => str(n, 'author.username').toLowerCase() === self && str(n, 'body').split('\n').includes(marker),
      );
      return found === undefined ? null : { id: id(found, 'id'), url: noteUrl(repo, number, id(found, 'id')) };
    },

    async postComment(repo, number, text) {
      const posted = await call('POST', `${project(repo)}/merge_requests/${number}/notes`, { body: text });
      return { id: id(posted, 'id'), url: noteUrl(repo, number, id(posted, 'id')) };
    },
  };
};
