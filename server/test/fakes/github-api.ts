import { createHash } from 'node:crypto';
import type { HttpRequest, HttpResponse, Transport } from '../../githost/host.ts';
import { paged } from './page.ts';

interface Pr {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  author: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  updated: number;
}

interface Review {
  id: number;
  pr: number;
  user: string;
  state: string;
  commit: string;
  body: string;
  at: number;
}

interface Comment {
  id: number;
  pr: number;
  review: number | null;
  user: string;
  path: string;
  line: number;
  commit: string;
  body: string;
  at: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha = (text: string) => createHash('sha1').update(text).digest('hex');
const blob = (content: string) => {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

const CONTEXT = 3;

const textLines = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const hunkLines = (before: string | undefined, after: string): Set<number> => {
  const a = before === undefined ? [] : textLines(before);
  const b = textLines(after);
  const width = b.length + 1;
  const common = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      common[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (i < a.length && at(i + 1, j) >= at(i, j + 1)) i += 1;
    else {
      changed.push(j + 1);
      j += 1;
    }
  }
  const shown = new Set<number>();
  for (const line of changed)
    for (let near = line - CONTEXT; near <= line + CONTEXT; near += 1)
      if (near >= 1 && near <= b.length) shown.add(near);
  return shown;
};

export const UNRESOLVED_LINE = {
  message: 'Unprocessable Entity',
  errors: ['Pull request review thread line must be part of the diff'],
  status: '422',
};

export class FakeGithub {
  readonly repo: string;
  readonly calls: HttpRequest[] = [];
  readonly refs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly parents = new Map<string, string>();
  private readonly treeFiles = new Map<string, Map<string, string>>();
  readonly prs: Pr[] = [];
  readonly reviews: Review[] = [];
  readonly comments: Comment[] = [];
  readonly issueComments: Array<{ id: number; pr: number; user: string; body: string; at: number }> = [];
  readonly statuses: Array<{ sha: string; context: string; state: string; at: number }> = [];
  private clock = Date.parse('2026-11-17T00:00:00Z');
  private next = 100;

  readonly ci: string | null;

  constructor(repo = 'acme/app', ci: string | null = 'success') {
    this.repo = repo;
    this.ci = ci;
    const root = sha('root');
    this.refs.set('main', root);
    this.trees.set(root, new Map([['README.md', '# app\n']]));
  }

  tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  transport(account: string): Transport {
    return async (request) => {
      this.calls.push(request);
      return paged(request, this.route(account, request), ['check_runs', 'statuses']);
    };
  }

  mergeByHuman(number: number): void {
    const pr = this.prs.find((p) => p.number === number);
    if (pr === undefined || pr.state !== 'open') throw new Error(`no open PR ${number}`);
    pr.state = 'closed';
    pr.merged = true;
    pr.updated = this.tick();
    this.refs.set(pr.base, this.refs.get(pr.head) ?? '');
  }

  commitOn(branch: string, files: Record<string, string>, base = 'main'): string {
    const from = this.refs.get(branch) ?? this.refs.get(base) ?? '';
    const next = new Map(this.trees.get(from) ?? []);
    for (const [path, content] of Object.entries(files)) next.set(path, content);
    const commit = sha(`${from}|human|${this.next++}`);
    this.trees.set(commit, next);
    this.parents.set(commit, from);
    this.moveRef(branch, commit);
    return commit;
  }

  private treeOf(files: Map<string, string>): string {
    const tree = sha(`tree|${JSON.stringify([...files].sort())}`);
    this.treeFiles.set(tree, files);
    return tree;
  }

  private moveRef(branch: string, commit: string): void {
    this.refs.set(branch, commit);
    if (this.ci !== null) this.setStatus(commit, 'ci', this.ci);
    for (const pr of this.prs) if (pr.head === branch && pr.state === 'open') pr.updated = this.tick();
  }

  setStatus(headSha: string, context: string, state: string): void {
    this.statuses.push({ sha: headSha, context, state, at: this.tick() });
  }

  filesAt(branch: string): Map<string, string> {
    return new Map(this.trees.get(this.refs.get(branch) ?? '') ?? []);
  }

  private prObject(pr: Pr) {
    const repo = { full_name: this.repo };
    return {
      number: pr.number,
      html_url: `https://github.com/${this.repo}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      merged_at: pr.merged ? iso(pr.updated) : null,
      user: { login: pr.author },
      head: { ref: pr.head, sha: this.refs.get(pr.head) ?? '', repo },
      base: { ref: pr.base, sha: this.refs.get(pr.base) ?? '', repo },
      updated_at: iso(pr.updated),
    };
  }

  private reviewObject(r: Review) {
    return {
      id: r.id,
      user: { login: r.user },
      state: r.state,
      commit_id: r.commit,
      submitted_at: iso(r.at),
      body: r.body,
    };
  }

  private route(account: string, { method, path, body }: HttpRequest): HttpResponse {
    const ok = (b: unknown, status = 200): HttpResponse => ({ status, body: b });
    const fail = (status: number, message: string): HttpResponse => ({ status, body: { message } });
    const url = new URL(path, 'https://api.github.com');
    if (method === 'GET' && path === '/user') return ok({ login: account });
    const prefix = `/repos/${this.repo}`;
    if (!url.pathname.startsWith(prefix)) return fail(404, 'Not Found');
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    const input = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    m = method === 'GET' ? /^\/git\/ref\/heads\/(.+)$/.exec(rest) : null;
    if (m) {
      const ref = this.refs.get(m[1] ?? '');
      return ref === undefined ? fail(404, 'Not Found') : ok({ object: { sha: ref } });
    }
    if (method === 'POST' && rest === '/git/refs') {
      const name = String(input.ref).replace('refs/heads/', '');
      if (this.refs.has(name)) return fail(422, 'Reference already exists');
      if (!this.trees.has(String(input.sha))) return fail(422, 'Object does not exist');
      this.moveRef(name, String(input.sha));
      return ok({ ref: input.ref }, 201);
    }
    m = method === 'PATCH' ? /^\/git\/refs\/heads\/(.+)$/.exec(rest) : null;
    if (m) {
      const name = m[1] ?? '';
      const current = this.refs.get(name);
      const next = String(input.sha);
      if (current === undefined) return fail(422, 'Reference does not exist');
      if (input.force !== true && this.parents.get(next) !== current) return fail(422, 'Update is not a fast forward');
      this.moveRef(name, next);
      return ok({ ref: `refs/heads/${name}`, object: { sha: next } });
    }
    m = method === 'DELETE' ? /^\/git\/refs\/heads\/(.+)$/.exec(rest) : null;
    if (m) {
      const name = m[1] ?? '';
      if (!this.refs.delete(name)) return fail(422, 'Reference does not exist');
      return { status: 204, body: null };
    }
    m = method === 'GET' ? /^\/git\/commits\/([0-9a-f]+)$/.exec(rest) : null;
    if (m) {
      const files = this.trees.get(m[1] ?? '');
      return files === undefined ? fail(404, 'Not Found') : ok({ sha: m[1], tree: { sha: this.treeOf(files) } });
    }
    m = method === 'GET' ? /^\/git\/trees\/([0-9a-f]+)$/.exec(rest) : null;
    if (m) {
      const files = this.treeFiles.get(m[1] ?? '');
      if (files === undefined) return fail(404, 'Not Found');
      return ok({
        truncated: false,
        tree: [...files].map(([path, content]) => ({ path, type: 'blob', sha: blob(content) })),
      });
    }
    if (method === 'POST' && rest === '/git/trees') {
      const base = this.treeFiles.get(String(input.base_tree));
      if (base === undefined) return fail(422, 'base_tree is not a tree');
      const files = new Map(base);
      for (const entry of input.tree as Array<{ path: string; content: string }>) files.set(entry.path, entry.content);
      return ok({ sha: this.treeOf(files) }, 201);
    }
    if (method === 'POST' && rest === '/git/commits') {
      const files = this.treeFiles.get(String(input.tree));
      const [parent] = input.parents as string[];
      if (files === undefined || parent === undefined || !this.trees.has(parent)) return fail(422, 'bad commit');
      const commit = sha(`${input.tree}|${parent}|${input.message}|${this.next++}`);
      this.trees.set(commit, files);
      this.parents.set(commit, parent);
      return ok({ sha: commit }, 201);
    }
    m = method === 'GET' ? /^\/contents\/(.+)$/.exec(rest) : null;
    if (m) {
      const ref = url.searchParams.get('ref') ?? 'main';
      const current = this.trees.get(this.refs.get(ref) ?? ref)?.get(m[1] ?? '');
      return current === undefined
        ? fail(404, 'Not Found')
        : ok({ sha: blob(current), content: Buffer.from(current).toString('base64') });
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = url.searchParams.get('head')?.split(':')[1];
      const state = url.searchParams.get('state');
      return ok(
        this.prs
          .filter((p) => (head === undefined || p.head === head) && (state === 'all' || p.state === state))
          .map((p) => {
            const { merged: _merged, ...listed } = this.prObject(p);
            return listed;
          }),
      );
    }
    if (rest === '/pulls' && method === 'POST') {
      const head = String(input.head);
      if (!this.refs.has(head)) return fail(422, 'head branch does not exist');
      if (this.prs.some((p) => p.head === head && p.state === 'open'))
        return fail(422, `A pull request already exists for ${head}.`);
      const pr: Pr = {
        number: this.prs.length + 1,
        title: String(input.title),
        body: String(input.body),
        head,
        base: String(input.base),
        author: account,
        state: 'open',
        merged: false,
        draft: input.draft === true,
        updated: this.tick(),
      };
      this.prs.push(pr);
      return ok(this.prObject(pr), 201);
    }
    m = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest);
    if (m) {
      const pr = this.prs.find((p) => p.number === Number(m?.[1]));
      if (pr === undefined) return fail(404, 'Not Found');
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') return ok(this.prObject(pr));
      if (sub === '' && method === 'PATCH') {
        if (input.state === 'closed') pr.state = 'closed';
        pr.updated = this.tick();
        return ok(this.prObject(pr));
      }
      if (sub === '/merge') {
        this.mergeByHuman(pr.number);
        return ok({ merged: true });
      }
      if (sub === '/files' && method === 'GET') {
        const base = this.trees.get(this.refs.get(pr.base) ?? '') ?? new Map();
        const head = this.trees.get(this.refs.get(pr.head) ?? '') ?? new Map();
        return ok([
          ...[...head.entries()]
            .filter(([path, content]) => base.get(path) !== content)
            .map(([filename]) => ({ filename, status: base.has(filename) ? 'modified' : 'added' })),
          ...[...base.keys()].filter((path) => !head.has(path)).map((filename) => ({ filename, status: 'removed' })),
        ]);
      }
      if (sub === '/reviews' && method === 'GET')
        return ok(this.reviews.filter((r) => r.pr === pr.number).map((r) => this.reviewObject(r)));
      if (sub === '/reviews' && method === 'POST') {
        const event = String(input.event);
        if (event !== 'COMMENT' && account === pr.author)
          return fail(
            422,
            `Review Can not ${event === 'APPROVE' ? 'approve' : 'request changes on'} your own pull request`,
          );
        const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[event];
        if (state === undefined) return fail(422, 'bad event');
        const commit = this.trees.get(String(input.commit_id));
        if (commit === undefined) return fail(422, 'commit_id is not part of the pull request');
        const base = this.trees.get(this.refs.get(pr.base) ?? '') ?? new Map<string, string>();
        const comments = (input.comments ?? []) as Array<{ path: string; line: number; body: string }>;
        for (const c of comments) {
          const content = commit.get(c.path);
          if (content === undefined || !hunkLines(base.get(c.path), content).has(c.line))
            return { status: 422, body: UNRESOLVED_LINE };
        }
        const review: Review = {
          id: this.next++,
          pr: pr.number,
          user: account,
          state,
          commit: String(input.commit_id),
          body: String(input.body),
          at: this.tick(),
        };
        this.reviews.push(review);
        for (const c of comments)
          this.comments.push({
            id: this.next++,
            pr: pr.number,
            review: review.id,
            user: account,
            ...c,
            commit: review.commit,
            at: review.at,
          });
        return ok(this.reviewObject(review));
      }
      if (sub === '/comments' && method === 'GET')
        return ok(
          this.comments
            .filter((c) => c.pr === pr.number)
            .map((c) => ({
              id: c.id,
              pull_request_review_id: c.review,
              user: { login: c.user },
              path: c.path,
              line: this.refs.get(pr.head) === c.commit ? c.line : null,
              original_line: c.line,
              commit_id: c.commit,
              body: c.body,
              updated_at: iso(c.at),
            })),
        );
      return fail(404, 'Not Found');
    }
    m = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (m) {
      const pr = Number(m[1]);
      const shape = (c: { id: number; body: string; user: string }) => ({
        id: c.id,
        body: c.body,
        user: { login: c.user },
        html_url: `https://github.com/${this.repo}/pull/${pr}#issuecomment-${c.id}`,
      });
      if (method === 'GET') return ok(this.issueComments.filter((c) => c.pr === pr).map(shape));
      const posted = { id: this.next++, pr, user: account, body: String(input.body), at: this.tick() };
      this.issueComments.push(posted);
      return ok(shape(posted), 201);
    }
    m = method === 'POST' ? /^\/statuses\/([0-9a-f]{40})$/.exec(rest) : null;
    if (m) {
      const head = m[1] ?? '';
      if (!this.trees.has(head)) return fail(422, `No commit found for SHA: ${head}`);
      this.setStatus(head, String(input.context), String(input.state));
      return ok({ context: input.context, state: input.state, description: input.description ?? null }, 201);
    }
    m = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest);
    if (m) {
      const head = m[1];
      return ok({
        statuses: this.statuses
          .filter((s) => s.sha === head)
          .map((s) => ({ context: s.context, state: s.state, updated_at: iso(s.at) })),
      });
    }
    if (/^\/commits\/[0-9a-f]+\/check-runs$/.test(rest)) return ok({ check_runs: [] });
    return fail(404, `Not Found: ${method} ${rest}`);
  }
}
