import type { HostChangeState } from '@agent-works/core';
import {
  type ApiCall,
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
  type ReviewFact,
  str,
  type Transport,
  time,
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

const PROJECT = '/projects/[\\w.-]+(?:%2F[\\w.-]+)+';
const ENCODED_PROJECT = /^\/projects\/[\w.-]+(?:%2F[\w.-]+)+/i;
export const GITLAB_WRITES: readonly WriteRule[] = [
  ['POST', new RegExp(`^${PROJECT}/repository/commits$`, 'i')],
  ['POST', new RegExp(`^${PROJECT}/merge_requests$`, 'i')],
  ['POST', new RegExp(`^${PROJECT}/merge_requests/\\d+/discussions$`, 'i')],
  ['POST', new RegExp(`^${PROJECT}/merge_requests/\\d+/notes$`, 'i')],
  ['POST', new RegExp(`^${PROJECT}/merge_requests/\\d+/approve$`, 'i')],
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
}

export const gitlab = ({ send, log }: GitlabOptions): GitHost => {
  const api = guard('gitlab', GITLAB_WRITES, send, log, ENCODED_PROJECT);
  const call = (method: HttpRequest['method'], path: string, body?: unknown) =>
    api(body === undefined ? { method, path } : { method, path, body });
  const project = (repo: string) => `/projects/${encodeURIComponent(repo)}`;
  const exists = async (path: string): Promise<boolean> => {
    try {
      await call('GET', path);
      return true;
    } catch (error) {
      if (error instanceof HostError && error.status === 404) return false;
      throw error;
    }
  };

  const pipelines = async (repo: string, sha: string): Promise<CheckFact[]> => {
    const list = (await call('GET', `${project(repo)}/pipelines?sha=${sha}&per_page=20`)) as unknown[];
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

  return {
    id: 'gitlab',
    detect: (remote) => /(^|[@/])gitlab\.com[:/]/i.test(remote),
    parseDelivery: parseGitlab,

    async findChange(repo, branch) {
      const list = (await call(
        'GET',
        `${project(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=10`,
      )) as unknown[];
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
        let current: string | null = null;
        try {
          current = String(await call('GET', path));
        } catch (error) {
          if (!(error instanceof HostError && error.status === 404)) throw error;
        }
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
      const list = (await call('GET', `${project(repo)}/merge_requests/${number}/notes?per_page=100`)) as unknown[];
      return list.filter((n) => field(n, 'system') !== true).map((n) => note(repo, number, n));
    },

    async files(repo, number, headSha) {
      const mr = await call('GET', `${project(repo)}/merge_requests/${number}/changes`);
      const files = [];
      for (const change of (field(mr, 'changes') as unknown[]).filter((c) => field(c, 'deleted_file') !== true)) {
        const path = str(change, 'new_path');
        const raw = await call(
          'GET',
          `${project(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${headSha}`,
        );
        files.push({ path, content: String(raw) });
      }
      return files;
    },

    async postReview(repo, number, draft) {
      const mr = await call('GET', `${project(repo)}/merge_requests/${number}`);
      const refs = field(mr, 'diff_refs');
      for (const c of draft.comments)
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
      const text = `${draft.body}\n\nVerdict: ${draft.verdict}`;
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
      const list = (await call('GET', `${project(repo)}/merge_requests/${number}/notes?per_page=100`)) as unknown[];
      const found = list.find((n) => str(n, 'body').includes(marker));
      return found === undefined ? null : { id: id(found, 'id'), url: noteUrl(repo, number, id(found, 'id')) };
    },

    async postComment(repo, number, text) {
      const posted = await call('POST', `${project(repo)}/merge_requests/${number}/notes`, { body: text });
      return { id: id(posted, 'id'), url: noteUrl(repo, number, id(posted, 'id')) };
    },
  };
};
