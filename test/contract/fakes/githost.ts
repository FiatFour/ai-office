import { createHash } from 'node:crypto';
import { logExcerpt } from '../../../server/githost/ci-log.ts';
import type {
  ApiCall,
  ChangeFact,
  ChangeSnapshot,
  CheckFailure,
  CommentFact,
  FileEdit,
  GitHost,
  HeadFile,
  PostedComment,
  ReviewDraft,
  ReviewFact,
} from '../../../server/githost/host.ts';
import { WriteRefused } from '../../../server/githost/host.ts';
import type { GithostSubject, Payload } from '../githost.contract.ts';

export type HostFault =
  | 'rewrites-on-repeat'
  | 'two-moves-per-round'
  | 'review-loses-commit'
  | 'binary-as-text'
  | 'marker-by-prefix'
  | 'one-page-only'
  | 'any-branch'
  | 'merges'
  | 'login-drifts'
  | 'foreign-marker-trusted'
  | 'hides-failures'
  | 'raw-logs';

interface Branch {
  head: string;
  files: Map<string, string>;
}

const sha = (text: string) => createHash('sha1').update(text).digest('hex');
const PAGE = 100;

class World {
  readonly branches = new Map<string, Branch>([['main', { head: sha('root'), files: new Map() }]]);
  readonly changes: ChangeFact[] = [];
  readonly reviews: ReviewFact[] = [];
  readonly comments: Array<{ number: number; author: string; id: string; body: string }> = [];
  readonly calls: ApiCall[] = [];
  readonly lines: CommentFact[] = [];
  readonly red: Array<{ headSha: string; name: string; log: string }> = [];
  clock = Date.parse('2026-11-22T00:00:00Z');
  next = 1;
}

const call = (world: World, method: string, path: string) => {
  world.clock += 1000;
  world.calls.push({ ts: new Date(world.clock).toISOString(), host: 'github', method, path, status: 200, ms: 1 });
};

export class MemoryHost implements GitHost {
  readonly id = 'github' as const;
  private logins = 0;

  constructor(
    private readonly world: World,
    private readonly account: string,
    private readonly faults: ReadonlySet<HostFault>,
  ) {}

  async login(): Promise<string> {
    this.logins += 1;
    return this.faults.has('login-drifts') && this.logins > 1 ? `${this.account}${this.logins}` : this.account;
  }

  async findChange(_repo: string, branch: string): Promise<ChangeFact | null> {
    call(this.world, 'GET', `/pulls?head=${branch}`);
    return this.world.changes.find((c) => c.branch === branch) ?? null;
  }

  async openChange(
    repo: string,
    spec: { branch: string; base: string; title: string; body: string },
  ): Promise<ChangeFact> {
    call(this.world, 'POST', '/pulls');
    const head = this.world.branches.get(spec.branch)?.head ?? '';
    const change: ChangeFact = {
      host: 'github',
      repo,
      kind: 'change',
      headRepo: repo,
      number: this.world.next,
      branch: spec.branch,
      author: this.account,
      state: 'open',
      headSha: head,
      url: `https://example.test/${repo}/pull/${this.world.next}`,
      at: this.world.clock,
    };
    this.world.next += 1;
    this.world.changes.push(change);
    return change;
  }

  async pushFiles(
    _repo: string,
    spec: { branch: string; base: string; files: readonly FileEdit[]; message: string },
  ): Promise<string> {
    if (!this.faults.has('any-branch') && !/^aw\/[\w-]+\/[\w-]+$/.test(spec.branch))
      throw new WriteRefused(spec.branch);
    const existing = this.world.branches.get(spec.branch);
    const files = new Map(existing?.files ?? this.world.branches.get(spec.base)?.files ?? []);
    const before = new Map(files);
    for (const f of spec.files) files.set(f.path, f.content);
    const same = [...files].every(([path, content]) => before.get(path) === content) && files.size === before.size;
    if (existing !== undefined && same && !this.faults.has('rewrites-on-repeat')) return existing.head;
    const head = sha([...files].join('\0') + spec.message + this.world.next + this.world.clock);
    call(this.world, 'POST', '/git/commits');
    call(this.world, 'PATCH', `/git/refs/heads/${spec.branch}`);
    if (this.faults.has('two-moves-per-round')) call(this.world, 'PATCH', `/git/refs/heads/${spec.branch}`);
    this.world.branches.set(spec.branch, { head, files });
    const change = this.world.changes.find((c) => c.branch === spec.branch);
    if (change !== undefined) this.world.changes[this.world.changes.indexOf(change)] = { ...change, headSha: head };
    return head;
  }

