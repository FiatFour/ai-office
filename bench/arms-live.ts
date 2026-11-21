import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CageShell } from '../server/agents/claude-code.ts';
import { claudeCode } from '../server/agents/claude-code.ts';
import { AgentFailed, type Ticket, type Usage } from '../server/agents/runtime.ts';
import { allPages, type ChangeSnapshot, type GitHost, type Transport } from '../server/githost/host.ts';
import { type RunningHq, startHq } from '../server/hq.ts';
import { type ModeFactory, REVIEW_MARK } from '../server/modes/cages.ts';
import { type Arm, ArmFailed, type ArmRun } from './arms.ts';
import type { TaskA, Tokens } from './model.ts';
import type { Prepared } from './workspace.ts';

const LINK = /\b(?:https?:\/\/)?(?:[\w-]+\.)*(?:github\.com|githubusercontent\.com|npmjs\.com|npmjs\.org)\S*/gi;

export const ticketOf = (task: TaskA, run: number): Ticket => {
  const body = task.body.replace(LINK, '[link removed]');
  return {
    id: `bench/t-${createHash('sha256').update(task.id).digest('hex').slice(0, 8)}-r${run}`,
    kind: 'defect',
    title: task.title,
    body: body === '' ? task.title : body,
    url: null,
    risk: null,
  };
};

export const tokensOf = (usages: readonly (Usage | null)[]): Tokens | null => {
  const seen = usages.filter((u): u is Usage => u !== null);
  if (seen.length === 0) return null;
  return {
    input: seen.reduce((n, u) => n + u.inputTokens, 0),
    output: seen.reduce((n, u) => n + u.outputTokens, 0),
    cacheRead: seen.reduce((n, u) => n + u.cacheReadTokens, 0),
    cacheCreation: seen.reduce((n, u) => n + u.cacheCreationTokens, 0),
  };
};

export const webRequestsOf = (usages: readonly (Usage | null)[]): number | null => {
  const seen = usages.filter((u): u is Usage => u !== null);
  return seen.length === 0 ? null : seen.reduce((n, u) => n + u.webRequests, 0);
};

export interface BaselineOptions {
  readonly model?: string;
  readonly bin?: string;
}

const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];

const deletedSince = async (shell: CageShell, since: string): Promise<string[]> => {
  const ran = await shell.exec([...GIT, 'diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', since, 'HEAD']);
  if (ran.code !== 0) throw new ArmFailed(`the cage diff for deleted files failed: ${ran.err.trim().slice(-200)}`);
  return ran.out.split('\0').filter(Boolean);
};

export const baselineArm = (shellFor: (task: TaskA, run: number) => CageShell, options: BaselineOptions = {}): Arm => ({
  name: 'baseline',
  scripted: false,
  async run(task, _prepared, signal, run) {
    const shell = shellFor(task, run);
    const before = await shell.exec([...GIT, 'rev-parse', 'HEAD']);
    if (before.code !== 0) throw new ArmFailed(`the cage repo has no HEAD: ${before.err.trim()}`);
    const runtime = claudeCode({
      shell: () => shell,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.bin === undefined ? {} : { bin: options.bin }),
    });
    const ticket = ticketOf(task, run);
    const result = await runtime.run({
      role: 'author',
      task: ticket.id,
      worker: 'baseline',
      ticket,
      round: 0,
      comments: [],
      signal,
    });
    if (result.role !== 'author') throw new ArmFailed('the baseline runtime returned a review');
    return {
      files: result.files,
      deleted: await deletedSince(shell, before.out.trim()),
      reviewRounds: null,
      tokens: tokensOf([result.usage]),
      webRequests: webRequestsOf([result.usage]),
      quotaWindows: null,
      humanMinutes: null,
      note: 'single Claude Code session, one round, no review',
    };
  },
});

export interface Failure {
  readonly message: string;
  readonly refused: boolean;
}

export interface FactoryHandle {
  readonly mode: ModeFactory;
  readonly host: GitHost;
  readonly repo: string;
  readonly base: string;
  readonly home: string;
  readonly reviewer: string;
  readonly failure?: () => Failure | null;
  readonly removed: (change: { readonly number: number; readonly headSha: string }) => Promise<string[]>;
  readonly close?: () => Promise<void>;
}

export interface FactoryEnv {
  open(task: TaskA, ticket: Ticket, prepared: Prepared, signal: AbortSignal): Promise<FactoryHandle>;
  readonly reviewPollMs?: number;
}

const STOPS = new Set(['ready_to_merge', 'round_limit', 'job_failed']);

