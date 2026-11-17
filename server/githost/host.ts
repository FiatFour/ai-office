import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { CheckState, HostChangeState, PollEvent, Verdict, WebhookEvent } from '@agent-works/core';

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

export interface ChangeSnapshot {
  readonly change: ChangeFact;
  readonly reviews: readonly ReviewFact[];
  readonly checks: readonly CheckFact[];
}

export interface FileEdit {
  readonly path: string;
  readonly content: string;
}

export interface LineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

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
  detect(remote: string): boolean;
  parseDelivery(event: string, body: unknown): HostEvent | null;
  findChange(repo: string, branch: string): Promise<ChangeFact | null>;
  openChange(repo: string, spec: { branch: string; base: string; title: string; body: string }): Promise<ChangeFact>;
  pushFiles(
    repo: string,
    spec: { branch: string; base: string; files: readonly FileEdit[]; message: string },
  ): Promise<string>;
  snapshot(repo: string, number: number): Promise<ChangeSnapshot>;
  comments(repo: string, number: number): Promise<CommentFact[]>;
  files(repo: string, number: number, headSha: string): Promise<FileEdit[]>;
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

export type WriteRule = readonly [method: HttpRequest['method'], pattern: RegExp];

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

export const writeAllowed = (rules: readonly WriteRule[], request: HttpRequest, encodedPrefix?: RegExp): boolean => {
  const { method, path } = request;
  const { pathname, search } = new URL(path, 'https://host.invalid');
  if (method === 'GET') return pathname + search === path;
  if (pathname !== path || /%2e|%5c/i.test(path)) return false;
  if (/%2f/i.test(path.replace(encodedPrefix ?? /^$/, ''))) return false;
  return rules.some(([m, pattern]) => m === method && pattern.test(pathname));
};

export const guard = (
  host: HostId,
  rules: readonly WriteRule[],
  send: Transport,
  log: (call: ApiCall) => void,
  encodedPrefix?: RegExp,
): ((request: HttpRequest) => Promise<unknown>) => {
  return async (request) => {
    if (!writeAllowed(rules, request, encodedPrefix))
      throw new WriteRefused(`refusing a call outside the ${host} allowlist: ${request.method} ${request.path}`);
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

export const fileLog =
  (path: string) =>
  (call: ApiCall): void =>
    appendFileSync(path, `${JSON.stringify(call)}\n`);

export const cliTransport =
  (cli: 'gh' | 'glab', hostname?: string): Transport =>
  (request) =>
    new Promise((resolve, reject) => {
      const args = ['api', '--include', '-X', request.method, request.path];
      if (hostname !== undefined) args.push('--hostname', hostname);
      if (request.body !== undefined) args.push('--input', '-');
      const child = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.on('error', reject);
      child.on('close', () => {
        const text = Buffer.concat(out).toString('utf8');
        const split = text.search(/\r?\n\r?\n/);
        const head = split < 0 ? text : text.slice(0, split);
        const rest = split < 0 ? '' : text.slice(split).trim();
        const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0);
        if (status === 0) return reject(new Error(`${cli} api ${request.path} gave no HTTP status`));
        let body: unknown = rest;
        try {
          body = rest === '' ? null : JSON.parse(rest);
        } catch {}
        resolve({ status, body });
      });
      child.stdin.end(request.body === undefined ? '' : JSON.stringify(request.body));
    });
