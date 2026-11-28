import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { CheckState, HostChangeState, PollEvent, Verdict, WebhookEvent } from '@agent-works/core';
import { runBinary } from '../sandbox/engine.ts';
import { BRANCH, bodyProblem, inlineCode, LINE_BREAK, MAX_BODY } from './sanitize.ts';

export type HostId = 'github' | 'gitlab';
export type HostCheckState = CheckState | 'skipped';

interface Source {
  readonly host: HostId;
  readonly repo: string;
  readonly at: number;
}

export type HostEvent =
  | (Omit<Source, 'at'> & {
      readonly kind: 'push';
      readonly ref: string;
      readonly headSha: string;
      readonly deleted: boolean;
      readonly at: number | null;
    })
  | (Source & {
      readonly kind: 'change';
      readonly headRepo: string;
      readonly number: number;
      readonly branch: string;
      readonly author: string;
      readonly state: HostChangeState;
      readonly headSha: string;
      readonly url: string;
    })
  | (Source & {
      readonly kind: 'review';
      readonly number: number;
      readonly reviewId: string;
      readonly reviewer: string;
      readonly verdict: Verdict | null;
      readonly commitId: string;
      readonly body: string;
    })
  | (Source & {
      readonly kind: 'review_comment';
      readonly number: number;
      readonly commentId: string;
      readonly reviewId: string | null;
      readonly author: string;
      readonly path: string | null;
      readonly line: number | null;
      readonly commitId: string | null;
      readonly body: string;
    })
  | (Source & {
      readonly kind: 'check';
      readonly headSha: string;
      readonly name: string;
      readonly state: HostCheckState;
    });

export type ChangeFact = Extract<HostEvent, { kind: 'change' }>;
export type ReviewFact = Extract<HostEvent, { kind: 'review' }>;
export type CommentFact = Extract<HostEvent, { kind: 'review_comment' }>;
export type CheckFact = Extract<HostEvent, { kind: 'check' }>;

export interface CheckFailure {
  readonly name: string;
  /** A bounded excerpt of the job's output with secrets removed, or null when the host gave none. It is untrusted text. */
  readonly output: string | null;
}

/** How many failing jobs have their output read, and how many are named at all. */
export const MAX_LOGS = 3;
export const MAX_FAILURES = 20;

export interface ChangeSnapshot {
  readonly change: ChangeFact;
  readonly reviews: readonly ReviewFact[];
  readonly checks: readonly CheckFact[];
}

export interface FileEdit {
  readonly path: string;
  readonly content: string;
}

export interface HeadFile {
  readonly path: string;
  readonly content: string | null;
}

/** One file of a commit's tree, as git names it. A submodule has no entry. */
export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  /** The git blob id. */
  readonly sha: string;
}

export interface HeadTree {
  readonly entries: readonly TreeEntry[];
  read(sha: string): Promise<Buffer>;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export const textOf = (bytes: Buffer): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
};

export const contentText = (got: unknown): string | null => textOf(Buffer.from(str(got, 'content'), 'base64'));

export interface LineComment {
  readonly path: string | null;
  readonly line: number | null;
  readonly body: string;
}

export interface PlacedComment extends LineComment {
  readonly path: string;
  readonly line: number;
}

export const isPlaced = (c: LineComment): c is PlacedComment => c.path !== null && c.line !== null;

export const DROPPED_MARK = '<!-- agent-works:comments-in-body -->';

export const carriedList = (prefix: string, why: string, comments: readonly LineComment[]): string => {
  const head = `${prefix}\n\n${DROPPED_MARK}\n${why}`;
  const tail = (left: number) => `\n\n(${left} more comments do not fit in a review body and are left out.)`;
  const room = MAX_BODY - tail(comments.length).length;
  let out = head;
  let kept = 0;
  for (const c of comments) {
    const spot =
      c.path === null ? (c.line === null ? null : `line ${c.line}`) : c.line === null ? c.path : `${c.path}:${c.line}`;
    const where = spot === null ? '' : `${inlineCode(spot)}\n`;
    const next = `${out}\n\n${where}${c.body}`;
    if (next.length > room) break;
    out = next;
    kept += 1;
  }
  return kept === comments.length ? out : `${out}${tail(comments.length - kept)}`;
};

