import { type Box, branchOf, type Change, type PrKey, type State, type TaskId, type Verdict } from '@agent-works/core';
import type { Ticket } from '../agents/runtime.ts';
import { InvalidEvent } from '../events.ts';
import {
  type ChangeSnapshot,
  type CommentFact,
  DROPPED_MARK,
  type GitHost,
  type HostCheckState,
  type HostId,
  type ReviewFact,
} from '../githost/host.ts';
import { type ActionItem, type Mode, type ModeFactory, REVIEW_MARK } from '../modes/cages.ts';

/**
 * The PRs of the factory for the QC gate screen, at `GET /api/changes` and `GET /api/changes/<number>`.
 * It only reads: the list comes from HQ's own state, and one PR's detail asks the host for its checks, reviews and comments.
 */

export type ChangeStamp = 'READY' | 'CHANGES' | 'AT QC' | 'DRAFT' | 'SHIPPED' | 'SCRAPPED';

export interface ChangeRow {
  readonly number: number;
  readonly repo: string;
  readonly host: HostId;
  readonly branch: string;
  readonly base: string;
  readonly task: TaskId;
  readonly title: string;
  readonly worker: string | null;
  readonly head: string;
  readonly stamp: ChangeStamp;
}

export interface ChangesView {
  readonly rows: readonly ChangeRow[];
}

export type Approval =
  | { readonly by: 'peer'; readonly who: string | null; readonly state: 'approve' | 'changes' | 'wait' }
  | { readonly by: 'you'; readonly state: 'approve' | 'wait' };

export interface ReviewEntry {
  readonly reviewer: string;
  readonly verdict: Verdict;
  readonly body: string;
  readonly comments: readonly { readonly path: string | null; readonly line: number | null; readonly body: string }[];
}

export interface ReviewRoundView {
  readonly round: number;
  readonly head: string;
  readonly reviews: readonly ReviewEntry[];
}

export type HostRead =
  | {
      readonly state: 'read';
      /** The PR's page on the host, or null when the host gave no http address. */
      readonly url: string | null;
      readonly checks: readonly { readonly name: string; readonly state: HostCheckState }[];
      readonly rounds: readonly ReviewRoundView[];
    }
  | { readonly state: 'unread'; readonly reason: string };

export interface ChangeDetail {
  readonly row: ChangeRow;
  readonly approvals: readonly Approval[];
  /** The merge brief comment on the host, once HQ has posted it for this head. */
  readonly briefUrl: string | null;
  readonly fromHost: HostRead;
}

export interface ChangeSources {
  readonly host: GitHost;
  readonly reviewHost?: GitHost;
  readonly repo: string;
  readonly base: string;
  readonly tickets: Readonly<Record<TaskId, Ticket>>;
  /** How long a host answer is reused while HQ's own facts about the PR stay the same. */
  readonly maxAgeMs?: number;
}

const MAX_AGE_MS = 30_000;

const stampOf = (change: Change, key: PrKey, box: Box, red: boolean): ChangeStamp => {
  if (change.state === 'merged') return 'SHIPPED';
  if (change.state === 'closed') return 'SCRAPPED';
  switch (box.state) {
    case 'cancelled':
      return 'SCRAPPED';
    case 'shipping':
    case 'shipped':
      return 'SHIPPED';
    case 'qc':
      if (box.pr !== key) return 'DRAFT';
      return box.changesRequested ? 'CHANGES' : 'AT QC';
    case 'merge':
      return box.pr === key && !red ? 'READY' : 'DRAFT';
    case 'belt':
    case 'building':
    case 'test':
      return 'DRAFT';
  }
};

const RANK: Readonly<Record<ChangeStamp, number>> = {
  READY: 0,
  CHANGES: 1,
  'AT QC': 2,
  DRAFT: 3,
  SHIPPED: 4,
  SCRAPPED: 5,
};

interface Listed {
  readonly row: ChangeRow;
  readonly box: Box;
}

const listed = (state: State, sources: ChangeSources, red: Readonly<Record<TaskId, unknown>>): Listed[] => {
  const boxes = new Map(Object.values(state.boxes).map((box) => [branchOf(box.id), box]));
  const out: Listed[] = [];
  for (const [key, change] of Object.entries(state.changes)) {
    const box = boxes.get(change.branch);
    if (box === undefined || change.repo.toLowerCase() !== sources.repo.toLowerCase()) continue;
    out.push({
      box,
      row: {
        number: change.number,
        repo: change.repo,
        host: sources.host.id,
        branch: change.branch,
        base: sources.base,
        task: box.id,
        title: sources.tickets[box.id]?.title ?? box.id,
        worker: box.worker ?? box.builders[0] ?? null,
        head: change.head.v,
        stamp: stampOf(change, key as PrKey, box, red[box.id] !== undefined),
      },
    });
  }
  return out.sort((a, b) => RANK[a.row.stamp] - RANK[b.row.stamp] || b.row.number - a.row.number);
};

export const changesView = (
  state: State,
  sources: ChangeSources,
  red: Readonly<Record<TaskId, unknown>>,
): ChangesView => ({ rows: listed(state, sources, red).map(({ row }) => row) });

