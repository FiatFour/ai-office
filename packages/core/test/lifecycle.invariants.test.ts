import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_KINDS } from '../src/lifecycle.js';
import { COVERAGE_KEYS, coverageLine, emptyHits, type Hits, tallySequence } from './coverage.js';
import { type Scenario, SEED, scenarioArb } from './generators.js';
import { checkProperty, INVARIANTS, record, type Step, summary, walk } from './harness.js';
import type { Invariant } from './oracle.js';

vi.setConfig({ testTimeout: 600_000 });

const RUNS = { stream: 100_000, deep: 20_000 };

interface Audit {
  readonly sequences: number;
  readonly counts: Record<Invariant, number>;
  readonly firstDetail: Partial<Record<Invariant, string>>;
  readonly movedOutOfShipped: number;
  readonly dispatchedTwice: number;
  readonly kinds: Set<string>;
  readonly hits: Hits;
  readonly seconds: number;
  readonly details: fc.RunDetails<[Scenario]>;
}

function audit(numRuns: number, deep: boolean): Audit {
  const counts = Object.fromEntries(INVARIANTS.map((name) => [name, 0])) as Record<Invariant, number>;
  const firstDetail: Partial<Record<Invariant, string>> = {};
  const hits = emptyHits();
  const kinds = new Set<string>();
  let movedOutOfShipped = 0;
  let dispatchedTwice = 0;
  const { details, seconds } = checkProperty(
    scenarioArb,
    ({ config, events }) => {
      const steps: Step[] = [];
      const result = walk(config, events, undefined, { deep, onStep: (step) => steps.push(step) });
      tallySequence(hits, steps);
      for (const command of result.commands) kinds.add(command.kind);
      const seen = new Set<Invariant>();
      for (const problem of result.problems) {
        seen.add(problem.invariant);
        firstDetail[problem.invariant] ??= problem.detail;
        if (/moved from shipped/.test(problem.detail)) movedOutOfShipped += 1;
        if (/emitted \d+ times|already left/.test(problem.detail) && /dispatch|truck/.test(problem.detail))
          dispatchedTwice += 1;
      }
      for (const name of seen) counts[name] += 1;
    },
    numRuns,
  );
  return { sequences: numRuns, counts, firstDetail, movedOutOfShipped, dispatchedTwice, kinds, hits, seconds, details };
}

let streamAudit: Audit | undefined;
let deepAudit: Audit | undefined;
const stream = () => (streamAudit ??= audit(RUNS.stream, false));
const deep = () => (deepAudit ??= audit(RUNS.deep, true));

function shrunk(invariant: Invariant, deepMode: boolean): string {
  const found = fc.check(
    fc.property(scenarioArb, ({ config, events }) => {
      const result = walk(config, events, undefined, { deep: deepMode });
      const problem = result.problems.find((entry) => entry.invariant === invariant);
      if (problem) throw new Error(problem.detail);
    }),
    { numRuns: 20_000, seed: SEED },
  );
  const value = found.counterexample?.[0] as Scenario | undefined;
  return value
    ? `${found.errorInstance instanceof Error ? found.errorInstance.message : ''}\n${value.events.length} events: ${JSON.stringify(value)}`
    : 'no counterexample on rerun';
}

function lane(name: string, invariant: Invariant, title: string, which: () => Audit, deepMode: boolean) {
  const result = which();
  record(name, [
    `${result.counts[invariant] === 0 ? 'PASS' : 'FAIL'} ${title}: sequences=${result.sequences} violating=${result.counts[invariant]} seed=${SEED} seconds=${result.seconds.toFixed(1)}`,
    ...(result.firstDetail[invariant] ? [`first: ${result.firstDetail[invariant]}`] : []),
    coverageLine(result.sequences, result.hits),
  ]);
  if (result.counts[invariant] > 0) expect.fail(`${title}: ${shrunk(invariant, deepMode)}`);
  return result;
}