export interface ReviewDraft {
  readonly commitId: string;
  readonly verdict: Verdict;
  readonly body: string;
  readonly comments: readonly LineComment[];
}

export interface PostedComment {
  readonly id: string;
  readonly url: string;
}

export interface GitHost {
  readonly id: HostId;
  login(): Promise<string>;
  findChange(repo: string, branch: string): Promise<ChangeFact | null>;
  openChange(repo: string, spec: { branch: string; base: string; title: string; body: string }): Promise<ChangeFact>;
  pushFiles(
    repo: string,
    spec: { branch: string; base: string; files: readonly FileEdit[]; message: string },
  ): Promise<string>;
  snapshot(repo: string, number: number): Promise<ChangeSnapshot>;
  /** The failing checks of a commit. Listing them may throw; reading one job's output never does. */
  failures(repo: string, headSha: string): Promise<CheckFailure[]>;
  comments(repo: string, number: number): Promise<CommentFact[]>;
  paths(repo: string, number: number): Promise<string[]>;
  files(repo: string, number: number, headSha: string): Promise<HeadFile[]>;
  /** Every file of a commit. It throws when the host cannot list them all. */
  tree(repo: string, sha: string): Promise<TreeEntry[]>;
  blob(repo: string, sha: string): Promise<Buffer>;
  postReview(repo: string, number: number, review: ReviewDraft): Promise<ReviewFact>;
  findComment(repo: string, number: number, marker: string): Promise<PostedComment | null>;
  postComment(repo: string, number: number, body: string): Promise<PostedComment>;
}

export class PayloadError extends Error {
  readonly path: string;
  constructor(path: string, problem = 'is missing or has the wrong type') {
    super(`payload ${path} ${problem}`);
    this.path = path;
  }
}

export const field = (body: unknown, path: string): unknown => {
  let value = body;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw new PayloadError(path);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

export const str = (body: unknown, path: string): string => {
  const value = field(body, path);
  if (typeof value !== 'string') throw new PayloadError(path);
  return value;
};

export const optStr = (body: unknown, path: string): string | null => {
  const value = field(body, path);
  return value === null ? null : str(body, path);
};

export const count = (body: unknown, path: string): number => {
  const value = field(body, path);
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new PayloadError(path, 'is not a positive integer');
  return value as number;
};

export const optLine = (body: unknown, path: string): number | null =>
  field(body, path) === null ? null : count(body, path);

export const bool = (body: unknown, path: string): boolean => {
  const value = field(body, path);
  if (typeof value !== 'boolean') throw new PayloadError(path);
  return value;
};

export const id = (body: unknown, path: string): string => {
  const value = field(body, path);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value !== '') return value;
  throw new PayloadError(path);
};

export const oneOf = <T>(body: unknown, path: string, table: Readonly<Record<string, T>>): T => {
  const value = str(body, path);
  if (!Object.hasOwn(table, value)) throw new PayloadError(path, `has unknown value ${JSON.stringify(value)}`);
  return table[value] as T;
};

const GITLAB_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;

export const time = (body: unknown, path: string): number => {
  const value = field(body, path);
  const ms =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? value * 1000
      : typeof value === 'string'
        ? Date.parse(value.replace(GITLAB_UTC, '$1T$2Z'))
        : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) throw new PayloadError(path, 'is not a host timestamp');
  return ms;
};

export const firstTime = (body: unknown, ...paths: string[]): number => {
  for (const path of paths) {
    const value = field(body, path);
    if (value !== null) return time(body, path);
  }
  throw new PayloadError(paths.join(' or '), 'is not a host timestamp');
};

export const ZERO_SHA = /^0{40}$/;

export const toFact = (event: HostEvent): WebhookEvent | null => {
  if (event.kind === 'change') {
    const { repo, headRepo, number, branch, author, state, headSha, at } = event;
    return { source: 'webhook', kind: 'change', repo, headRepo, number, branch, author, state, headSha, at };
  }
  if (event.kind === 'review') {
    if (event.verdict === null) return null;
    const { repo, number, reviewer, verdict, commitId, at } = event;
    return { source: 'webhook', kind: 'review', repo, number, reviewer, verdict, headSha: commitId, at };
  }
  if (event.kind === 'check') {
    const state = event.state === 'skipped' ? 'pending' : event.state;
    return {
      source: 'webhook',
      kind: 'check',
      repo: event.repo,
      headSha: event.headSha,
      name: event.name,
      state,
      at: event.at,
    };
  }
  return null;
};

