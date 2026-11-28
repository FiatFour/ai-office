import { createHash } from 'node:crypto';
import type { HttpRequest, HttpResponse, Transport } from '../../githost/host.ts';
import { paged } from './page.ts';

interface Mr {
  iid: number;
  source: string;
  target: string;
  title: string;
  author: string;
  state: 'opened' | 'closed' | 'merged';
  updated: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const sha = (text: string) => createHash('sha1').update(text).digest('hex');

export class FakeGitlab {
  readonly repo: string;
  readonly calls: HttpRequest[] = [];
  readonly branches = new Map<string, { commit: string; files: Map<string, string> }>();
  readonly mrs: Mr[] = [];
  readonly notes: Array<{ id: number; iid: number; author: string; body: string; position: unknown; at: number }> = [];
  readonly approvals: Array<{ iid: number; user: string; id: number }> = [];
  private clock = Date.parse('2026-11-17T00:00:00Z');
  private next = 500;
  private readonly jobs: Array<{ id: number; sha: string; name: string; log: string }> = [];

  constructor(repo = 'acme/app') {
    this.repo = repo;
    this.branches.set('main', { commit: sha('root'), files: new Map([['README.md', '# app\n']]) });
  }

  tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  transport(account: string): Transport {
    return async (request) => {
      this.calls.push(request);
      return paged(request, this.route(account, request));
    };
  }

  /** A failed job of the commit's one pipeline, with its trace. */
  failJob(sha: string, name: string, log: string): void {
    this.jobs.push({ id: this.next++, sha, name, log });
  }

  private mrObject(mr: Mr) {
    return {
      iid: mr.iid,
      source_branch: mr.source,
      target_branch: mr.target,
      source_project_id: 7,
      target_project_id: 7,
      author: { username: mr.author },
      state: mr.state,
      sha: this.branches.get(mr.source)?.commit ?? '',
      web_url: `https://gitlab.com/${this.repo}/-/merge_requests/${mr.iid}`,
      updated_at: iso(mr.updated),
      diff_refs: {
        base_sha: sha('root'),
        start_sha: sha('root'),
        head_sha: this.branches.get(mr.source)?.commit ?? '',
      },
    };
  }