describe('invariants over random event sequences', () => {
  it('lane 2: HQ never merges, over 100,000 random sequences (command stream) and 20,000 (oracle)', () => {
    const result = lane(
      'no-merge',
      'no-merge',
      'no command, alert reason or alert subject can carry a merge',
      stream,
      false,
    );
    const full = lane('no-merge-oracle', 'no-merge', 'same, with the oracle', deep, true);
    expect(COMMAND_KINDS.some((kind) => /merge/i.test(kind))).toBe(false);
    expect(result.kinds.size).toBeGreaterThanOrEqual(7);
    expect(full.kinds.size).toBeGreaterThanOrEqual(7);
  });

  it('lane 3: one task, one branch, one PR', () => {
    lane('one-to-one', 'one-to-one', 'one task = one branch = one PR', deep, true);
  });

  it('lane 4: the author and the builder never review their own PR', () => {
    const result = lane('author-review', 'author-never-reviews', 'author and builder never review', deep, true);
    expect(result.hits.merge).toBeGreaterThan(0);
  });

  it('lane 5: a box is at exactly one station', () => {
    const result = lane('one-station', 'one-station', 'a box is at exactly one station', deep, true);
    expect(result.hits.shipped).toBeGreaterThan(0);
    lane('one-station-stream', 'one-station', 'same, 100,000 sequences', stream, false);
  });

  it('lane 6: the truck leaves only when every PR in its shipment is merged', () => {
    const result = lane('shipment', 'shipment', 'no truck leaves with an unmerged change', deep, true);
    expect(result.hits.multiBoxDeparted).toBeGreaterThan(0);
    lane('shipment-stream', 'shipment', 'same, 100,000 sequences', stream, false);
  });

  it('lane 7: concurrent hires never exceed the machine budget', () => {
    const result = lane('budget', 'budget', 'running cage count never exceeds the cap', deep, true);
    expect(result.hits.budgetFullWithWaiting).toBeGreaterThan(0);
    lane('budget-stream', 'budget', 'same, 100,000 sequences', stream, false);
  });

  it('lane 11: transitions and the command stream', () => {
    for (const [name, which, deepMode] of [
      ['transition', deep, true],
      ['transition-stream', stream, false],
    ] as const) {
      const result = which();
      lane(
        `${name}-terminal`,
        'transition',
        'a departed shipment stays departed, a shipped box stays shipped, one truck per shipment',
        which,
        deepMode,
      );
      lane(
        `${name}-cages`,
        'cage-stream',
        'starts minus releases equals the running cages and never passes the budget, at every prefix',
        which,
        deepMode,
      );
      record(`${name}-counts`, [
        `sequences where a box moved out of shipped: ${result.movedOutOfShipped} of ${result.sequences}`,
        `sequences that dispatched a truck twice: ${result.dispatchedTwice} of ${result.sequences}`,
      ]);
      expect(result.movedOutOfShipped).toBe(0);
      expect(result.dispatchedTwice).toBe(0);
    }
  });

  it('lane 12: the reference model and the reducer agree on every station, reviewer and shipment', () => {
    lane('spec', 'spec', 'reducer equals the reference model', deep, true);
  });
});

describe('the generator reaches the interesting states', () => {
  it('lane 15: every state the mutants hide behind occurs, and multi-box shipments depart often', () => {
    const result = deep();
    record('coverage', [
      coverageLine(result.sequences, result.hits),
      `multi-box shipments that departed: ${((100 * result.hits.multiBoxDeparted) / result.sequences).toFixed(1)}% of sequences`,
    ]);
    const empty = COVERAGE_KEYS.filter((key) => result.hits[key] === 0);
    expect(empty, `never reached: ${empty.join(', ')}`).toEqual([]);
    expect(result.hits.multiBoxDeparted / result.sequences).toBeGreaterThanOrEqual(0.15);
    expect(summary('coverage run', result.details, result.seconds)).toContain('PASS');
  });
});
