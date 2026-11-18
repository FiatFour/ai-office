import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CageShell } from '../server/agents/claude-code.ts';
import { claudeCode } from '../server/agents/claude-code.ts';
import { AgentFailed, type Ticket, type Usage } from '../server/agents/runtime.ts';
import type { GitHost } from '../server/githost/host.ts';
import { type RunningHq, startHq } from '../server/hq.ts';
import type { ModeFactory } from '../server/modes/cages.ts';
import { type Arm, ArmFailed, type ArmRun } from './arms.ts';
import type { TaskA, Tokens } from './model.ts';

export const ticketOf = (task: TaskA): Ticket => ({
  id: `bench/${task.id}`,
  kind: 'defect',
  title: task.title,
  body: task.body === '' ? task.title : task.body,
  url: `https://github.com/${task.repo}/issues/${task.issue}`,
  risk: null,
});

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

export const baselineArm = (shellFor: (task: TaskA) => CageShell, model?: string): Arm => ({
  name: 'baseline',
  async run(task, _prepared, signal) {
    const shell = shellFor(task);
    const runtime = claudeCode({ shell: () => shell, ...(model === undefined ? {} : { model }) });
    const ticket = ticketOf(task);
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
      reviewRounds: null,
      tokens: tokensOf([result.usage]),
      quotaWindows: null,
      humanMinutes: null,
      note: 'single Claude Code session, one round, no review',
    };
  },
});

export interface FactoryHandle {
  readonly mode: ModeFactory;
  readonly host: GitHost;
  readonly repo: string;
  readonly base: string;
  readonly home: string;
  readonly close?: () => Promise<void>;
}

export interface FactoryEnv {
  open(task: TaskA, ticket: Ticket): Promise<FactoryHandle>;
  readonly settleMs?: number;
}

const STOPS = new Set(['ready_to_merge', 'round_limit', 'job_failed']);

export const factoryArm = (env: FactoryEnv): Arm => ({
  name: 'factory',
  async run(task, _prepared, signal): Promise<ArmRun> {
    const ticket = ticketOf(task);
    const handle = await env.open(task, ticket);
    let hq: RunningHq | undefined;
    try {
      hq = await startHq({ home: handle.home, port: 0, makeDriver: async () => null, mode: handle.mode });
      const posted = await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: ticket.id }) });
      if (!posted.ok) throw new ArmFailed(`HQ refused the ticket: ${await posted.text()}`);
      const stop = await until(hq, signal);
      if (stop.kind !== 'ready_to_merge')
        throw new ArmFailed(stop.kind === 'job_failed' ? `job failed: ${stop.error}` : `stopped at ${stop.kind}`);
      const branch = `aw/${ticket.id}`;
      const change = await handle.host.findChange(handle.repo, branch);
      if (change === null) throw new ArmFailed(`no PR on ${branch}`);
      const files = await handle.host.files(handle.repo, change.number, change.headSha);
      const view = hq.snapshot().mode;
      return {
        files: files.flatMap((f) => (f.content === null ? [] : [{ path: f.path, content: f.content }])),
        reviewRounds: view?.rounds[ticket.id] ?? 0,
        tokens: tokensOf(view?.usage[ticket.id] ?? []),
        quotaWindows: null,
        humanMinutes: null,
        note: `PR #${change.number} at ready_to_merge`,
      };
    } finally {
      await hq?.close();
      await handle.close?.();
    }
  },
});

const until = async (hq: RunningHq, signal: AbortSignal) => {
  const started = performance.now();
  for (;;) {
    signal.throwIfAborted();
    const stop = hq.snapshot().actions.find((a) => STOPS.has(a.kind));
    if (stop !== undefined) return stop as { kind: string; error?: string };
    if (performance.now() - started > 24 * 3_600_000) throw new AgentFailed('no stop after a day');
    await sleep(25, undefined, { signal });
  }
};
