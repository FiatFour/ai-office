import { setTimeout as sleep } from 'node:timers/promises';
import {
  type AlertReason,
  type Box,
  branchOf,
  type Change,
  type CommandKind,
  type Event,
  type State,
  type TaskId,
  toLogin,
  type Verdict,
} from '@agent-works/core';
import type { AgentRuntime, RuntimeId, Ticket, Usage } from '../agents/runtime.ts';
import { briefMarker, mergeBrief, type ReviewRound, renderBrief } from '../brief/merge-brief.ts';
import { InvalidEvent } from '../events.ts';
import {
  type ChangeSnapshot,
  type CommentFact,
  DROPPED_MARK,
  type GitHost,
  HostError,
  type LineComment,
  type ReviewDraft,
  type ReviewFact,
  toPoll,
} from '../githost/host.ts';
import { inlineCode, plainLine, quoteBlock, TASK_ID, unquote } from '../githost/sanitize.ts';
import type { Executor } from '../hq.ts';
import type { Denial } from '../sandbox/firewall.ts';
import { siteOf } from '../sandbox/site.ts';
import { canonicalJson } from '../store/atomic.ts';
import type { LoggedEvent, OutboxEntry } from '../store/store.ts';

export interface HqPort {
  state(): State;
  ingest(event: Event): void;
  outbox(): readonly OutboxEntry[];
  events(after: number): readonly LoggedEvent[];
  changed(): void;
}

export type ActionItem =
  | { readonly kind: 'ready_to_merge'; readonly task: TaskId; readonly url: string; readonly brief: string }
  | { readonly kind: 'round_limit'; readonly task: TaskId; readonly url: string; readonly fixRounds: number }
  | {
      readonly kind: 'website';
      readonly site: string;
      readonly host: string;
      readonly port: number;
      readonly agent: string;
      readonly count: number;
      readonly allow: boolean;
    }
  | { readonly kind: 'alert'; readonly reason: AlertReason; readonly subject: string }
  | { readonly kind: 'job_failed'; readonly task: TaskId; readonly job: string; readonly error: string };

export interface ModeView {
  readonly rounds: Readonly<Record<TaskId, number>>;
  readonly usage: Readonly<Record<TaskId, readonly (Usage | null)[]>>;
  readonly jobs: readonly string[];
  readonly reviewGap: string | null;
}

export interface Mode {
  readonly executors: Partial<Record<CommandKind, Executor>>;
  actions(): ActionItem[];
  view(): ModeView;
  route(method: string, path: string, body: () => Promise<unknown>): Promise<unknown> | undefined;
  noteDenial(denial: Denial): void;
  start(): void;
  close(): Promise<void>;
}

export type ModeFactory = (hq: HqPort) => Mode;

export interface EgressControl {
  allow(site: string): Promise<void>;
}

export interface CagesOptions {
  readonly host: GitHost;
  readonly reviewHost?: GitHost;
  readonly repo: string;
  readonly base: string;
  readonly tickets: Readonly<Record<TaskId, Ticket>>;
  readonly author: string;
  readonly reviewer: string;
  readonly workers: Readonly<Record<string, AgentRuntime>>;
  readonly egress?: EgressControl;
  readonly pollMs?: number;
  readonly roundLimit?: number;
  readonly maxFailures?: number;
  readonly settleMs?: number;
  readonly reviewRetryMs?: number;
  readonly onJobFailed?: (task: TaskId, error: unknown) => void;
}

const ROUND_LIMIT = 3;

type Job =
  | { readonly kind: 'author'; readonly box: Box; readonly round: 0 }
  | { readonly kind: 'fix'; readonly box: Box & { pr: string }; readonly change: Change; readonly round: number }
  | {
      readonly kind: 'review';
      readonly box: Box & { pr: string };
      readonly change: Change;
      readonly reviewer: string;
      readonly round: number;
    }
  | { readonly kind: 'brief'; readonly box: Box & { pr: string }; readonly change: Change };