export const toPoll = (snapshot: ChangeSnapshot): PollEvent => {
  const { repo, headRepo, number, branch, author, state, headSha, at } = snapshot.change;
  const latest = new Map<string, ReviewFact>();
  for (const review of snapshot.reviews) {
    if (review.commitId !== headSha || review.verdict === null) continue;
    const seen = latest.get(review.reviewer);
    if (seen === undefined || review.at >= seen.at) latest.set(review.reviewer, review);
  }
  return {
    source: 'poll',
    repo,
    headRepo,
    number,
    branch,
    author,
    state,
    headSha,
    at,
    checks: snapshot.checks
      .filter((check) => check.headSha === headSha)
      .map((check) => ({ name: check.name, state: check.state === 'skipped' ? 'pending' : check.state })),
    reviews: [...latest.values()].map((review) => ({ reviewer: review.reviewer, verdict: review.verdict as Verdict })),
  };
};

/**
 * The checks of the head that failed, once none is still running: one fix round then answers every failure. A skipped
 * check does not run, so it holds nothing back.
 */
export const redChecks = ({ change, checks }: ChangeSnapshot): string[] => {
  const head = checks.filter((check) => check.headSha === change.headSha);
  if (head.some((check) => check.state === 'pending')) return [];
  return head.filter((check) => check.state === 'failure').map((check) => check.name);
};

export const outputOf = async (read: () => Promise<string | null>): Promise<string | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

