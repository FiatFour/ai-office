import { createHash } from 'node:crypto';
import type { AgentRuntime } from '../../server/agents/runtime.ts';
import { github } from '../../server/githost/github.ts';
import {
  type ApiCall,
  branchProblem,
  type ChangeFact,
  type GitHost,
  guard,
  type Transport,
  WriteRefused,
  type WriteRule,
} from '../../server/githost/host.ts';
import { cagesMode } from '../../server/modes/cages.ts';
import { type FactoryEnv, removedVia } from '../arms-live.ts';
import { TaskRefused } from '../model.ts';
import { oneSessionEach } from '../scratch.ts';
import { workflowPaths } from './guard.ts';
import type { Ci } from './packet.ts';
import type { SetBTask } from './task.ts';

export const BENCH_LABEL = 'aw-bench';
export const BASE_PREFIX = 'aw-bench-base/';
export const AUTHOR = 'nova';
export const REVIEWER = 'vega';
export const CI_PARALLEL = 2;

const BASE_REF = /^aw-bench-base\/t-[0-9a-f]{8}-r[1-9]\d{0,2}$/;
const WORK_REF = /^aw\/bench\/t-[0-9a-f]{8}-r[1-9]\d{0,2}$/;
const route = (tail: string) => new RegExp(`^/${tail}$`);

export const baseNameOf = (ticketId: string): string => `${BASE_PREFIX}${ticketId.split('/').at(-1) ?? ''}`;
export const branchOf = (ticketId: string): string => `aw/${ticketId}`;

/** A task shaped for the shared arm code, with an id nobody can link to the task list: its hash names the branch. */
export const hiddenTask = (task: SetBTask, salt: string) => ({
  id: `${task.id}.${salt}`,
  title: task.title,
  body: task.body,
});

export const benchWrites = (baseSha: string): readonly WriteRule[] => [
  {
    method: 'POST',
    path: route('git/refs'),
    keys: ['ref', 'sha'],
    body: (b, scope) =>
      BASE_REF.test(scope.base) && b.ref === `refs/heads/${scope.base}` && b.sha === baseSha
        ? null
        : 'only the pinned base ref of this run may be created',
  },
  {
    method: 'POST',
    path: route('pulls'),
    keys: ['title', 'body', 'head', 'base', 'draft'],
    body: (b, scope) =>
      branchProblem(b.head) ??
      (b.base === scope.base ? null : `a PR must target ${scope.base}`) ??
      (b.draft === true ? null : 'a bench PR opens as a draft'),
  },
  {
    method: 'POST',
    path: route('issues/\\d+/labels'),
    keys: ['labels'],
    body: (b) =>
      Array.isArray(b.labels) && b.labels.length === 1 && b.labels[0] === BENCH_LABEL
        ? null
        : `the only label is ${BENCH_LABEL}`,
  },
  {
    method: 'POST',
    path: route('labels'),
    keys: ['name', 'color', 'description'],
    body: (b) => (b.name === BENCH_LABEL ? null : `the only label to create is ${BENCH_LABEL}`),
  },
  {
    method: 'PATCH',
    path: route('pulls/\\d+'),
    keys: ['state'],
    body: (b) => (b.state === 'closed' ? null : 'a PR is only ever closed'),
  },
  {
    method: 'DELETE',
    path: /^\/git\/refs\/heads\/(?:aw\/bench\/t-[0-9a-f]{8}-r[1-9]\d{0,2}|aw-bench-base\/t-[0-9a-f]{8}-r[1-9]\d{0,2})$/,
    keys: [],
  },
];

export interface BenchHostOptions {
  readonly repo: string;
  readonly base: string;
  readonly baseSha: string;
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
}

export interface BenchHost {
  readonly host: GitHost;
  seedBase(): Promise<void>;
  closeWork(branch: string): Promise<number[]>;
  dropRefs(branch: string): Promise<void>;
}

const numberOf = (pr: unknown): number => {
  const n = (pr as { number?: unknown } | null)?.number;
  if (typeof n !== 'number') throw new TaskRefused('the host returned a PR without a number');
  return n;
};

