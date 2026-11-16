import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import type { Command, Config, Event, Reducer, State } from '../src/lifecycle.js';
import { SEED } from './generators.js';
import { INVARIANTS, type Problem } from './oracle.js';
import { initialState, Oracle, reduce, StreamMonitor } from './subject.js';

export const EVIDENCE_DIR = process.env.LIFECYCLE_EVIDENCE_DIR;
if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true });

export function record(lane: string, lines: string[]) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(`\n[${lane}]\n${text}`);
  if (EVIDENCE_DIR) writeFileSync(join(EVIDENCE_DIR, `${lane}.txt`), text);
}

export interface Step {
  readonly event: Event;
  readonly before: State;
  readonly after: State;
  readonly commands: readonly Command[];
}

export interface Fold {
  readonly state: State;
  readonly commands: Command[];
  readonly problems: Problem[];
}

export function walk(
  config: Config,
  events: readonly Event[],
  reducer: Reducer = reduce,
  options: { deep?: boolean; onStep?: (step: Step) => void } = {},
): Fold {
  const deep = options.deep ?? true;
  const monitor = deep ? new Oracle(config) : new StreamMonitor(config.budget);
  let state = initialState(config);
  const commands: Command[] = [];
  const problems: Problem[] = [];
  for (const event of events) {
    const before = state;
    const step = reducer(before, event);
    state = step.state;
    commands.push(...step.commands);
    if (problems.length < 20) problems.push(...monitor.step(event, before, state, step.commands));
    options.onStep?.({ event, before, after: state, commands: step.commands });
  }
  return { state, commands, problems };
}

export function checkProperty<T>(arbitrary: fc.Arbitrary<T>, predicate: (value: T) => void, numRuns: number) {
  const started = performance.now();
  const details = fc.check(
    fc.property(arbitrary, (value) => {
      predicate(value);
    }),
    { numRuns, seed: SEED },
  );
  return { details, seconds: (performance.now() - started) / 1000 };
}

export function summary<T extends unknown[]>(
  name: string,
  details: fc.RunDetails<T>,
  seconds: number,
  wantFailure = false,
) {
  const outcome = details.failed === wantFailure ? (wantFailure ? 'CAUGHT' : 'PASS') : wantFailure ? 'MISSED' : 'FAIL';
  return `${outcome} ${name}: runs=${details.numRuns} counterexamples=${details.failed ? 1 : 0} seed=${details.seed} seconds=${seconds.toFixed(1)}`;
}

export { INVARIANTS };
