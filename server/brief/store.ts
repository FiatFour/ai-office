import { branchOf, type State, type TaskId, type Verdict } from '@agent-works/core';
import type { RuntimeId, Ticket } from '../agents/runtime.ts';
import { InvalidEvent } from '../events.ts';
import type { ChangeSnapshot, CommentFact, FileStat, GitHost, HostId } from '../githost/host.ts';
import { type Mode, type ModeFactory, REVIEW_MARK } from '../modes/cages.ts';
import { readable } from '../snapshot/changes.ts';
import { hostGate, hqGate, type NoBriefWhy } from './gate.ts';
import { type EvidenceKind, mergeBrief, type Section } from './merge-brief.ts';

/**
 * The merge brief page's data, at `GET /api/briefs/<task>`. It only reads. Nothing is kept past one host answer: that
 * answer is reused for a short time, and both gates run again on every request.
 */

export type BriefFiles =
  | {
      readonly state: 'collected';
      readonly count: number;
      /** Null when the host gave no line counts. */
      readonly added: number | null;
      readonly deleted: number | null;
      /** At most `MAX_FILES` of them. */
      readonly list: readonly FileStat[];
    }
  | { readonly state: 'not_collected'; readonly reason: string };

export interface TimelineEntry {
  readonly at: number;
  readonly round: number;
  readonly head: string;
  readonly reviewer: string;
  readonly verdict: Verdict;
  readonly notes: readonly string[];
}

export interface Brief {
  readonly phase: 'ready' | 'merged';
  readonly task: TaskId;
  readonly number: number;
  readonly repo: string;
  readonly host: HostId;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  /** The PR's page on the host, or null when the host gave no http address. */
  readonly url: string | null;
  /** When the host was read, in epoch milliseconds. */
  readonly readAt: number;
  readonly risk: Ticket['risk'];
  readonly summary: string;
  readonly workOrderUrl: string | null;
  readonly files: BriefFiles;
  readonly checks: readonly { readonly name: string }[];
  readonly approvals: { readonly required: number; readonly by: readonly string[] };
  readonly rounds: number;
  readonly changesAsked: number;
  readonly headComments: number;
  readonly timeline: readonly TimelineEntry[];
  /** Why the review is weaker than the design asks, or null. */
  readonly reviewGap: string | null;
  readonly beforeMerge: Section;
  readonly howToCheck: Section;
  /** Set only for a defect. */
  readonly rootCause: Section | null;
  readonly evidence: Readonly<Record<EvidenceKind, Section>>;
}

export type BriefAnswer =
  | { readonly state: 'brief'; readonly brief: Brief }
  | {
      readonly state: 'none';
      readonly task: TaskId;
      readonly why: NoBriefWhy | 'unread';
      readonly names: readonly string[];
    };

export interface BriefSources {
  readonly host: GitHost;
  readonly reviewHost?: GitHost;
  readonly repo: string;
  readonly base: string;
  readonly tickets: Readonly<Record<TaskId, Ticket>>;
  readonly author: RuntimeId;
  /** How long a host answer is reused while HQ's own facts about the PR stay the same. */
  readonly maxAgeMs?: number;
}

const MAX_AGE_MS = 30_000;
export const MAX_FILES = 200;
const MAX_NOTE = 600;
const MAX_NOTES = 20;
const MAX_TIMELINE = 60;

interface HostAnswer {
  readonly readAt: number;
  readonly snapshot: ChangeSnapshot;
  readonly comments: readonly CommentFact[];
  readonly self: string;
  readonly files: BriefFiles;
}

