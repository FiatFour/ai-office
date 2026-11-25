import { createHash } from 'node:crypto';
import type { CageShell } from '../../server/agents/claude-code.ts';
import type { AgentRuntime, Ticket } from '../../server/agents/runtime.ts';
import { github } from '../../server/githost/github.ts';
import {
  type ApiCall,
  allPages,
  branchProblem,
  type ChangeFact,
  type ChangeSnapshot,
  type GitHost,
  guard,
  type Transport,
  WriteRefused,
  type WriteRule,
} from '../../server/githost/host.ts';
import { cagesMode, changeTitle, REVIEW_MARK, workOrder } from '../../server/modes/cages.ts';
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
  /** Closes one open PR by number: the sweep closes PRs it found by listing, not by a name it was given. */
  closeNumber(number: number): Promise<void>;
  /** Deletes one bench ref by full branch name, and no other. */
  dropRef(ref: string): Promise<void>;
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
  const dropRef = async (ref: string): Promise<void> => {
    try {
      await api({ method: 'DELETE', path: `${home}/git/refs/heads/${ref}` });
    } catch (error) {
      if (!(error instanceof Error) || !/-> (404|422)\b/.test(error.message)) throw error;
    }
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
      for (const ref of [branch, o.base]) await dropRef(ref);
    },
    async closeNumber(number) {
      await api({ method: 'PATCH', path: `${home}/pulls/${number}`, body: { state: 'closed' } });
    },
    dropRef,
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

/** The subtype of a result line the bench wrote itself: nothing it reports is ever a task outcome. */
const ABNORMAL = 'bench_abnormal';
const FACTORY_WRAPPERS = String.raw`^(?:the host refused what the crew pushed, so nothing is graded: )?(?:job failed: |no retry after the first failure: )?(?:bench/t-[0-9a-f]{8}-r\d+ (?:author|reviewer) \d+ failed: )?`;
/**
 * The only messages that are a result of the task. Every other failure says nothing about the arm, so a message nobody has
 * seen yet stops the run instead of being recorded as a final failure.
 */
const TASK_OUTCOMES: readonly RegExp[] = [
  'claude finished without committing a change$',
  String.raw`claude committed the binary file [^\n]*; HQ pushes text files only$`,
  'claude ran past its time limit$',
  'claude ended with error_max_turns(?:$|: )',
  "claude ended with (?:success|error_during_execution): (?:You['’]ve hit your max turns|Prompt is too long)",
  'the fix round changed no file$',
  'the reviewer still asked for changes at the round limit$',
  'the reviewer gave no json block with a verdict ',
  'the reviewer text holds a changes verdict that could not be read ',
  String.raw`refusing to push a change under \.github: `,
  String.raw`refusing POST \S+ on github: the file path "[^\n]*" is empty, hidden or holds a backslash$`,
].map((form) => new RegExp(`${FACTORY_WRAPPERS}${form}`));

export const isTaskOutcome = (message: string): boolean => TASK_OUTCOMES.some((form) => form.test(message));

/** A provider message starts a line, or follows the `claude ended with <subtype>: ` wrapper of `parseStream`. */
const TRANSIENT =
  /(?:^|claude ended with [\w ]+?: )[ \t]*(?:(?:API )?Error: )?(?:API Error: (?:429|529)\b|(?:overloaded|rate_limit)_error\b|\{"type":"error","error":\{"type":"(?:overloaded|rate_limit)_error")/im;
const AUTH =
  /Failed to authenticate|Not logged in|Login expired|Login reached its time limit|Authentication required|Invalid API key|API Error: 401|OAuth token/i;

export type Stop = 'auth' | 'transient' | null;

export const stopOf = (message: string): Stop =>
  AUTH.test(message) ? 'auth' : TRANSIENT.test(message) ? 'transient' : null;

/** The line to report: auth, then transient, then one that states a reset time, else the first 200 characters. */
export const stopLine = (text: string): string => {
  const lines = text.split('\n').map((l) => l.trim());
  const line =
    lines.find((l) => stopOf(l) === 'auth') ??
    lines.find((l) => stopOf(l) === 'transient') ??
    lines.find((l) => resetAt(l, new Date()) !== null);
  return (line ?? text.trim()).slice(0, 200);
};

interface ResultLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
}

const resultLine = (out: string): ResultLine | undefined =>
  out
    .split('\n')
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as ResultLine | null;
        return parsed?.type === 'result' ? [parsed] : [];
      } catch {
        return [];
      }
    })
    .at(-1);

type Ran = Awaited<ReturnType<CageShell['exec']>>;

