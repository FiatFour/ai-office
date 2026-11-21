import { setTimeout as sleep } from 'node:timers/promises';
import type { TaskId, Verdict } from '@agent-works/core';
import type { FileEdit, LineComment } from '../githost/host.ts';
import { AgentFailed, type AgentResult, type AgentRuntime } from './runtime.ts';

export interface Script {
  readonly author: readonly { readonly files: readonly FileEdit[]; readonly needs?: string }[];
  readonly reviews: readonly {
    readonly verdict: Verdict;
    readonly body: string;
    readonly comments: readonly LineComment[];
  }[];
}

export interface Egress {
  reach(agent: string, host: string): Promise<boolean>;
}

export interface ScriptedOptions {
  readonly scripts: Readonly<Record<TaskId, Script>>;
  readonly egress?: Egress;
  readonly workMs?: number;
  readonly retryMs?: number;
  readonly giveUpMs?: number;
}

const pick = <T>(list: readonly T[], round: number): T => {
  const item = list[Math.min(round, list.length - 1)];
  if (item === undefined) throw new AgentFailed('the script has no step for this round');
  return item;
};

export const scripted = (options: ScriptedOptions): AgentRuntime => ({
  id: 'scripted',
  async run(job): Promise<AgentResult> {
    const script = options.scripts[job.task];
    if (script === undefined) throw new AgentFailed(`no script for ${job.task}`);
    if (options.workMs) await sleep(options.workMs, undefined, { signal: job.signal });
    if (job.role === 'reviewer') return { role: 'reviewer', ...pick(script.reviews, job.round - 1), usage: null };
    const step = pick(script.author, job.round);
    if (step.needs !== undefined) {
      const deadline = Date.now() + (options.giveUpMs ?? 30_000);
      while (!(await options.egress?.reach(job.worker, step.needs))) {
        if (Date.now() > deadline) throw new AgentFailed(`${step.needs} stayed blocked`);
        await sleep(options.retryMs ?? 100, undefined, { signal: job.signal });
      }
    }
    return {
      role: 'author',
      files: step.files,
      message: `${job.ticket.id}: ${job.ticket.title} (round ${job.round})`,
      usage: null,
    };
  },
});