const readFiles = async (sources: BriefSources, number: number): Promise<BriefFiles> => {
  try {
    const stats = sources.host.fileStats
      ? await sources.host.fileStats(sources.repo, number)
      : (await sources.host.paths(sources.repo, number)).map((path) => ({ path, added: null, deleted: null }));
    if (stats.length === 0) return { state: 'not_collected', reason: 'the host listed no changed files' };
    const total = (key: 'added' | 'deleted') =>
      stats.reduce<number | null>((sum, file) => {
        const lines = file[key];
        return sum === null || lines === null ? null : sum + lines;
      }, 0);
    return {
      state: 'collected',
      count: stats.length,
      added: total('added'),
      deleted: total('deleted'),
      list: stats.slice(0, MAX_FILES),
    };
  } catch (error) {
    return {
      state: 'not_collected',
      reason: `the host did not list the files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/** The snapshot is read last, so a head that moved while the rest was read shows up in it and the gate refuses. */
const readHost = async (sources: BriefSources, number: number): Promise<HostAnswer> => {
  const [files, comments, self] = await Promise.all([
    readFiles(sources, number),
    sources.host.comments(sources.repo, number),
    (sources.reviewHost ?? sources.host).login(),
  ]);
  const snapshot = await sources.host.snapshot(sources.repo, number);
  return { readAt: Date.now(), snapshot, comments, self, files };
};

const clip = (text: string): string => (text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}…` : text);

/** One entry per review the host holds, oldest first. A round is one head that got a review. */
const timelineOf = (answer: HostAnswer): TimelineEntry[] => {
  const heads: string[] = [];
  const out: TimelineEntry[] = [];
  for (const review of [...answer.snapshot.reviews].sort((a, b) => a.at - b.at)) {
    const mark = review.reviewer.toLowerCase() === answer.self ? REVIEW_MARK.exec(review.body) : null;
    const verdict = review.verdict === null ? null : ((mark?.[2] as Verdict | undefined) ?? review.verdict);
    if (verdict === null) continue;
    if (!heads.includes(review.commitId)) heads.push(review.commitId);
    const notes = [
      readable(review.body),
      ...answer.comments
        .filter((c) => c.reviewId === review.reviewId)
        .map((c) => `${[c.path, c.line].filter((part) => part !== null).join(':')} ${readable(c.body)}`),
    ];
    out.push({
      at: review.at,
      round: heads.indexOf(review.commitId) + 1,
      head: review.commitId,
      reviewer: mark?.[1] ?? review.reviewer,
      verdict,
      notes: notes
        .filter((note) => note !== '')
        .slice(0, MAX_NOTES)
        .map(clip),
    });
  }
  return out;
};

const httpUrl = (url: string | null): string | null => (url !== null && /^https?:\/\//i.test(url) ? url : null);

const answerFor = (
  sources: BriefSources,
  state: State,
  mode: Mode,
  task: TaskId,
  ticket: Ticket,
  answer: HostAnswer,
): BriefAnswer => {
  const candidate = hqGate(state, task, sources.repo);
  if (!candidate.ok) return { state: 'none', task, why: candidate.why, names: candidate.names };
  const passed = hostGate(candidate, answer.snapshot, answer.self, state.config.approvals);
  if (!passed.ok) return { state: 'none', task, why: passed.why, names: passed.names };
  const { change } = answer.snapshot;
  const head = candidate.change.head.v;
  const timeline = timelineOf(answer);
  const written = mergeBrief({
    ticket,
    change,
    files: [],
    checks: answer.snapshot.checks,
    rounds: [],
    author: { runtime: sources.author },
    evidence: {},
    notes: {},
  });
  return {
    state: 'brief',
    brief: {
      phase: passed.phase,
      task,
      number: change.number,
      repo: candidate.change.repo,
      host: sources.host.id,
      branch: branchOf(task),
      base: sources.base,
      head,
      title: ticket.title,
      url: httpUrl(change.url),
      readAt: answer.readAt,
      risk: ticket.risk,
      summary: ticket.body,
      workOrderUrl: httpUrl(ticket.url),
      files: answer.files,
      checks: answer.snapshot.checks.filter((check) => check.headSha === head).map(({ name }) => ({ name })),
      approvals: { required: state.config.approvals, by: passed.approvers },
      rounds: Math.max(0, ...timeline.map((entry) => entry.round)),
      changesAsked: timeline.filter((entry) => entry.verdict === 'changes').length,
      headComments: answer.comments.filter((c) => c.commitId === head).length,
      timeline: timeline.slice(-MAX_TIMELINE),
      reviewGap: mode.view().reviewGap,
      beforeMerge: written.sections.before_merge,
      howToCheck: written.sections.how_to_check,
      rootCause: ticket.kind === 'defect' ? written.sections.root_cause : null,
      evidence: written.evidence,
    },
  };
};

const PATH = /^\/api\/briefs\/(.+)$/;

const taskIn = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new InvalidEvent('the task id in the path is not valid');
  }
};

/** Adds the one read route to a mode. Everything else the mode does is untouched. */
export const withBriefs =
  (factory: ModeFactory, sources: BriefSources): ModeFactory =>
  (hq): Mode => {
    const mode = factory(hq);
    const reads = new Map<TaskId, { key: string; at: number; value: Promise<HostAnswer | Error> }>();

    const cached = (task: TaskId, number: number, key: string): Promise<HostAnswer | Error> => {
      const seen = reads.get(task);
      if (seen !== undefined && seen.key === key && Date.now() - seen.at < (sources.maxAgeMs ?? MAX_AGE_MS))
        return seen.value;
      const value = readHost(sources, number).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      reads.set(task, { key, at: Date.now(), value });
      return value;
    };

    const briefOf = async (task: TaskId): Promise<BriefAnswer> => {
      const ticket = Object.hasOwn(sources.tickets, task) ? sources.tickets[task] : undefined;
      if (ticket === undefined) throw new InvalidEvent(`no work order for ${task}`);
      const state = hq.state();
      const candidate = hqGate(state, task, sources.repo);
      if (!candidate.ok) return { state: 'none', task, why: candidate.why, names: candidate.names };
      const { number, head } = candidate.change;
      const key = JSON.stringify([
        candidate.box,
        head.v,
        candidate.change.state,
        state.reviews[`${candidate.change.repo}#${number}|${head.v}`],
        state.checks[`${candidate.change.repo}|${head.v}`],
        mode.view().red[task],
      ]);
      const answer = await cached(task, number, key);
      if (answer instanceof Error) return { state: 'none', task, why: 'unread', names: [answer.message] };
      // HQ's state is read again, because it can change while the host is being read.
      return answerFor(sources, hq.state(), mode, task, ticket, answer);
    };

    return {
      ...mode,
      route: (method, path, body) => {
        const match = method === 'GET' ? PATH.exec(path) : null;
        return match === null ? mode.route(method, path, body) : briefOf(taskIn(match[1] as string));
      },
    };
  };