  async snapshot(_repo: string, number: number): Promise<ChangeSnapshot> {
    call(this.world, 'GET', `/pulls/${number}`);
    if (this.faults.has('merges')) call(this.world, 'PUT', `/pulls/${number}/merge`);
    const change = this.world.changes.find((c) => c.number === number) as ChangeFact;
    const checks = this.world.red
      .filter((c) => c.headSha === change.headSha)
      .map(({ headSha, name }) => ({
        host: 'github' as const,
        kind: 'check' as const,
        repo: change.repo,
        headSha,
        name,
        state: 'failure' as const,
        at: this.world.clock,
      }));
    return { change, reviews: this.world.reviews.filter((r) => r.number === number), checks };
  }

  async failures(_repo: string, headSha: string): Promise<CheckFailure[]> {
    call(this.world, 'GET', `/commits/${headSha}/check-runs`);
    if (this.faults.has('hides-failures')) return [];
    return this.world.red
      .filter((c) => c.headSha === headSha)
      .map(({ name, log }) => ({ name, output: this.faults.has('raw-logs') ? log : logExcerpt(log) }));
  }

  async comments(_repo: string, number: number): Promise<CommentFact[]> {
    call(this.world, 'GET', `/pulls/${number}/comments`);
    const all = this.world.lines.filter((c) => c.number === number);
    return this.faults.has('one-page-only') ? all.slice(0, PAGE) : all;
  }

  async paths(_repo: string, number: number): Promise<string[]> {
    call(this.world, 'GET', `/pulls/${number}/files`);
    const change = this.world.changes.find((c) => c.number === number) as ChangeFact;
    const base = this.world.branches.get('main')?.files ?? new Map();
    const all = [...(this.world.branches.get(change.branch)?.files.keys() ?? [])].filter((p) => !base.has(p));
    return this.faults.has('one-page-only') ? all.slice(0, PAGE) : all;
  }

  async files(_repo: string, number: number, headSha: string): Promise<HeadFile[]> {
    const change = this.world.changes.find((c) => c.number === number) as ChangeFact;
    void headSha;
    const branch = this.world.branches.get(change.branch);
    const paths = await this.paths(_repo, number);
    return paths.map((path) => {
      const content = branch?.files.get(path) ?? '';
      return { path, content: content.includes('\0') && !this.faults.has('binary-as-text') ? null : content };
    });
  }

  async postReview(_repo: string, number: number, review: ReviewDraft): Promise<ReviewFact> {
    call(this.world, 'POST', `/pulls/${number}/reviews`);
    const id = String(this.world.next++);
    const fact: ReviewFact = {
      host: 'github',
      repo: _repo,
      kind: 'review',
      number,
      reviewId: id,
      reviewer: this.account,
      verdict: review.verdict,
      commitId: this.faults.has('review-loses-commit') ? sha('other') : review.commitId,
      body: review.body,
      at: this.world.clock,
    };
    this.world.reviews.push(fact);
    for (const c of review.comments)
      this.world.lines.push({
        host: 'github',
        repo: _repo,
        kind: 'review_comment',
        number,
        commentId: String(this.world.next++),
        reviewId: id,
        author: this.account,
        path: c.path,
        line: c.line,
        commitId: review.commitId,
        body: c.body,
        at: this.world.clock,
      });
    return fact;
  }

  async findComment(_repo: string, number: number, marker: string): Promise<PostedComment | null> {
    call(this.world, 'GET', `/issues/${number}/comments`);
    const hit = this.world.comments.find(
      (c) =>
        c.number === number &&
        (this.faults.has('foreign-marker-trusted') || c.author.toLowerCase() === this.account.toLowerCase()) &&
        (this.faults.has('marker-by-prefix') ? c.body.includes(marker.slice(0, -6)) : c.body.includes(marker)),
    );
    return hit === undefined ? null : { id: hit.id, url: `https://example.test/c/${hit.id}` };
  }

  async postComment(_repo: string, number: number, body: string): Promise<PostedComment> {
    call(this.world, 'POST', `/issues/${number}/comments`);
    const id = String(this.world.next++);
    this.world.comments.push({ number, author: this.account, id, body });
    return { id, url: `https://example.test/c/${id}` };
  }
}

export const memorySubject = (
  faults: readonly HostFault[] = [],
  payloads: readonly Payload[] = [],
  has: readonly string[] = ['second-account', 'bulk-writes', 'failing-checks'],
): GithostSubject => {
  const world = new World();
  const set = new Set(faults);
  const as = (account: string) => new MemoryHost(world, account, new Set());
  return {
    has: new Set(has),
    host: 'github',
    repo: 'acme/app',
    author: new MemoryHost(world, 'aw-bot', set),
    reviewer: new MemoryHost(world, 'aw-reviewer', set),
    as,
    calls: world.calls,
    merges: () => world.calls.filter((c) => /\/merge$/.test(c.path)).length,
    payloads,
    firstNumber: 1,
    exactLogin: true,
    branch: (tag) => `aw/alpha/${tag}`,
    fail: (headSha, name, log) => world.red.push({ headSha, name, log }),
  };
};