/** The failure text to put in a synthetic result line, or null to leave the stream as claude printed it. */
const unsaid = (ran: Ran): string | null => {
  const result = resultLine(ran.out);
  if (result === undefined) {
    const printed = ran.out.split('\n').filter((l) => !l.startsWith('{'));
    const text = [ran.err, ...printed].join('\n').trim();
    return text === ''
      ? `claude gave an empty reply with exit ${ran.code}`
      : `${stopLine(text)} [exit ${ran.code}, no result line]`;
  }
  const said = (result.result ?? '').trim();
  const line = ran.err.trim() === '' ? null : stopLine(ran.err);
  if (result.is_error !== true && result.subtype === 'success') {
    if (ran.code === 0 && said !== '') return null;
    const why = said === '' ? 'claude gave an empty reply' : 'claude reported success';
    return line ?? `${why} with exit ${ran.code}`;
  }
  if (line === null) return null;
  if (stopOf(line) === 'auth' && stopOf(said) !== 'auth') return line;
  const generic = result.subtype !== 'error_max_turns' && /^(?:Execution error\.?)?$/i.test(said);
  return generic ? line : null;
};

const withResult = (ran: Ran, result: string): Ran => {
  const line = JSON.stringify({ type: 'result', subtype: ABNORMAL, is_error: true, result });
  return { ...ran, out: `${ran.out}${ran.out.endsWith('\n') || ran.out === '' ? '' : '\n'}${line}\n` };
};

/**
 * `claudeCode` reads only stdout and ignores the exit code, so this appends a synthetic error result line whenever claude
 * ended abnormally without saying so there. It also throws on a failed git command in the cage, which `claudeCode` would
 * read as a session that changed no file.
 */
export const withStderr = (shell: CageShell): CageShell => ({
  async exec(argv, options) {
    const ran = await shell.exec(argv, options);
    if (!argv.includes('--output-format')) {
      if (argv[0] === 'git' && ran.code !== 0)
        throw new Error(`git in the cage exited ${ran.code}: ${ran.err.trim().slice(-300)}`);
      return ran;
    }
    if (ran.timedOut) {
      const line = stopLine(ran.err);
      return stopOf(line) === null ? ran : withResult({ ...ran, timedOut: false }, line);
    }
    const result = unsaid(ran);
    return result === null ? ran : withResult(ran, result);
  },
});

const TIME = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]+)\))?/i;

/** The calendar parts of `now` in the zone, or null when the text in parentheses names no time zone. */
const partsIn = (zone: string | undefined, now: Date): Intl.DateTimeFormatPart[] | null => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      ...(zone === undefined ? {} : { timeZone: zone }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return null;
  }
};

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
  const parts = partsIn(m[4], now);
  if (parts === null) return null;
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

export type Step = 'seedBase' | 'push' | 'openChange';

export interface Published {
  readonly sha: string;
  readonly change: ChangeFact;
}

/**
 * The baseline arm's three remote writes, in order. `after` runs after each one: a test throws from it to kill the driver at
 * that point. The title, commit message and body use the template the factory's own PRs use, so the arms differ in how the
 * work was done and not in how the PR is dressed.
 */
export const publishBaseline = async (o: {
  readonly bench: BenchHost;
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  readonly ticket: Ticket;
  readonly files: Parameters<GitHost['pushFiles']>[1]['files'];
  readonly after?: (step: Step) => void | Promise<void>;
}): Promise<Published> => {
  await o.bench.seedBase();
  await o.after?.('seedBase');
  const sha = await o.bench.host.pushFiles(o.repo, {
    branch: o.branch,
    base: o.base,
    files: o.files,
    message: `${o.ticket.id}: ${o.ticket.title}`,
  });
  await o.after?.('push');
  const change = await o.bench.host.openChange(o.repo, {
    branch: o.branch,
    base: o.base,
    title: changeTitle(o.ticket),
    body: workOrder(o.ticket),
  });
  await o.after?.('openChange');
  return { sha, change };
};

/**
 * Before an arm that was started once before writes anything: finds what the interrupted run left on this branch.
 * An open PR that the arm accepts (`adopt`) is returned and kept: the baseline's PR is complete the moment it is opened, and a
 * factory PR whose review settled is too. Any other open PR is closed, and the branch and base refs are deleted, so the arm
 * starts from nothing on the same names. The closed PR stays on GitHub as a closed, labelled PR: one open PR per task and arm.
 */
export const resumeBranch = async (
  bench: BenchHost,
  repo: string,
  branch: string,
  adopt: (change: ChangeFact) => Promise<boolean>,
): Promise<ChangeFact | null> => {
  const open = await bench.host.findChange(repo, branch);
  if (open !== null) {
    if (await adopt(open)) return open;
    await bench.closeWork(branch);
  }
  await bench.dropRefs(branch);
  return null;
};