export const REVIEW_MARK = /^<!-- agent-works:review worker=(\S+) verdict=(approve|changes|comment) -->$/m;
const reviewMarker = (worker: string, verdict: Verdict) =>
  `<!-- agent-works:review worker=${worker} verdict=${verdict} -->`;
const changeRef = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
export const workOrder = (ticket: Ticket): string =>
  [
    `Work order ${inlineCode(ticket.id)}${ticket.url === null ? '' : `: ${inlineCode(ticket.url)}`}`,
    '',
    quoteBlock(ticket.body),
    '',
    'Opened by an Agent Works worker. HQ never merges; a person merges on the host.',
  ].join('\n');

export const changeTitle = (ticket: Ticket): string => `${ticket.id}: ${plainLine(ticket.title)}`;

export const reviewDraft = (
  head: string,
  worker: string,
  result: { readonly verdict: Verdict; readonly body: string; readonly comments: readonly LineComment[] },
): ReviewDraft => ({
  commitId: head,
  verdict: result.verdict,
  body: `${quoteBlock(result.body)}\n\n${reviewMarker(worker, result.verdict)}`,
  comments: result.comments.map((c) => ({ ...c, body: quoteBlock(c.body) })),
});

const objectOf = (raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new InvalidEvent('the body must be a JSON object');
  return raw as Record<string, unknown>;
};

const REVIEW_POSTS = 4;