const approvalsOf = (state: State, { row, box }: Listed): Approval[] => {
  const peers: Approval[] = Object.entries(state.reviews[`${row.repo}#${row.number}|${row.head}`] ?? {}).flatMap(
    ([who, { v }]): Approval[] => (v === 'comment' ? [] : [{ by: 'peer', who, state: v }]),
  );
  if (peers.length === 0 && row.stamp !== 'SHIPPED' && row.stamp !== 'SCRAPPED')
    peers.push({ by: 'peer', who: box.state === 'qc' ? box.reviewer : null, state: 'wait' });
  if (row.stamp === 'SCRAPPED') return peers;
  return [...peers, { by: 'you', state: row.stamp === 'SHIPPED' ? 'approve' : 'wait' }];
};

const MARKS = new RegExp(REVIEW_MARK.source, 'gm');
const FENCED = /^(`{3,})text\n([\s\S]*?)\n\1$/gm;

/** A review body or comment as a person wrote it: HQ's own markers and quoting taken off. */
export const readable = (text: string): string =>
  text
    .replace(MARKS, '')
    .replaceAll(DROPPED_MARK, '')
    .replace(FENCED, (_, __, inner: string) => inner.replace(/^│ /gm, ''))
    .trim();

/**
 * One round per head that got a review, oldest first. With one shared account the host cannot say which worker reviewed,
 * so HQ's marker does, and only on a review that HQ's own reviewer login posted.
 */
export const roundsFrom = (
  reviews: readonly ReviewFact[],
  comments: readonly CommentFact[],
  self: string,
): ReviewRoundView[] => {
  const rounds = new Map<string, ReviewEntry[]>();
  for (const review of [...reviews].sort((a, b) => a.at - b.at)) {
    const mark = review.reviewer.toLowerCase() === self ? REVIEW_MARK.exec(review.body) : null;
    const verdict = (mark?.[2] as Verdict | undefined) ?? review.verdict;
    if (verdict === null) continue;
    const entry: ReviewEntry = {
      reviewer: mark?.[1] ?? review.reviewer,
      verdict,
      body: readable(review.body),
      comments: comments
        .filter((c) => c.reviewId === review.reviewId)
        .map((c) => ({ path: c.path, line: c.line, body: readable(c.body) })),
    };
    rounds.set(review.commitId, [...(rounds.get(review.commitId) ?? []), entry]);
  }
  return [...rounds].map(([head, entries], i) => ({ round: i + 1, head, reviews: entries }));
};

const httpUrl = (url: string): string | null => (/^https?:\/\//i.test(url) ? url : null);

const readHost = async (sources: ChangeSources, number: number): Promise<HostRead> => {
  const reviewHost = sources.reviewHost ?? sources.host;
  const [snapshot, comments, self]: [ChangeSnapshot, CommentFact[], string] = await Promise.all([
    sources.host.snapshot(sources.repo, number),
    sources.host.comments(sources.repo, number),
    reviewHost.login(),
  ]);
  return {
    state: 'read',
    url: httpUrl(snapshot.change.url),
    checks: snapshot.checks
      .filter((check) => check.headSha === snapshot.change.headSha)
      .map(({ name, state }) => ({ name, state })),
    rounds: roundsFrom(snapshot.reviews, comments, self),
  };
};

/** Adds the two read routes to a mode. Everything else the mode does is untouched. */
export const withChanges =
  (factory: ModeFactory, sources: ChangeSources): ModeFactory =>
  (hq): Mode => {
    const mode = factory(hq);
    const reads = new Map<number, { key: string; at: number; value: Promise<HostRead> }>();

    const cached = (number: number, key: string): Promise<HostRead> => {
      const seen = reads.get(number);
      if (seen !== undefined && seen.key === key && Date.now() - seen.at < (sources.maxAgeMs ?? MAX_AGE_MS))
        return seen.value;
      const value = readHost(sources, number).catch((error: unknown): HostRead => {
        reads.delete(number);
        return { state: 'unread', reason: error instanceof Error ? error.message : String(error) };
      });
      reads.set(number, { key, at: Date.now(), value });
      return value;
    };

    const detail = async (number: number): Promise<ChangeDetail> => {
      const red = mode.view().red;
      const state = hq.state();
      const found = listed(state, sources, red).find(({ row }) => row.number === number);
      if (found === undefined) throw new InvalidEvent(`no PR ${number} belongs to a task of this factory`);
      const approvals = approvalsOf(state, found);
      const brief = mode
        .actions()
        .find(
          (a): a is Extract<ActionItem, { kind: 'ready_to_merge' }> =>
            a.kind === 'ready_to_merge' && a.task === found.row.task,
        );
      return {
        row: found.row,
        approvals,
        briefUrl: brief === undefined ? null : httpUrl(brief.url),
        fromHost: await cached(number, JSON.stringify([found.row, approvals, red[found.row.task]])),
      };
    };

    return {
      ...mode,
      route: (method, path, body) => {
        if (method === 'GET' && path === '/api/changes')
          return Promise.resolve(changesView(hq.state(), sources, mode.view().red));
        const one = method === 'GET' ? /^\/api\/changes\/([1-9]\d{0,8})$/.exec(path) : null;
        return one === null ? mode.route(method, path, body) : detail(Number(one[1]));
      },
    };
  };