/**
 * Whether a resumed factory arm keeps the PR it left: the reviewer's last review of the head does not ask for changes, and no
 * review after it does. Marks carry the reviewer and verdict, since every bench review comes from one GitHub account.
 */
export const adoptable = (snapshot: ChangeSnapshot, reviewer: string): boolean => {
  const { reviews, change } = snapshot;
  const last = reviews.findLastIndex(
    (r) => r.commitId === change.headSha && REVIEW_MARK.exec(r.body)?.[1] === reviewer,
  );
  return (
    last >= 0 &&
    reviews.slice(last).every((r) => r.verdict !== 'changes' && REVIEW_MARK.exec(r.body)?.[2] !== 'changes')
  );
};

export interface BenchPull {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly state: string;
  readonly merged: boolean;
  readonly draft: boolean;
  readonly labelled: boolean;
}

export interface Remote {
  readonly refs: readonly string[];
  readonly pulls: readonly BenchPull[];
}

const isBenchRef = (ref: string): boolean => WORK_REF.test(ref) || BASE_REF.test(ref);

/**
 * Every bench ref and PR on the remote, found by prefix: refs under `aw/bench/` and `aw-bench-base/`, and every PR (open or
 * not) whose head is under `aw/bench/` or that carries the `aw-bench` label. It reads nothing from the journal, so a run killed
 * before its record was written is still found.
 */
export const listRemote = async (send: Transport, repo: string): Promise<Remote> => {
  const get = async (path: string): Promise<unknown> => {
    const response = await send({ method: 'GET', path });
    if (response.status >= 400) throw new TaskRefused(`GET ${path} gave status ${response.status}`);
    return response.body;
  };
  const refs: string[] = [];
  for (const prefix of ['aw/bench/', BASE_PREFIX]) {
    const found = await allPages(get, `/repos/${repo}/git/matching-refs/heads/${prefix}`);
    for (const item of found) {
      const ref = (item as { ref?: unknown }).ref;
      if (typeof ref === 'string' && ref.startsWith('refs/heads/')) refs.push(ref.slice('refs/heads/'.length));
    }
  }
  const pulls: BenchPull[] = [];
  for (const item of await allPages(get, `/repos/${repo}/pulls?state=all`)) {
    const p = item as {
      number: number;
      state: string;
      merged_at?: string | null;
      merged?: boolean;
      draft?: boolean;
      head: { ref: string };
      base: { ref: string };
      labels?: Array<{ name?: string }>;
    };
    const labelled = (p.labels ?? []).some((l) => l.name === BENCH_LABEL);
    if (!p.head.ref.startsWith('aw/bench/') && !labelled) continue;
    pulls.push({
      number: p.number,
      head: p.head.ref,
      base: p.base.ref,
      state: p.state,
      merged: p.merged === true || (p.merged_at !== undefined && p.merged_at !== null),
      draft: p.draft === true,
      labelled,
    });
  }
  return { refs: [...new Set(refs)].sort(), pulls };
};

/**
 * Closes every open bench PR and deletes every bench ref found by `listRemote`, whatever the journal says. Refuses when a
 * bench PR was merged. Only refs that match the bench ref patterns are deleted (the write guard enforces the same).
 */
export const sweepRemote = async (
  bench: BenchHost,
  remote: Remote,
): Promise<{ closed: number[]; deleted: string[] }> => {
  const merged = remote.pulls.filter((p) => p.merged);
  if (merged.length > 0)
    throw new TaskRefused(
      `bench PR(s) ${merged.map((p) => `#${p.number}`).join(', ')} are merged, which the bench never does`,
    );
  const closed: number[] = [];
  for (const p of remote.pulls)
    if (p.state === 'open') {
      await bench.closeNumber(p.number);
      closed.push(p.number);
    }
  const deleted: string[] = [];
  for (const ref of remote.refs.filter(isBenchRef)) {
    await bench.dropRef(ref);
    deleted.push(ref);
  }
  return { closed, deleted };
};

export interface Orphans {
  readonly refs: readonly string[];
  readonly pulls: readonly number[];
}

/** What is on the remote and belongs to no journaled intent. */
export const orphansOf = (
  remote: Remote,
  intents: ReadonlyArray<{ readonly branch: string; readonly base: string }>,
): Orphans => {
  const known = new Set(intents.flatMap((i) => [i.branch, i.base]));
  const inJournal = (ref: string) => known.has(ref);
  return {
    refs: remote.refs.filter((r) => !inJournal(r)),
    pulls: remote.pulls.filter((p) => !inJournal(p.head)).map((p) => p.number),
  };
};