export const removedPaths = (pullFiles: readonly unknown[]): string[] =>
  pullFiles.flatMap((f) => {
    const file = f as { status?: string; filename?: string; previous_filename?: string };
    if (file.status === 'removed' && typeof file.filename === 'string') return [file.filename];
    if (file.status === 'renamed' && typeof file.previous_filename === 'string') return [file.previous_filename];
    return [];
  });

export const removedVia = async (send: Transport, repo: string, number: number): Promise<string[]> => {
  const get = async (path: string) => {
    const response = await send({ method: 'GET', path });
    if (response.status >= 400)
      throw new ArmFailed(`the host could not list the files of ${repo}#${number}: status ${response.status}`);
    return response.body;
  };
  return removedPaths(await allPages(get, `/repos/${repo}/pulls/${number}/files`));
};

export const reviewSettled = (snapshot: ChangeSnapshot, reviewer: string): boolean =>
  snapshot.reviews.some((r) => {
    const mark = REVIEW_MARK.exec(r.body);
    return r.commitId === snapshot.change.headSha && mark?.[1] === reviewer && mark[2] !== 'changes';
  });

export const factoryArm = (env: FactoryEnv): Arm => ({
  name: 'factory',
  scripted: false,
  async run(task, prepared, signal, run): Promise<ArmRun> {
    const ticket = ticketOf(task, run);
    const handle = await env.open(task, ticket, prepared, signal);
    let hq: RunningHq | undefined;
    try {
      hq = await startHq({ home: handle.home, port: 0, makeDriver: async () => null, mode: handle.mode });
      const posted = await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: ticket.id }) });
      if (!posted.ok) throw new ArmFailed(`HQ refused the ticket: ${await posted.text()}`);
      const branch = `aw/${ticket.id}`;
      const stop = await until(hq, handle, branch, env.reviewPollMs ?? 15_000, signal);
      const view = hq.snapshot().mode;
      if (stop.kind === 'refused')
        return {
          files: [],
          deleted: [],
          reviewRounds: view?.rounds[ticket.id] ?? 0,
          tokens: tokensOf(view?.usage[ticket.id] ?? []),
          webRequests: webRequestsOf(view?.usage[ticket.id] ?? []),
          quotaWindows: null,
          humanMinutes: null,
          note: `the host refused what the crew pushed, so nothing is graded: ${stop.error}`,
        };
      if (stop.kind === 'failed') throw new ArmFailed(`no retry after the first failure: ${stop.error}`);
      if (stop.kind === 'job_failed') throw new ArmFailed(`job failed: ${stop.error}`);
      if (stop.kind === 'round_limit') throw new ArmFailed('the reviewer still asked for changes at the round limit');
      const change = await handle.host.findChange(handle.repo, branch);
      if (change === null) throw new ArmFailed(`no PR on ${branch}`);
      const files = await handle.host.files(handle.repo, change.number, change.headSha);
      return {
        files: files.flatMap((f) => (f.content === null ? [] : [{ path: f.path, content: f.content }])),
        deleted: await handle.removed(change),
        reviewRounds: view?.rounds[ticket.id] ?? 0,
        tokens: tokensOf(view?.usage[ticket.id] ?? []),
        webRequests: webRequestsOf(view?.usage[ticket.id] ?? []),
        quotaWindows: null,
        humanMinutes: null,
        note: `PR #${change.number} ${stop.kind === 'ready_to_merge' ? 'at ready_to_merge' : 'head reviewed with no change requested'}`,
      };
    } finally {
      await hq?.close();
      await handle.close?.();
    }
  },
});

const reviewSettledOnHost = async (handle: FactoryHandle, branch: string): Promise<boolean> => {
  try {
    const change = await handle.host.findChange(handle.repo, branch);
    return change !== null && reviewSettled(await handle.host.snapshot(handle.repo, change.number), handle.reviewer);
  } catch {
    return false;
  }
};

const until = async (
  hq: RunningHq,
  handle: FactoryHandle,
  branch: string,
  reviewPollMs: number,
  signal: AbortSignal,
): Promise<{ kind: string; error?: string }> => {
  const started = performance.now();
  let lastReviewCheck = Number.NEGATIVE_INFINITY;
  for (;;) {
    signal.throwIfAborted();
    const failed = handle.failure?.() ?? null;
    if (failed !== null) return { kind: failed.refused ? 'refused' : 'failed', error: failed.message };
    const stop = hq.snapshot().actions.find((a) => STOPS.has(a.kind));
    if (stop !== undefined) return stop as { kind: string; error?: string };
    if (performance.now() - lastReviewCheck >= reviewPollMs) {
      lastReviewCheck = performance.now();
      if (await reviewSettledOnHost(handle, branch)) return { kind: 'review_settled' };
    }
    if (performance.now() - started > 24 * 3_600_000) throw new AgentFailed('no stop after a day');
    await sleep(25, undefined, { signal });
  }
};