export const cagesMode = (options: CagesOptions): ModeFactory => {
  for (const task of Object.keys(options.tickets))
    if (!TASK_ID.test(task)) throw new InvalidEvent(`the task id ${JSON.stringify(task)} is not <factory>/<task>`);
  return (hq) => {
    const { host, repo } = options;
    const reviewHost = options.reviewHost ?? host;
    const roundLimit = options.roundLimit ?? ROUND_LIMIT;
    const maxFailures = options.maxFailures ?? 3;
    const abort = new AbortController();
    const votes = new Map<string, Array<{ reviewer: string; verdict: Verdict; head: string }>>();
    let seen = 0;
    const running = new Map<TaskId, Promise<void>>();
    const again = new Set<TaskId>();
    const failures = new Map<string, { count: number; error: string }>();
    const briefs = new Map<TaskId, { head: string; url: string; text: string }>();
    const usage = new Map<TaskId, (Usage | null)[]>();
    const denials = new Map<string, Omit<Extract<ActionItem, { kind: 'website' }>, 'kind'>>();
    const allowed = new Set<string>();
    const lastPoll = new Map<string, string>();
    let timer: NodeJS.Timeout | null = null;

    const record = (ref: string, reviewer: string, verdict: Verdict, head: string) => {
      const list = votes.get(ref) ?? [];
      list.push({ reviewer: toLogin(reviewer), verdict, head });
      votes.set(ref, list);
    };
    const project = () => {
      for (const { seq, event } of hq.events(seen)) {
        seen = seq;
        if (event.source === 'webhook' && event.kind === 'review')
          record(changeRef(event.repo, event.number), event.reviewer, event.verdict, event.headSha);
        if (event.source === 'poll')
          for (const r of event.reviews)
            record(changeRef(event.repo, event.number), r.reviewer, r.verdict, event.headSha);
      }
    };
    const roundsOf = (change: Change): number =>
      new Set(
        (votes.get(changeRef(change.repo, change.number)) ?? [])
          .filter((v) => v.verdict === 'changes')
          .map((v) => v.head),
      ).size;

    const ingest = (event: Event | null) => {
      if (event !== null) hq.ingest(event);
    };
    const take = (snapshot: ChangeSnapshot) => {
      const event = toPoll(snapshot);
      const key = `${event.repo}#${event.number}`;
      const body = canonicalJson(event);
      if (lastPoll.get(key) === body) return event;
      lastPoll.set(key, body);
      ingest(event);
      return event;
    };
    const poll = async (number: number) => take(await host.snapshot(repo, number));
    const settle = async (number: number, head: string) => {
      for (let tries = 1; (await poll(number)).headSha !== head && tries < 10; tries += 1)
        await sleep(options.settleMs ?? 1000, undefined, { signal: abort.signal });
    };
    const reviewed = (state: State, change: Change, reviewer: string): boolean =>
      Object.hasOwn(state.reviews[`${change.repo}#${change.number}|${change.head.v}`] ?? {}, toLogin(reviewer));

    const needed = (task: TaskId): Job | null => {
      project();
      const state = hq.state();
      const box = state.boxes[task];
      if (box === undefined) return null;
      if (box.state === 'building') return { kind: 'author', box, round: 0 };
      if (box.state !== 'qc' && box.state !== 'merge') return null;
      const change = state.changes[box.pr];
      if (change === undefined || change.state !== 'open') return null;
      if (box.state === 'merge')
        return briefs.get(task)?.head === change.head.v ? null : { kind: 'brief', box, change };
      const rounds = roundsOf(change);
      if (box.changesRequested) return rounds > roundLimit ? null : { kind: 'fix', box, change, round: rounds };
      if (box.reviewer !== null && !reviewed(state, change, box.reviewer))
        return { kind: 'review', box, change, reviewer: box.reviewer, round: rounds + 1 };
      return null;
    };
    const jobKey = (job: Job): string => `${job.box.id}|${job.kind}|${job.kind === 'author' ? 0 : job.change.head.v}`;

    const runtimeOf = (worker: string): AgentRuntime => {
      const runtime = options.workers[worker];
      if (runtime === undefined) throw new Error(`no runtime is set for worker ${worker}`);
      return runtime;
    };
    const ticketOf = (task: TaskId): Ticket => {
      const ticket = options.tickets[task];
      if (ticket === undefined) throw new InvalidEvent(`no work order for ${task}`);
      return ticket;
    };
    const spend = (task: TaskId, used: Usage | null) => usage.set(task, [...(usage.get(task) ?? []), used]);

    const askedBy = async (comments: readonly CommentFact[], reviews: readonly ReviewFact[], head: string) => {
      const reviewer = await reviewHost.login();
      const inline = comments
        .filter((c) => c.commitId === head && c.author.toLowerCase() === reviewer)
        .map((c) => ({ ...c, body: unquote(c.body) }));
      const carried = reviews
        .filter((r) => r.commitId === head && r.reviewer.toLowerCase() === reviewer && r.body.includes(DROPPED_MARK))
        .map(
          (r): CommentFact => ({
            host: r.host,
            kind: 'review_comment',
            repo: r.repo,
            number: r.number,
            commentId: `${r.reviewId}-in-body`,
            reviewId: r.reviewId,
            author: r.reviewer,
            path: null,
            line: null,
            commitId: r.commitId,
            body: r.body.slice(r.body.indexOf(DROPPED_MARK) + DROPPED_MARK.length).trim(),
            at: r.at,
          }),
        );
      return [...inline, ...carried];
    };

    const runAuthor = async (task: TaskId, worker: string, round: number, comments: readonly CommentFact[]) => {
      const result = await runtimeOf(worker).run({
        role: 'author',
        task,
        worker,
        ticket: ticketOf(task),
        round,
        comments,
        signal: abort.signal,
      });
      if (result.role !== 'author') throw new Error('the author runtime returned a review');
      spend(task, result.usage);
      abort.signal.throwIfAborted();
      return host.pushFiles(repo, {
        branch: branchOf(task),
        base: options.base,
        files: result.files,
        message: plainLine(result.message),
      });
    };

    const author = async (job: Extract<Job, { kind: 'author' }>) => {
      const task = job.box.id;
      const branch = branchOf(task);
      const existing = await host.findChange(repo, branch);
      if (existing !== null) return void (await poll(existing.number));
      const ticket = ticketOf(task);
      const head = await runAuthor(task, job.box.worker ?? options.author, 0, []);
      abort.signal.throwIfAborted();
      const opened =
        (await host.findChange(repo, branch)) ??
        (await host.openChange(repo, {
          branch,
          base: options.base,
          title: changeTitle(ticket),
          body: workOrder(ticket),
        }));
      await settle(opened.number, head);
    };

    const fix = async (job: Extract<Job, { kind: 'fix' }>) => {
      const task = job.box.id;
      const now = await poll(job.change.number);
      if (now.headSha !== job.change.head.v) return;
      const asked = await askedBy(
        await host.comments(repo, job.change.number),
        (await host.snapshot(repo, job.change.number)).reviews,
        job.change.head.v,
      );
      const head = await runAuthor(task, options.author, job.round, asked);
      if (head === job.change.head.v) throw new Error('the fix round changed no file');
      await settle(job.change.number, head);
    };

    const reviewFact = (posted: ReviewFact, change: Change, worker: string, intended: Verdict): Event | null => {
      const shared = toLogin(posted.reviewer) === change.author.v;
      const verdict = shared ? (intended === 'changes' ? 'changes' : 'comment') : posted.verdict;
      if (verdict === null) return null;
      return {
        source: 'webhook',
        kind: 'review',
        repo: posted.repo,
        number: posted.number,
        reviewer: shared ? worker : posted.reviewer,
        verdict,
        headSha: posted.commitId,
        at: posted.at,
      };
    };

    const postWithRetry = async (number: number, draft: ReviewDraft) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await reviewHost.postReview(repo, number, draft);
        } catch (error) {
          const busy =
            error instanceof HostError && (error.status === 429 || error.status === 403 || error.status >= 500);
          if (!busy || attempt >= REVIEW_POSTS) throw error;
          await sleep(attempt * (options.reviewRetryMs ?? 30_000), undefined, { signal: abort.signal });
        }
      }
    };

    const review = async (job: Extract<Job, { kind: 'review' }>) => {
      const task = job.box.id;
      const head = job.change.head.v;
      const snapshot = await host.snapshot(repo, job.change.number);
      if (snapshot.change.headSha !== head) return void take(snapshot);
      const self = await reviewHost.login();
      const mine = snapshot.reviews
        .filter((r) => r.commitId === head && r.reviewer.toLowerCase() === self)
        .map((r) => ({ r, mark: REVIEW_MARK.exec(r.body) }))
        .find(({ mark }) => mark?.[1] === job.reviewer);
      if (mine !== undefined)
        return ingest(reviewFact(mine.r, job.change, job.reviewer, (mine.mark?.[2] ?? 'comment') as Verdict));
      const result = await runtimeOf(job.reviewer).run({
        role: 'reviewer',
        task,
        worker: job.reviewer,
        ticket: ticketOf(task),
        round: job.round,
        change: snapshot.change,
        files: await host.files(repo, job.change.number, head),
        signal: abort.signal,
      });
      if (result.role !== 'reviewer') throw new Error('the reviewer runtime returned a change');
      spend(task, result.usage);
      abort.signal.throwIfAborted();
      const posted = await postWithRetry(job.change.number, reviewDraft(head, job.reviewer, result)).catch(
        async (error: unknown) => {
          const now = await host.snapshot(repo, job.change.number);
          if (now.change.headSha === head) throw error;
          take(now);
          return null;
        },
      );
      if (posted === null) return;
      ingest(reviewFact(posted, job.change, job.reviewer, result.verdict));
    };

    const roundsFor = async (change: Change): Promise<ReviewRound[]> => {
      project();
      const comments = await host.comments(repo, change.number);
      const reviewer = await reviewHost.login();
      const list = votes.get(changeRef(change.repo, change.number)) ?? [];
      const heads = [...new Set(list.map((v) => v.head))];
      return list
        .filter((v, i) => list.findIndex((w) => w.reviewer === v.reviewer && w.head === v.head) === i)
        .filter((v) => options.workers[v.reviewer] !== undefined)
        .map((v) => ({
          round: heads.indexOf(v.head) + 1,
          reviewer: v.reviewer,
          runtime: runtimeOf(v.reviewer).id,
          verdict: v.verdict,
          headSha: v.head,
          asked: comments
            .filter((c) => c.commitId === v.head && c.line !== null && c.author.toLowerCase() === reviewer)
            .map((c) => `${c.path}:${c.line} ${unquote(c.body)}`),
        }));
    };

    const brief = async (job: Extract<Job, { kind: 'brief' }>) => {
      const task = job.box.id;
      const head = job.change.head.v;
      const snapshot = await host.snapshot(repo, job.change.number);
      if (snapshot.change.headSha !== head) return void take(snapshot);
      const [files, rounds] = await Promise.all([host.paths(repo, job.change.number), roundsFor(job.change)]);
      const text = renderBrief(
        mergeBrief({
          ticket: ticketOf(task),
          change: snapshot.change,
          files,
          checks: snapshot.checks,
          rounds,
          author: { runtime: runtimeOf(options.author).id },
          evidence: {},
          notes: {},
        }),
      );
      const marker = briefMarker(task, head);
      const posted =
        (await host.findComment(repo, job.change.number, marker)) ??
        (await host.postComment(repo, job.change.number, text));
      briefs.set(task, { head, url: posted.url, text });
      hq.changed();
    };

    const execute = (job: Job): Promise<void> => {
      if (job.kind === 'author') return author(job);
      if (job.kind === 'fix') return fix(job);
      if (job.kind === 'review') return review(job);
      return brief(job);
    };

    const work = async (task: TaskId) => {
      let last: string | null = null;
      for (;;) {
        again.delete(task);
        if (abort.signal.aborted) return;
        const job = needed(task);
        if (job === null) return;
        const key = jobKey(job);
        if ((failures.get(key)?.count ?? 0) >= maxFailures) return;
        if (key === last) return;
        last = key;
        try {
          await execute(job);
          failures.delete(key);
        } catch (error) {
          if (abort.signal.aborted) return;
          options.onJobFailed?.(task, error);
          const count = (failures.get(key)?.count ?? 0) + 1;
          failures.set(key, { count, error: (error as Error).message });
          if (count >= maxFailures && job.kind === 'author' && job.box.worker !== null)
            ingest({ source: 'hook', kind: 'session_ended', task, worker: job.box.worker });
          hq.changed();
          if (!again.has(task)) return;
        }
      }
    };

    const poke = (task: TaskId) => {
      if (running.has(task)) {
        again.add(task);
        return;
      }
      const run = work(task).finally(() => {
        running.delete(task);
        if (again.has(task)) poke(task);
      });
      running.set(task, run);
    };
    const pokeAll = () => {
      for (const task of Object.keys(hq.state().boxes)) poke(task);
    };

    const watch = async () => {
      const state = hq.state();
      for (const box of Object.values(state.boxes)) {
        if (box.state === 'shipped' || box.state === 'cancelled' || box.state === 'belt' || box.state === 'building')
          continue;
        const change = state.changes[box.pr];
        if (change === undefined || change.state !== 'open') continue;
        try {
          await poll(change.number);
        } catch {}
      }
      pokeAll();
    };

    const kick: Executor = async (entry) => {
      const command = entry.command;
      if ('task' in command) poke(command.task);
    };
    const done: Executor = async () => {};

    const actions = (): ActionItem[] => {
      project();
      const state = hq.state();
      const items: ActionItem[] = [];
      for (const box of Object.values(state.boxes)) {
        if (box.state === 'merge') {
          const written = briefs.get(box.id);
          const change = state.changes[box.pr];
          if (written !== undefined && change?.head.v === written.head)
            items.push({
              kind: 'ready_to_merge',
              task: box.id,
              url: written.url,
              brief: written.text.split('\n').slice(0, 12).join('\n'),
            });
        }
        if (box.state === 'qc' && box.changesRequested) {
          const change = state.changes[box.pr];
          if (change !== undefined && roundsOf(change) > roundLimit)
            items.push({
              kind: 'round_limit',
              task: box.id,
              url: `${repo}#${change.number}`,
              fixRounds: roundsOf(change) - 1,
            });
        }
      }
      for (const denial of denials.values()) if (!allowed.has(denial.site)) items.push({ kind: 'website', ...denial });
      for (const entry of hq.outbox())
        if (entry.command.kind === 'alert_human')
          items.push({ kind: 'alert', reason: entry.command.reason, subject: entry.command.subject });
      for (const [key, failure] of failures) {
        const [task = '', job = ''] = key.split('|');
        const now = needed(task);
        if (failure.count >= maxFailures && now !== null && jobKey(now) === key)
          items.push({ kind: 'job_failed', task, job, error: failure.error });
      }
      return items;
    };

    const view = (): ModeView => {
      project();
      const state = hq.state();
      const rounds: Record<TaskId, number> = {};
      for (const box of Object.values(state.boxes)) {
        const change = 'pr' in box ? state.changes[box.pr] : undefined;
        if (change !== undefined) rounds[box.id] = roundsOf(change);
      }
      const runtimes = new Set<RuntimeId>([runtimeOf(options.author).id, runtimeOf(options.reviewer).id]);
      return {
        rounds,
        usage: Object.fromEntries(usage),
        jobs: [...running.keys()],
        reviewGap:
          runtimes.size === 1 ? `author and reviewer both run on ${[...runtimes][0]}; Codex is deferred (G0)` : null,
      };
    };

    const route = (method: string, path: string, body: () => Promise<unknown>): Promise<unknown> | undefined => {
      if (method === 'POST' && path === '/api/tickets')
        return body().then((raw) => {
          const id = objectOf(raw).id;
          if (typeof id !== 'string') throw new InvalidEvent('id must be a task id of the form <factory>/<task>');
          ticketOf(id);
          for (const worker of [options.author, options.reviewer])
            ingest({ source: 'human', kind: 'add_worker', worker });
          ingest({ source: 'human', kind: 'order', task: id, shipment: null });
          ingest({ source: 'human', kind: 'hire', task: id, worker: options.author });
          return { task: id, branch: branchOf(id) };
        });
      if (method === 'POST' && path === '/api/actions/allow')
        return body().then(async (raw) => {
          const { host: rawHost, port } = objectOf(raw);
          const site = typeof rawHost === 'string' ? siteOf(rawHost, port)?.site : undefined;
          if (site === undefined || denials.get(site)?.allow !== true)
            throw new InvalidEvent(`no blocked website ${JSON.stringify(rawHost)} is waiting`);
          await options.egress?.allow(site);
          allowed.add(site);
          hq.changed();
          return { allowed: site };
        });
      return undefined;
    };

    return {
      executors: {
        start_cage: kick,
        request_review: kick,
        send_review_to_author: kick,
        notify_ready: kick,
        close_task: kick,
        release_cage: done,
        dispatch_truck: done,
        alert_human: done,
      },
      actions,
      view,
      route,
      noteDenial: (denial) => {
        const valid = siteOf(denial.host, denial.port);
        const key = valid ?? {
          site: JSON.stringify(`${denial.host}:${denial.port}`),
          host: denial.host,
          port: denial.port,
        };
        const seenBefore = denials.get(key.site);
        denials.set(key.site, {
          ...key,
          agent: denial.agent,
          count: (seenBefore?.count ?? 0) + 1,
          allow: valid !== null,
        });
      },
      start: () => {
        pokeAll();
        timer = setInterval(() => void watch(), options.pollMs ?? 35_000);
        timer.unref();
      },
      close: async () => {
        if (timer !== null) clearInterval(timer);
        abort.abort();
        await Promise.allSettled([...running.values()]);
      },
    };
  };
};