export const benchHost = (o: BenchHostOptions): BenchHost => {
  const inner = github({ repo: o.repo, base: o.base, send: o.send, log: o.log });
  const api = guard('github', benchWrites(o.baseSha), { home: `/repos/${o.repo}`, base: o.base }, o.send, o.log);
  const home = `/repos/${o.repo}`;
  const host: GitHost = {
    ...inner,
    async pushFiles(repo, spec) {
      const flows = workflowPaths(spec.files.map((f) => f.path));
      if (flows.length > 0) throw new WriteRefused(`refusing to push a change under .github: ${flows.join(', ')}`);
      return inner.pushFiles(repo, spec);
    },
    async openChange(repo, spec): Promise<ChangeFact> {
      const pr = await api({
        method: 'POST',
        path: `${home}/pulls`,
        body: { title: spec.title, body: spec.body, head: spec.branch, base: spec.base, draft: true },
      });
      await api({ method: 'POST', path: `${home}/issues/${numberOf(pr)}/labels`, body: { labels: [BENCH_LABEL] } });
      const made = await inner.findChange(repo, spec.branch);
      if (made === null) throw new TaskRefused(`the draft PR on ${spec.branch} cannot be found after it was opened`);
      return made;
    },
  };
  return {
    host,
    async seedBase() {
      await api({
        method: 'POST',
        path: `${home}/git/refs`,
        body: { ref: `refs/heads/${o.base}`, sha: o.baseSha },
      });
    },
    async closeWork(branch) {
      if (!WORK_REF.test(branch)) throw new TaskRefused(`${branch} is not a bench work branch`);
      const closed: number[] = [];
      for (
        let change = await inner.findChange(o.repo, branch);
        change !== null;
        change = await inner.findChange(o.repo, branch)
      ) {
        if (closed.length >= 20) throw new TaskRefused(`${o.repo} keeps open PRs on ${branch}`);
        await api({ method: 'PATCH', path: `${home}/pulls/${change.number}`, body: { state: 'closed' } });
        closed.push(change.number);
      }
      return closed;
    },
    async dropRefs(branch) {
      for (const ref of [branch, o.base]) {
        try {
          await api({ method: 'DELETE', path: `${home}/git/refs/heads/${ref}` });
        } catch (error) {
          if (!(error instanceof Error) || !/-> (404|422)\b/.test(error.message)) throw error;
        }
      }
    },
  };
};

export interface PublicOptions {
  readonly repo: string;
  readonly baseSha: string;
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
  readonly workers: Readonly<Record<string, AgentRuntime>>;
  readonly home: (ticketId: string) => string;
  readonly pollMs?: number;
  readonly settleMs?: number;
  readonly reviewRetryMs?: number;
  readonly reviewPollMs?: number;
  readonly onOpen?: (ticketId: string, bench: BenchHost) => void;
}

export const publicEnv = (o: PublicOptions): FactoryEnv => {
  return {
    ...(o.reviewPollMs === undefined ? {} : { reviewPollMs: o.reviewPollMs }),
    async open(_task, ticket) {
      const base = baseNameOf(ticket.id);
      const bench = benchHost({ repo: o.repo, base, baseSha: o.baseSha, send: o.send, log: o.log });
      await bench.seedBase();
      o.onOpen?.(ticket.id, bench);
      const crew = oneSessionEach(o.workers);
      return {
        failure: crew.failure,
        host: bench.host,
        repo: o.repo,
        base,
        home: o.home(ticket.id),
        reviewer: REVIEWER,
        mode: cagesMode({
          host: bench.host,
          repo: o.repo,
          base,
          tickets: { [ticket.id]: ticket },
          author: AUTHOR,
          reviewer: REVIEWER,
          workers: crew.workers,
          onJobFailed: (_task, error) => crew.fail(error),
          pollMs: o.pollMs ?? 10_000,
          ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
          ...(o.reviewRetryMs === undefined ? {} : { reviewRetryMs: o.reviewRetryMs }),
        }),
        removed: (change) => removedVia(o.send, o.repo, change.number),
      };
    },
  };
};

export const saltOf = (ticketId: string): string => createHash('sha256').update(ticketId).digest('hex').slice(0, 8);

const QUOTA = /usage limit|limit reached|hit your limit|rate.?limit|5-hour limit|out of (?:extra )?usage/i;
const AUTH = /OAuth token revoked|Failed to authenticate/i;

export type Stop = 'quota' | 'auth' | null;

export const stopOf = (message: string): Stop => (AUTH.test(message) ? 'auth' : QUOTA.test(message) ? 'quota' : null);

const TIME = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]+)\))?/i;

/** The reset time a usage-limit message states, as ms since the epoch, or null when it states none. */
export const resetAt = (message: string, now: Date): number | null => {
  const epoch = /limit reached\|(\d{10})/.exec(message)?.[1];
  if (epoch !== undefined) return Number(epoch) * 1000;
  const m = TIME.exec(message);
  if (m === null) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const zone = m[4];
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(zone === undefined ? {} : { timeZone: zone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'));
  const offset = local - now.getTime();
  let target = Date.UTC(at('year'), at('month') - 1, at('day'), hour, minute, 0) - offset;
  if (target <= now.getTime()) target += 24 * 3_600_000;
  return target;
};

export interface Head {
  readonly sha: string;
  readonly since: number;
}

const FRESH_MS = 10 * 60_000;

export const ciPending = (ci: Ci, since: number, now: number): boolean =>
  ci.state === 'pending' || (ci.state === 'none' && now - since < FRESH_MS);

/** Waits until fewer than `limit` of the tracked heads still have CI running, so at most `limit` PRs run CI at once. */
export const waitForCiSlot = async (
  heads: readonly Head[],
  read: (sha: string) => Promise<Ci>,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
  limit: number = CI_PARALLEL,
  pollMs = 60_000,
): Promise<void> => {
  for (;;) {
    let running = 0;
    for (const head of heads) if (ciPending(await read(head.sha), head.since, now())) running += 1;
    if (running < limit) return;
    await sleep(pollMs);
  }
};
