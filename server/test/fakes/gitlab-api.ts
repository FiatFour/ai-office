import { createHash } from 'node:crypto';
import type { HttpRequest, HttpResponse, Transport } from '../../githost/host.ts';

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
      return this.route(account, request);
    };
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
    m = method === 'GET' ? /^\/repository\/files\/(.+)\/raw$/.exec(rest) : null;
    if (m) {
      const branch = this.branches.get(url.searchParams.get('ref') ?? 'main');
      const content = branch?.files.get(decodeURIComponent(m[1] ?? ''));
      return content === undefined ? fail(404, '404 File Not Found') : ok(content);
    }
    if (method === 'POST' && rest === '/repository/commits') {
      const name = String(input.branch);
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
    if (method === 'GET' && rest === '/pipelines') return ok([]);
    return fail(404, `404 Not Found: ${method} ${rest}`);
  }
}
