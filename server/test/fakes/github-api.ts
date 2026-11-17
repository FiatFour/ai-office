import { createHash } from 'node:crypto';
import type { HttpRequest, HttpResponse, Transport } from '../../githost/host.ts';

interface Pr {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  author: string;
  state: 'open' | 'closed';
  merged: boolean;
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

export class FakeGithub {
  readonly repo: string;
  readonly calls: HttpRequest[] = [];
  readonly refs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly prs: Pr[] = [];
  readonly reviews: Review[] = [];
  readonly comments: Comment[] = [];
  readonly issueComments: Array<{ id: number; pr: number; user: string; body: string; at: number }> = [];
  readonly statuses: Array<{ sha: string; context: string; state: string; at: number }> = [];
  private clock = Date.parse('2026-11-17T00:00:00Z');
  private next = 100;

  constructor(repo = 'acme/app') {
    this.repo = repo;
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
      return this.route(account, request);
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
      this.refs.set(name, String(input.sha));
      return ok({ ref: input.ref }, 201);
    }
    m = /^\/contents\/(.+)$/.exec(rest);
    if (m) {
      const file = m[1] ?? '';
      const branch = method === 'GET' ? (url.searchParams.get('ref') ?? 'main') : String(input.branch);
      const head = this.refs.get(branch);
      if (head === undefined) return fail(404, 'No such branch');
      const tree = this.trees.get(head) ?? new Map();
      const current = tree.get(file);
      if (method === 'GET') return current === undefined ? fail(404, 'Not Found') : ok({ sha: blob(current) });
      if (method !== 'PUT') return fail(405, 'Method Not Allowed');
      if (current !== undefined && input.sha !== blob(current)) return fail(409, 'sha does not match');
      const next = new Map(tree);
      next.set(file, Buffer.from(String(input.content), 'base64').toString('utf8'));
      const commit = sha(`${head}|${file}|${input.content}|${this.next++}`);
      this.trees.set(commit, next);
      this.refs.set(branch, commit);
      for (const pr of this.prs) if (pr.head === branch && pr.state === 'open') pr.updated = this.tick();
      return ok({ commit: { sha: commit } }, current === undefined ? 201 : 200);
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
      if (sub === '/merge') {
        this.mergeByHuman(pr.number);
        return ok({ merged: true });
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
        for (const c of (input.comments ?? []) as Array<{ path: string; line: number; body: string }>)
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
              line: c.line,
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