  private route(account: string, { method, path, body }: HttpRequest): HttpResponse {
    const ok = (b: unknown, status = 200): HttpResponse => ({ status, body: b });
    const fail = (status: number, message: string): HttpResponse => ({ status, body: { message } });
    if (method === 'GET' && path === '/user') return ok({ username: account });
    const url = new URL(path, 'https://gitlab.com');
    const prefix = `/projects/${encodeURIComponent(this.repo)}`;
    if (!url.pathname.startsWith(prefix)) return fail(404, '404 Project Not Found');
    const rest = url.pathname.slice(prefix.length);
    const input = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    m = method === 'GET' ? /^\/repository\/branches\/(.+)$/.exec(rest) : null;
    if (m) {
      const branch = this.branches.get(decodeURIComponent(m[1] ?? ''));
      return branch === undefined ? fail(404, '404 Branch Not Found') : ok({ commit: { id: branch.commit } });
    }
    m = method === 'GET' ? /^\/repository\/files\/([^/]+)(\/raw)?$/.exec(rest) : null;
    if (m) {
      const ref = url.searchParams.get('ref') ?? 'main';
      const branch = this.branches.get(ref) ?? [...this.branches.values()].find((b) => b.commit === ref);
      const content = branch?.files.get(decodeURIComponent(m[1] ?? ''));
      if (content === undefined) return fail(404, '404 File Not Found');
      return ok(
        m[2] === undefined ? { encoding: 'base64', content: Buffer.from(content).toString('base64') } : content,
      );
    }
    if (method === 'POST' && rest === '/repository/commits') {
      const name = String(input.branch);
      if (input.start_branch !== undefined && this.branches.has(name))
        return fail(400, `A branch called '${name}' already exists`);
      const from = this.branches.get(name) ?? this.branches.get(String(input.start_branch));
      if (from === undefined) return fail(400, 'no start branch');
      const files = new Map(from.files);
      for (const action of input.actions as Array<{ action: string; file_path: string; content: string }>) {
        if (action.action === 'create' && files.has(action.file_path)) return fail(400, 'file exists');
        files.set(action.file_path, action.content);
      }
      const commit = sha(`${from.commit}|${this.next++}`);
      this.branches.set(name, { commit, files });
      for (const mr of this.mrs) if (mr.source === name) mr.updated = this.tick();
      return ok({ id: commit }, 201);
    }
    if (rest === '/merge_requests' && method === 'GET') {
      const source = url.searchParams.get('source_branch');
      return ok(this.mrs.filter((mr) => mr.source === source && mr.state === 'opened').map((mr) => this.mrObject(mr)));
    }
    if (rest === '/merge_requests' && method === 'POST') {
      const source = String(input.source_branch);
      if (this.mrs.some((mr) => mr.source === source && mr.state === 'opened'))
        return fail(409, 'Another open merge request already exists for this source branch');
      const mr: Mr = {
        iid: this.mrs.length + 1,
        source,
        target: String(input.target_branch),
        title: String(input.title),
        author: account,
        state: 'opened',
        updated: this.tick(),
      };
      this.mrs.push(mr);
      return ok(this.mrObject(mr), 201);
    }
    m = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest);
    if (m) {
      const mr = this.mrs.find((x) => x.iid === Number(m?.[1]));
      if (mr === undefined) return fail(404, '404 Not found');
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') return ok(this.mrObject(mr));
      if (sub === '/diffs' && method === 'GET') {
        const base = this.branches.get(mr.target)?.files ?? new Map();
        const head = this.branches.get(mr.source)?.files ?? new Map();
        return ok(
          [...head.entries()]
            .filter(([path, content]) => base.get(path) !== content)
            .map(([path]) => ({ old_path: path, new_path: path, deleted_file: false })),
        );
      }
      if (sub === '/approvals')
        return ok({
          updated_at: iso(mr.updated),
          approved_by: this.approvals
            .filter((a) => a.iid === mr.iid)
            .map((a) => ({ user: { id: a.id, username: a.user } })),
        });
      if (sub === '/approve') {
        if (account === mr.author) return fail(401, 'author cannot approve');
        this.approvals.push({ iid: mr.iid, user: account, id: this.next++ });
        return ok({});
      }
      if (sub === '/discussions' || (sub === '/notes' && method === 'POST')) {
        const note = {
          id: this.next++,
          iid: mr.iid,
          author: account,
          body: String(input.body),
          position: input.position ?? null,
          at: this.tick(),
        };
        this.notes.push(note);
        return ok({ id: note.id, author: { username: account }, created_at: iso(note.at) }, 201);
      }
      if (sub === '/notes' && method === 'GET')
        return ok(
          this.notes
            .filter((n) => n.iid === mr.iid)
            .map((n) => ({
              id: n.id,
              system: false,
              author: { username: n.author },
              body: n.body,
              position: n.position,
              updated_at: iso(n.at),
            })),
        );
      if (sub === '/merge') {
        mr.state = 'merged';
        return ok(this.mrObject(mr));
      }
    }
    if (method === 'GET' && rest === '/pipelines') {
      const head = url.searchParams.get('sha');
      const status = this.jobs.some((j) => j.sha === head) ? 'failed' : 'success';
      return ok([{ id: 9, sha: head, status, updated_at: iso(this.clock) }]);
    }
    if (method === 'GET' && rest === '/pipelines/9/jobs')
      return ok(this.jobs.map((j) => ({ id: j.id, name: j.name, status: 'failed', allow_failure: false })));
    m = method === 'GET' ? /^\/jobs\/(\d+)\/trace$/.exec(rest) : null;
    if (m) {
      const job = this.jobs.find((j) => j.id === Number(m?.[1]));
      return job === undefined ? fail(404, '404 Not found') : ok(job.log);
    }
    return fail(404, `404 Not Found: ${method} ${rest}`);
  }
}
