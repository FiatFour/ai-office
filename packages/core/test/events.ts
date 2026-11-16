import type { Command, Config, Event, State } from '../src/lifecycle.js';
import { initialState, reduce } from '../src/lifecycle.js';

export const order = (task: string, shipment: { id: string; size: number } | null = null): Event => ({
  source: 'human',
  kind: 'order',
  task,
  shipment,
});

export const hire = (task: string, worker: string): Event => ({ source: 'human', kind: 'hire', task, worker });
export const addWorker = (worker: string): Event => ({ source: 'human', kind: 'add_worker', worker });
export const cancel = (task: string): Event => ({ source: 'human', kind: 'cancel', task });

export const change = (
  number: number,
  branch: string,
  state: 'open' | 'closed' | 'merged',
  at: number,
  extra: { author?: string; headSha?: string; repo?: string; headRepo?: string } = {},
): Event => {
  const repo = extra.repo ?? 'r';
  return {
    source: 'webhook',
    kind: 'change',
    repo,
    headRepo: extra.headRepo ?? repo,
    number,
    branch,
    author: extra.author ?? 'w1',
    state,
    headSha: extra.headSha ?? 's1',
    at,
  };
};

export const check = (at: number, headSha = 's1', repo = 'r', state: 'success' | 'failure' | 'pending' = 'success') =>
  ({ source: 'webhook', kind: 'check', repo, headSha, name: 'ci', state, at }) satisfies Event;

export const review = (
  number: number,
  reviewer: string,
  at: number,
  verdict: 'approve' | 'changes' | 'comment' = 'approve',
  headSha = 's1',
  repo = 'r',
): Event => ({ source: 'webhook', kind: 'review', repo, number, reviewer, verdict, headSha, at });

export interface Trace {
  readonly state: State;
  readonly steps: readonly { readonly event: Event; readonly state: State; readonly commands: readonly Command[] }[];
  readonly commands: readonly Command[];
}

export function run(config: Config, events: readonly Event[]): Trace {
  let state = initialState(config);
  const steps: { event: Event; state: State; commands: readonly Command[] }[] = [];
  for (const event of events) {
    const step = reduce(state, event);
    state = step.state;
    steps.push({ event, state, commands: step.commands });
  }
  return { state, steps, commands: steps.flatMap((step) => step.commands) };
}