export const signatureValid = (secret: string, raw: Buffer, header: string | undefined): boolean => {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export interface ApiCall {
  readonly ts: string;
  readonly host: HostId;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
}

export interface Scope {
  readonly home: string;
  readonly base: string;
}

export interface WriteRule {
  readonly method: HttpRequest['method'];
  readonly path: RegExp;
  readonly keys: readonly string[];
  readonly body?: (body: Record<string, unknown>, scope: Scope) => string | null;
}

export class HostError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(request: HttpRequest, status: number, body: unknown) {
    super(`${request.method} ${request.path} -> ${status} ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class WriteRefused extends Error {}

export const orNull = async <T>(pending: Promise<T>): Promise<T | null> => {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof HostError && error.status === 404) return null;
    throw error;
  }
};

const TEXT_KEYS = ['body', 'title', 'description', 'message', 'commit_message'] as const;
const ONE_LINE: ReadonlySet<string> = new Set(['title', 'message', 'commit_message']);

const textProblem = (o: Record<string, unknown>): string | null => {
  const texts: Array<[string, unknown]> = TEXT_KEYS.filter((key) => o[key] !== undefined).map((key) => [key, o[key]]);
  if (o.comments !== undefined) {
    if (!Array.isArray(o.comments)) return 'comments is not a list';
    texts.push(...o.comments.map((c, i): [string, unknown] => [`comments.${i}.body`, (c as { body?: unknown })?.body]));
  }
  for (const [key, value] of texts) {
    if (typeof value !== 'string') return `${key} is not text`;
    if (ONE_LINE.has(key) && LINE_BREAK.test(value)) return `${key} spans more than one line`;
    const problem = bodyProblem(value);
    if (problem !== null) return `${key} ${problem}`;
  }
  return null;
};

export const filePathProblem = (path: unknown): string | null =>
  typeof path === 'string' &&
  path.split('/').every((segment) => segment !== '' && !segment.startsWith('.') && !/[\\\p{Cc}]/u.test(segment))
    ? null
    : `the file path ${JSON.stringify(path)} is empty, hidden or holds a backslash`;

export const branchProblem = (branch: unknown): string | null =>
  typeof branch === 'string' && BRANCH.test(branch)
    ? null
    : `the branch ${JSON.stringify(branch)} is not aw/<factory>/<task>`;

export const unknownKey = (o: unknown, keys: readonly string[]): string | null => {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return 'an entry is not an object';
  const extra = Object.keys(o).find((key) => !keys.includes(key));
  return extra === undefined ? null : `the key ${JSON.stringify(extra)} is not allowed here`;
};

export const writeProblem = (rules: readonly WriteRule[], request: HttpRequest, scope: Scope): string | null => {
  const { method, path } = request;
  const { pathname, search } = new URL(path, 'https://host.invalid');
  if (path !== '/user' && !path.startsWith(`${scope.home}/`))
    return `it names a repository other than the configured ${scope.home}`;
  if (method === 'GET') return pathname + search === path ? null : 'the path is not in normal form';
  if (pathname !== path) return 'a write path may not hold a query, a fragment or a dot segment';
  const tail = pathname.slice(scope.home.length);
  const rule = rules.find((r) => r.method === method && r.path.test(tail));
  if (rule === undefined) return 'it is outside the allowlist';
  const body = request.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'the body is not an object';
  const o = body as Record<string, unknown>;
  return unknownKey(o, rule.keys) ?? textProblem(o) ?? rule.body?.(o, scope) ?? null;
};

export const guard = (
  host: HostId,
  rules: readonly WriteRule[],
  scope: Scope,
  send: Transport,
  log: (call: ApiCall) => void,
): ((request: HttpRequest) => Promise<unknown>) => {
  return async (request) => {
    const problem = writeProblem(rules, request, scope);
    if (problem !== null) throw new WriteRefused(`refusing ${request.method} ${request.path} on ${host}: ${problem}`);
    const started = performance.now();
    const response = await send(request);
    log({
      ts: new Date().toISOString(),
      host,
      method: request.method,
      path: request.path,
      status: response.status,
      ms: Math.round(performance.now() - started),
    });
    if (response.status >= 400) throw new HostError(request, response.status, response.body);
    return response.body;
  };
};

const PAGE_SIZE = 100;
const MAX_ITEMS = 5_000;

export const allPages = async (
  get: (path: string) => Promise<unknown>,
  path: string,
  items: (body: unknown) => unknown[] = (body) => body as unknown[],
  max = MAX_ITEMS,
): Promise<unknown[]> => {
  const all: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const list = items(await get(`${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`));
    all.push(...list);
    if (all.length > max) throw new Error(`${path} lists more than ${max} items`);
    if (list.length < PAGE_SIZE) return all;
  }
};

export const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let made: Promise<T> | null = null;
  return () => {
    made ??= make().catch((error: unknown) => {
      made = null;
      throw error;
    });
    return made;
  };
};

export const fileLog =
  (path: string) =>
  (call: ApiCall): void =>
    appendFileSync(path, `${JSON.stringify(call)}\n`);

const ESCAPES_FLAG = '--allow-escape-sequences';

export const cliTransport =
  (cli: 'gh' | 'glab', hostname?: string): Transport =>
  async (request) => {
    const args = ['api', '--include', '-X', request.method, request.path];
    if (hostname !== undefined) args.push('--hostname', hostname);
    if (request.body !== undefined) args.push('--input', '-');
    const run = (extra: readonly string[]) =>
      runBinary(cli, [...args, ...extra], {
        input: request.body === undefined ? '' : JSON.stringify(request.body),
        timeoutMs: 60_000,
      });
    let ran = await run([]);
    // A newer gh prints no body that holds colour codes, as a job log does, unless asked. An older gh lacks the flag.
    if (request.method === 'GET' && ran.err.includes(ESCAPES_FLAG)) ran = await run([ESCAPES_FLAG]);
    const split = ran.out.search(/\r?\n\r?\n/);
    const head = split < 0 ? ran.out : ran.out.slice(0, split);
    const rest = split < 0 ? '' : ran.out.slice(split).trim();
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0);
    if (status === 0)
      throw new Error(
        `${cli} api ${request.path} gave no HTTP status${ran.timedOut ? ' (timed out)' : ''}: ${ran.err.trim().slice(0, 300)}`,
      );
    try {
      return { status, body: rest === '' ? null : JSON.parse(rest) };
    } catch {
      return { status, body: rest };
    }
  };
