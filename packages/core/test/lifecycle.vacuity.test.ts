import type fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { Command, Reducer } from '../src/lifecycle.js';
import { type Scenario, scenarioArb } from './generators.js';
import { checkProperty, record, summary, walk } from './harness.js';
import type { Invariant } from './oracle.js';
import { createReducer, reduce } from './subject.js';

vi.setConfig({ testTimeout: 600_000 });

const MUTANT_RUNS = 4_000;

const withCommands =
  (edit: (commands: readonly Command[], step: ReturnType<Reducer>) => readonly Command[]): Reducer =>
  (state, event) => {
    const step = reduce(state, event);
    return { ...step, commands: edit(step.commands, step) };
  };

const MUTANTS: { name: string; reducer: Reducer; caughtBy: Invariant }[] = [
  {
    name: 'the author may review',
    reducer: createReducer({ canReview: () => true }),
    caughtBy: 'author-never-reviews',
  },
  {
    name: 'the truck leaves on the first merged PR',
    reducer: (state, event) => {
      const step = reduce(state, event);
      const shipments = Object.fromEntries(
        Object.entries(step.state.shipments).map(([id, shipment]) => [
          id,
          shipment.members.some((member) => step.state.boxes[member]?.state === 'shipping')
            ? { ...shipment, state: 'departed' as const }
            : shipment,
        ]),
      );
      return { ...step, state: { ...step.state, shipments } };
    },
    caughtBy: 'shipment',
  },
  {
    name: 'a merge command after notify_ready',
    reducer: withCommands((commands) =>
      commands.some((command) => command.kind === 'notify_ready')
        ? [...commands, { kind: 'merge_pr', task: 'x' } as unknown as Command]
        : commands,
    ),
    caughtBy: 'no-merge',
  },
  {
    name: 'a merge hidden in an alert subject',
    reducer: withCommands((commands) =>
      commands.some((command) => command.kind === 'notify_ready')
        ? [...commands, { kind: 'alert_human', reason: 'shipment_blocked', subject: 'gh pr merge 7' }]
        : commands,
    ),
    caughtBy: 'no-merge',
  },
  {
    name: 'starts are emitted before releases in one batch',
    reducer: withCommands((commands) => [
      ...commands.filter((command) => command.kind === 'start_cage'),
      ...commands.filter((command) => command.kind !== 'start_cage'),
    ]),
    caughtBy: 'cage-stream',
  },
  {
    name: 'a shipped box is sent back to test by a later open PR',
    reducer: (state, event) => {
      const step = reduce(state, event);
      if (event.source !== 'webhook' || event.kind !== 'change' || event.state !== 'open') return step;
      const boxes = Object.fromEntries(
        Object.entries(step.state.boxes).map(([id, box]) => [
          id,
          box.state === 'shipped' && event.branch === `aw/${id}` ? { ...box, state: 'test' as const } : box,
        ]),
      );
      return { ...step, state: { ...step.state, boxes } as typeof step.state };
    },
    caughtBy: 'transition',
  },
  {
    name: 'a second truck for a shipment that left',
    reducer: withCommands((commands, step) => [
      ...commands,
      ...Object.values(step.state.shipments)
        .filter(
          (shipment) => shipment.state === 'departed' && !commands.some((command) => command.kind === 'dispatch_truck'),
        )
        .map((shipment): Command => ({ kind: 'dispatch_truck', shipment: shipment.id })),
    ]),
    caughtBy: 'transition',
  },
];

function counterexample(details: fc.RunDetails<[Scenario]>): string {
  const value = details.counterexample?.[0] as Scenario | undefined;
  return value ? `${value.events.length} events after shrinking: ${JSON.stringify(value.events)}` : 'none';
}

describe('the checks are not vacuous', () => {
  it('lane 10: each wrong reducer yields a counterexample from the invariant that is meant to catch it', () => {
    const lines: string[] = [];
    for (const mutant of MUTANTS) {
      const { details, seconds } = checkProperty(
        scenarioArb,
        ({ config, events }) => {
          const result = walk(config, events, mutant.reducer);
          const hit = result.problems.find((problem) => problem.invariant === mutant.caughtBy);
          if (hit) throw new Error(hit.detail);
        },
        MUTANT_RUNS,
      );
      lines.push(summary(`mutant "${mutant.name}", expected ${mutant.caughtBy}`, details, seconds, true));
      lines.push(`  counterexample: ${counterexample(details)}`);
      expect(details.failed, mutant.name).toBe(true);
      const found = details.counterexample?.[0];
      if (found === undefined) throw new Error(`${mutant.name} gave no counterexample`);
      const control = walk(found.config, found.events);
      expect(
        control.problems.filter((problem) => problem.invariant === mutant.caughtBy),
        `${mutant.name}: the real reducer must pass the counterexample`,
      ).toEqual([]);
    }
    record('mutant', lines);
  });
});
