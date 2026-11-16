import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { parseEvent } from '../../../spikes/P0-4/githost.mjs';
import {
  type Box,
  COMMAND_KINDS,
  type Command,
  type Config,
  createReducer,
  type Event,
  type HumanEvent,
  type InvariantName,
  initialState,
  type Reducer,
  reduce,
  STATIONS,
  type State,
  type Violation,
  violations,
} from '../src/lifecycle.js';

vi.setConfig({ testTimeout: 180_000 });

const EVIDENCE_DIR = process.env.LIFECYCLE_EVIDENCE_DIR;
if (EVIDENCE_DIR) mkdirSync(EVIDENCE_DIR, { recursive: true });

const RUNS = {
  noMerge: 100_000,
  invariant: 20_000,
  idempotent: 20_000,
  restart: 20_000,
  mutant: 4_000,
};

function record(lane: string, lines: string[]) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(`\n[${lane}]\n${text}`);
  if (EVIDENCE_DIR) writeFileSync(join(EVIDENCE_DIR, `${lane}.txt`), text);
}

const TASKS = ['a/t1', 'a/t2', 'a/t3', 'b/t1', 'b/t2', 'b/t3'];
const WORKERS = ['w1', 'w2', 'w3', 'peer'];
const REPOS = ['r1', 'r2'];
const SHAS = ['s1', 's2', 's3', 's4'];
const CHECKS = ['ci', 'lint'];
const SHIPMENTS = [null, null, { id: 'ship-a', size: 2 }, { id: 'ship-b', size: 3 }, { id: 'ship-a', size: 3 }];
const BRANCHES = [...TASKS.map((task) => `aw/${task}`), 'feature/x', 'aw/BAD'];
const LIFE = ['open', 'open', 'open', 'closed', 'merged'] as const;
const VERDICTS = ['approve', 'approve', 'changes', 'comment'] as const;
const CHECK_STATES = ['success', 'success', 'pending', 'failure'] as const;
const KIND_TABLE = [
  ...Array(5).fill('order'),
  ...Array(8).fill('hire'),
  ...Array(2).fill('add_worker'),
  'cancel',
  ...Array(3).fill('session_ended'),
  ...Array(22).fill('change'),
  ...Array(14).fill('review'),
  ...Array(18).fill('check'),
  ...Array(7).fill('poll'),
] as const;

const pick = <T>(items: readonly T[], n: number): T => items[n % items.length] as T;

type Ints = readonly [number, number, number, number, number, number, number, number];

function eventFromInts([k, a, b, c, d, e, f, g]: Ints): Event {
  const at = 1 + (g % 30);
  switch (pick(KIND_TABLE, k)) {
    case 'order':
      return { source: 'human', kind: 'order', task: pick([...TASKS, 'NOT A TASK'], a), shipment: pick(SHIPMENTS, b) };
    case 'hire':
      return { source: 'human', kind: 'hire', task: pick(TASKS, a), worker: pick(WORKERS, b) };
    case 'add_worker':
      return { source: 'human', kind: 'add_worker', worker: pick(WORKERS, a) };
    case 'cancel':
      return { source: 'human', kind: 'cancel', task: pick(TASKS, a) };
    case 'session_ended':
      return { source: 'hook', kind: 'session_ended', task: pick(TASKS, a), worker: pick(WORKERS, b) };
    case 'change':
      return {
        source: 'webhook',
        kind: 'change',
        repo: pick(REPOS, a),
        number: 1 + (b % 4),
        branch: pick(BRANCHES, c),
        author: pick(WORKERS, d),
        state: pick(LIFE, e),
        headSha: pick(SHAS, f),
        at,
      };
    case 'review':
      return {
        source: 'webhook',
        kind: 'review',
        repo: pick(REPOS, a),
        number: 1 + (b % 4),
        reviewer: pick(WORKERS, c),
        verdict: pick(VERDICTS, d),
        headSha: pick(SHAS, e),
        at,
      };
    case 'check':
      return {
        source: 'webhook',
        kind: 'check',
        repo: pick(REPOS, a),
        headSha: pick(SHAS, b),
        name: pick(CHECKS, c),
        state: pick(CHECK_STATES, d),
        at,
      };
    default:
      return {
        source: 'poll',
        repo: pick(REPOS, a),
        number: 1 + (b % 4),
        branch: pick(BRANCHES, c),
        author: pick(WORKERS, d),
        state: pick(LIFE, e),
        headSha: pick(SHAS, f),
        checks: [{ name: pick(CHECKS, a + b), state: pick(CHECK_STATES, c + d) }],
        reviews: [{ reviewer: pick(WORKERS, e + f), verdict: pick(VERDICTS, a + c) }],
        at,
      };
  }
}

const ints = fc.tuple(
  ...(Array(8).fill(fc.nat({ max: 1000 })) as [fc.Arbitrary<number>, ...fc.Arbitrary<number>[]]),
) as unknown as fc.Arbitrary<Ints>;
const arbitraryEvent = ints.map(eventFromInts);
const WEB = new Set(['webhook', 'poll']);
const isWeb = (event: Event) => WEB.has(event.source);

const configArb: fc.Arbitrary<Config> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 2 }))
  .map(([budget, approvals]) => ({ budget, approvals }));

interface StorySpec {
  readonly task: string;
  readonly shipment: { id: string; size: number } | null;
  readonly worker: string;
  readonly progress: number;
  readonly approver: 'peer' | 'author' | 'none';
  readonly checkOk: boolean;
}

function storyOf(spec: StorySpec, index: number): Event[] {
  const repo = pick(REPOS, index);
  const number = index + 1;
  const sha = `story-${index}`;
  const branch = `aw/${spec.task}`;
  const at = (step: number) => index * 10 + step + 1;
  const steps: Event[] = [
    { source: 'human', kind: 'order', task: spec.task, shipment: spec.shipment },
    { source: 'human', kind: 'hire', task: spec.task, worker: spec.worker },
    {
      source: 'webhook',
      kind: 'change',
      repo,
      number,
      branch,
      author: spec.worker,
      state: 'open',
      headSha: sha,
      at: at(2),
    },
    {
      source: 'webhook',
      kind: 'check',
      repo,
      headSha: sha,
      name: 'ci',
      state: spec.checkOk ? 'success' : 'failure',
      at: at(3),
    },
    ...(spec.approver === 'none'
      ? []
      : [
          {
            source: 'webhook',
            kind: 'review',
            repo,
            number,
            reviewer: spec.approver === 'peer' ? 'peer' : spec.worker,
            verdict: 'approve',
            headSha: sha,
            at: at(4),
          } satisfies Event,
        ]),
    {
      source: 'webhook',
      kind: 'change',
      repo,
      number,
      branch,
      author: spec.worker,
      state: 'merged',
      headSha: sha,
      at: at(5),
    },
  ];
  return steps.slice(0, spec.progress);
}

const shipmentFor = (n: number) =>
  pick<{ id: string; size: number } | null>([null, { id: 'ship-a', size: 2 }, { id: 'ship-a', size: 2 }], n);

const storySpecArb: fc.Arbitrary<StorySpec[]> = fc
  .array(
    fc.record({
      task: fc.constantFrom(...TASKS),
      shipment: fc.nat(2).map(shipmentFor),
      worker: fc.constantFrom('w1', 'w2', 'w3'),
      progress: fc.integer({ min: 1, max: 6 }),
      approver: fc.constantFrom('peer', 'author', 'none'),
      checkOk: fc.boolean(),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((specs) => specs.filter((spec, i) => specs.findIndex((other) => other.task === spec.task) === i));

const storyArb: fc.Arbitrary<Event[]> = fc
  .tuple(
    storySpecArb,
    fc.array(fc.nat(), { maxLength: 40 }),
    fc.array(arbitraryEvent, { maxLength: 6 }),
    fc.array(fc.nat(), { maxLength: 6 }),
  )
  .map(([specs, order, noise, noiseAt]) => {
    const queues = specs.map((spec, i) => storyOf(spec, i));
    const merged: Event[] = [];
    let cursor = 0;
    while (queues.some((queue) => queue.length > 0)) {
      const live = queues.filter((queue) => queue.length > 0);
      const queue = live[(order[cursor++] ?? 0) % live.length];
      const next = queue?.shift();
      if (next) merged.push(next);
    }
    for (const [i, event] of noise.entries()) merged.splice((noiseAt[i] ?? 0) % (merged.length + 1), 0, event);
    return merged;
  });

interface Scenario {
  readonly config: Config;
  readonly events: Event[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  config: configArb,
  events: fc.oneof(
    { weight: 3, arbitrary: fc.array(arbitraryEvent, { minLength: 1, maxLength: 50 }) },
    { weight: 2, arbitrary: storyArb },
  ),
});

interface Fold {
  readonly state: State;
  readonly commands: Command[];
  readonly problems: Violation[];
}

function fold(config: Config, events: readonly Event[], reducer: Reducer = reduce, only?: InvariantName): Fold {
  let state = initialState(config);
  const commands: Command[] = [];
  const problems: Violation[] = [];
  for (const event of events) {
    const step = reducer(state, event);
    state = step.state;
    commands.push(...step.commands);
    const found = [...violations(state, step.commands), ...truckViolations(state, step.commands)];
    problems.push(...found.filter((problem) => only === undefined || problem.invariant === only));
    if (problems.length > 0) break;
  }
  return { state, commands, problems };
}

function truckViolations(state: State, commands: readonly Command[]): Violation[] {
  return commands.flatMap((command) => {
    if (command.kind !== 'dispatch_truck') return [];
    const shipment = state.shipments[command.shipment];
    const ready =
      shipment?.members.every((id) => state.boxes[id]?.state === 'shipped') &&
      shipment.members.length === shipment.size;
    return ready ? [] : [{ invariant: 'shipment' as const, detail: `truck ${command.shipment} dispatched early` }];
  });
}

const Coverage = () => ({
  sequences: 0,
  shipped: 0,
  trucks: 0,
  merge: 0,
  qc: 0,
  building: 0,
  queued: 0,
  cancelled: 0,
  selfReviewIgnored: 0,
});
type Coverage = ReturnType<typeof Coverage>;

function tally(coverage: Coverage, result: Fold) {
  const stations = new Set(Object.values(result.state.boxes).map((box) => box.state));
  coverage.sequences += 1;
  if (stations.has('shipped')) coverage.shipped += 1;
  if (result.commands.some((command) => command.kind === 'dispatch_truck')) coverage.trucks += 1;
  if (stations.has('merge')) coverage.merge += 1;
  if (stations.has('qc')) coverage.qc += 1;
  if (stations.has('building')) coverage.building += 1;
  if (stations.has('belt')) coverage.queued += 1;
  if (stations.has('cancelled')) coverage.cancelled += 1;
}

const coverageLine = (coverage: Coverage) =>
  `coverage: ${coverage.sequences} sequences, ${coverage.shipped} ended with a shipped box, ${coverage.trucks} dispatched a truck, ${coverage.merge} ended at merge, ${coverage.qc} at qc, ${coverage.building} at building, ${coverage.queued} with a queued box, ${coverage.cancelled} with a cancelled box`;

function checkProperty<T>(arbitrary: fc.Arbitrary<T>, predicate: (value: T) => void, numRuns: number) {
  const started = performance.now();
  const details = fc.check(
    fc.property(arbitrary, (value) => {
      predicate(value);
    }),
    { numRuns },
  );
  return { details, seconds: (performance.now() - started) / 1000 };
}

function summary<T extends unknown[]>(name: string, details: fc.RunDetails<T>, seconds: number, wantFailure = false) {
  const outcome = details.failed === wantFailure ? (wantFailure ? 'CAUGHT' : 'PASS') : wantFailure ? 'MISSED' : 'FAIL';
  return `${outcome} ${name}: runs=${details.numRuns} counterexamples=${details.failed ? 1 : 0} seed=${details.seed} seconds=${seconds.toFixed(1)}`;
}

function invariantLane(lane: string, invariant: InvariantName, title: string, numRuns: number) {
  const coverage = Coverage();
  const { details, seconds } = checkProperty(
    scenarioArb,
    ({ config, events }) => {
      const result = fold(config, events, reduce, invariant);
      tally(coverage, result);
      if (result.problems.length > 0) throw new Error(result.problems.map((problem) => problem.detail).join('; '));
    },
    numRuns,
  );
  record(lane, [summary(title, details, seconds), coverageLine(coverage)]);
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  return coverage;
}

describe('invariants over random event sequences', () => {
  it('lane 2: HQ never merges, over 100,000 random sequences', () => {
    const coverage = Coverage();
    const kinds = new Set<string>();
    const { details, seconds } = checkProperty(
      scenarioArb,
      ({ config, events }) => {
        const result = fold(config, events, reduce, 'no-merge');
        tally(coverage, result);
        for (const command of result.commands) kinds.add(command.kind);
        if (result.problems.length > 0) throw new Error('merge command');
      },
      RUNS.noMerge,
    );
    record('no-merge', [
      summary('no sequence produces a merge command', details, seconds),
      `command kinds that exist: ${COMMAND_KINDS.join(', ')}`,
      `command kinds seen across the run: ${[...kinds].sort().join(', ')}`,
      coverageLine(coverage),
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
    expect(COMMAND_KINDS.some((kind) => /merge/i.test(kind))).toBe(false);
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('lane 3: one task, one branch, one PR', () => {
    invariantLane('one-to-one', 'one-to-one', 'one task = one branch = one PR', RUNS.invariant);
  });

  it('lane 4: the author never reviews its own PR', () => {
    const coverage = invariantLane(
      'author-review',
      'author-never-reviews',
      'author never reviews its own PR',
      RUNS.invariant,
    );
    expect(coverage.merge).toBeGreaterThan(0);
  });

  it('lane 5: a box is at exactly one station', () => {
    const coverage = invariantLane('one-station', 'one-station', 'a box is at exactly one station', RUNS.invariant);
    expect(coverage.shipped).toBeGreaterThan(0);
    expect(STATIONS.length).toBe(8);
  });

  it('lane 6: the truck leaves only when every PR in its shipment is merged', () => {
    const coverage = invariantLane('shipment', 'shipment', 'no truck leaves with an unmerged change', RUNS.invariant);
    expect(coverage.trucks).toBeGreaterThan(0);
  });

  it('lane 7: concurrent hires never exceed the machine budget', () => {
    const coverage = invariantLane('budget', 'budget', 'running cage count never exceeds the cap', RUNS.invariant);
    expect(coverage.building).toBeGreaterThan(0);
    expect(coverage.queued).toBeGreaterThan(0);
  });
});

const HIRE_STORM = fc.record({
  budget: fc.integer({ min: 1, max: 3 }),
  boxes: fc.integer({ min: 2, max: 6 }),
  order: fc.array(fc.nat(), { minLength: 6, maxLength: 12 }),
});

describe('machine budget', () => {
  it('queues the hire that would pass the cap and starts it when a cage frees', () => {
    const config = { budget: 1, approvals: 1 };
    const orders: Event[] = ['a/t1', 'a/t2'].map((task) => ({ source: 'human', kind: 'order', task, shipment: null }));
    const events: Event[] = [
      ...orders,
      { source: 'human', kind: 'hire', task: 'a/t1', worker: 'w1' },
      { source: 'human', kind: 'hire', task: 'a/t2', worker: 'w2' },
    ];
    const running = fold(config, events);
    expect(running.state.boxes['a/t1']?.state).toBe('building');
    expect(running.state.boxes['a/t2']?.state).toBe('belt');
    expect(running.commands.filter((command) => command.kind === 'start_cage')).toEqual([
      { kind: 'start_cage', task: 'a/t1', worker: 'w1' },
    ]);
    const freed = fold(config, [
      ...events,
      {
        source: 'webhook',
        kind: 'change',
        repo: 'r1',
        number: 1,
        branch: 'aw/a/t1',
        author: 'w1',
        state: 'open',
        headSha: 's1',
        at: 1,
      },
    ]);
    expect(freed.state.boxes['a/t1']?.state).toBe('test');
    expect(freed.state.boxes['a/t2']?.state).toBe('building');
    expect(freed.commands.at(-2)).toEqual({ kind: 'release_cage', task: 'a/t1' });
  });

  it('holds the cap against a storm of hires in any order', () => {
    const { details } = checkProperty(
      HIRE_STORM,
      ({ budget, boxes, order }) => {
        const tasks = TASKS.slice(0, boxes);
        const events: Event[] = [
          ...tasks.map((task): Event => ({ source: 'human', kind: 'order', task, shipment: null })),
          ...order.map(
            (n): Event => ({ source: 'human', kind: 'hire', task: pick(tasks, n), worker: pick(WORKERS, n + 1) }),
          ),
        ];
        const result = fold({ budget, approvals: 1 }, events, reduce, 'budget');
        expect(result.problems).toEqual([]);
        const building = Object.values(result.state.boxes).filter((box) => box.state === 'building').length;
        const hired = new Set(
          Object.values(result.state.boxes)
            .filter((box) => box.worker !== null)
            .map((box) => box.id),
        ).size;
        expect(building).toBe(Math.min(budget, hired));
      },
      1_000,
    );
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  });
});

function pinBranches(events: readonly Event[]): Event[] {
  const pinned = new Map<string, string>();
  return events.map((event) => {
    if (event.source === 'human' || event.source === 'hook') return event;
    if (event.source === 'webhook' && event.kind !== 'change') return event;
    const key = `${event.repo}#${event.number}`;
    const branch = pinned.get(key) ?? event.branch;
    pinned.set(key, branch);
    return { ...event, branch };
  });
}

function permute<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i % Math.max(keys.length, 1)] ?? 0, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((entry) => entry.item);
}

describe('idempotence', () => {
  it('lane 8: duplicate and reordered webhook and poll events reach the in-order end state', () => {
    const arb = fc.record({
      config: configArb,
      setup: fc.array(
        fc.oneof(
          ...TASKS.map((task) => fc.constant<Event>({ source: 'human', kind: 'order', task, shipment: null })),
          ...TASKS.slice(0, 4).map((task) =>
            fc.constant<Event>({ source: 'human', kind: 'order', task, shipment: { id: 'ship-a', size: 3 } }),
          ),
          arbitraryEvent.filter((event) => event.source === 'human'),
        ),
        { maxLength: 16 },
      ),
      web: fc
        .oneof(
          fc.array(arbitraryEvent.filter(isWeb), { minLength: 2, maxLength: 30 }),
          storyArb.map((events) => events.filter(isWeb)),
        )
        .map(pinBranches),
      keys: fc.array(fc.nat(), { minLength: 1, maxLength: 60 }),
      repeats: fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 60 }),
    });
    let nontrivial = 0;
    let reordered = 0;
    const { details, seconds } = checkProperty(
      arb,
      ({ config, setup, web, keys, repeats }) => {
        const ordered = fold(config, [...setup, ...web]);
        const noisy = permute(
          web.flatMap((event, i) => Array(1 + (repeats[i % repeats.length] ?? 0)).fill(event) as Event[]),
          keys,
        );
        const shuffled = fold(config, [...setup, ...noisy]);
        if (Object.keys(ordered.state.changes).length > 0) nontrivial += 1;
        if (noisy.length !== web.length) reordered += 1;
        expect(shuffled.state).toStrictEqual(ordered.state);
      },
      RUNS.idempotent,
    );
    record('idempotent', [
      summary(
        'end state of duplicated and reordered webhook and poll events equals the in-order end state',
        details,
        seconds,
      ),
      `${nontrivial} of ${details.numRuns} runs built at least one change, ${reordered} added duplicates`,
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
    expect(nontrivial).toBeGreaterThan(details.numRuns / 4);
  });

  it('a duplicate delivery changes nothing and emits no command', () => {
    const { details, seconds } = checkProperty(
      scenarioArb,
      ({ config, events }) => {
        let state = initialState(config);
        for (const event of events) {
          state = reduce(state, event).state;
          if (!isWeb(event)) continue;
          const again = reduce(state, event);
          expect(again.state).toBe(state);
          expect(again.commands).toEqual([]);
        }
      },
      RUNS.idempotent,
    );
    record('idempotent-duplicate', [summary('a repeated webhook or poll event is a no-op', details, seconds)]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  });
});

describe('restart', () => {
  it('lane 9: persist the state at a random cut, reload it and continue to the uncut end state', () => {
    const arb = fc.record({ scenario: scenarioArb, cut: fc.nat() });
    let cutsInside = 0;
    const { details, seconds } = checkProperty(
      arb,
      ({ scenario, cut }) => {
        const { config, events } = scenario;
        const at = events.length === 0 ? 0 : cut % (events.length + 1);
        const uncut = fold(config, events);
        const head = fold(config, events.slice(0, at));
        const reloaded = JSON.parse(JSON.stringify(head.state)) as State;
        expect(reloaded).toStrictEqual(head.state);
        let state = reloaded;
        const tail: Command[] = [];
        for (const event of events.slice(at)) {
          const step = reduce(state, event);
          state = step.state;
          tail.push(...step.commands);
        }
        expect(state).toStrictEqual(uncut.state);
        expect([...head.commands, ...tail]).toStrictEqual(uncut.commands);
        if (at > 0 && at < events.length) cutsInside += 1;
      },
      RUNS.restart,
    );
    record('restart', [
      summary('persist, reload, continue equals the uncut run', details, seconds),
      `${cutsInside} of ${details.numRuns} cuts fell inside the sequence`,
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
    expect(cutsInside).toBeGreaterThan(details.numRuns / 2);
  });
});

describe('the checks are not vacuous', () => {
  const authorMayReview = createReducer({ canReview: () => true });

  function runMutant(name: string, reducer: Reducer, only?: InvariantName) {
    const { details, seconds } = checkProperty(
      scenarioArb,
      ({ config, events }) => {
        const result = fold(config, events, reducer, only);
        if (result.problems.length > 0) throw new Error(result.problems.map((problem) => problem.detail).join('; '));
      },
      RUNS.mutant,
    );
    return { name, details, seconds };
  }

  function counterexample(details: fc.RunDetails<[Scenario]>): string {
    const value = details.counterexample?.[0] as Scenario | undefined;
    return value ? `${value.events.length} events after shrinking: ${JSON.stringify(value.events)}` : 'none';
  }

  it('lane 10: a reducer that lets the author review yields a counterexample', () => {
    const { details, seconds } = runMutant('author may review', authorMayReview, 'author-never-reviews');
    record('mutant', [
      summary('mutant reducer that lets the author review, checked for author-never-reviews', details, seconds, true),
      `numShrinks=${details.numShrinks}`,
      `counterexample: ${counterexample(details)}`,
      `error: ${details.errorInstance instanceof Error ? details.errorInstance.message : 'none'}`,
    ]);
    expect(details.failed).toBe(true);
    const found = details.counterexample?.[0];
    if (found === undefined) throw new Error('mutant run gave no counterexample');
    const control = fold(found.config, found.events, reduce, 'author-never-reviews');
    expect(control.problems).toEqual([]);
  });

  it('catches a truck that leaves early and a merge command', () => {
    const truckLeavesEarly: Reducer = (state, event) => {
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
    };
    const mergesIt: Reducer = (state, event) => {
      const step = reduce(state, event);
      const first = step.commands.find((command) => command.kind === 'notify_ready');
      return first
        ? { ...step, commands: [...step.commands, { kind: 'merge_pr', task: 'x' } as unknown as Command] }
        : step;
    };
    const early = runMutant('truck leaves early', truckLeavesEarly, 'shipment');
    const merging = runMutant('merge command', mergesIt, 'no-merge');
    record('mutant-extra', [
      summary('mutant: truck leaves on the first merged PR', early.details, early.seconds, true),
      summary('mutant: HQ emits a merge command', merging.details, merging.seconds, true),
    ]);
    expect(early.details.failed).toBe(true);
    expect(merging.details.failed).toBe(true);
  });
});

const FIXTURES = join(import.meta.dirname, '../../../spikes/P0-4/fixtures/github');

interface Recorded {
  readonly name: string;
  readonly event: string;
  readonly body: unknown;
}

const dig = (body: unknown, path: string): string => {
  let value = body;
  for (const key of path.split('.')) value = (value as Record<string, unknown>)[key];
  return String(value);
};

interface PullRequestBody {
  action: string;
  pull_request: { state: string; merged: boolean; updated_at: string; head: { sha: string } };
}

const asPullRequest = (fixture: Recorded) => fixture.body as PullRequestBody;

const loadFixture = (name: string): Recorded => {
  const file = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    event: string;
    body: unknown;
  };
  return { name, event: file.event, body: structuredClone(file.body) };
};

const VERDICT_OF: Record<string, 'approve' | 'changes' | 'comment'> = {
  approved: 'approve',
  changes_requested: 'changes',
  commented: 'comment',
};

function toLifecycleEvent(fixture: Recorded): Event | null {
  const parsed = parseEvent('github', fixture.event, fixture.body);
  if (parsed === null) return null;
  const at = (iso: string) => Date.parse(iso);
  if (parsed.kind === 'change') {
    return {
      source: 'webhook',
      kind: 'change',
      repo: parsed.repo,
      number: parsed.number,
      branch: parsed.branch,
      author: dig(fixture.body, 'pull_request.user.login'),
      state: parsed.state,
      headSha: parsed.headSha,
      at: at(dig(fixture.body, 'pull_request.updated_at')),
    };
  }
  if (parsed.kind === 'review') {
    return {
      source: 'webhook',
      kind: 'review',
      repo: parsed.repo,
      number: parsed.number,
      reviewer: dig(fixture.body, 'review.user.login'),
      verdict: VERDICT_OF[parsed.verdict] ?? 'comment',
      headSha: dig(fixture.body, 'review.commit_id'),
      at: at(dig(fixture.body, 'review.submitted_at')),
    };
  }
  if (parsed.kind === 'check') {
    const stamp =
      fixture.event === 'check_run' ? dig(fixture.body, 'check_run.completed_at') : dig(fixture.body, 'updated_at');
    return {
      source: 'webhook',
      kind: 'check',
      repo: parsed.repo,
      headSha: parsed.headSha,
      name: parsed.name,
      state: parsed.state,
      at: at(stamp),
    };
  }
  return null;
}

type Provenance = 'recorded' | 'synthetic';
interface LogStep {
  readonly from: Provenance;
  readonly label: string;
  readonly event: Event | null;
}

function replay(config: Config, steps: readonly LogStep[]) {
  let state = initialState(config);
  const lines: string[] = [];
  const trace: { state: State; commands: readonly Command[] }[] = [];
  for (const step of steps) {
    if (step.event === null) {
      lines.push(`${step.from.padEnd(9)} ${step.label} -> no lifecycle event (dropped on purpose)`);
      trace.push({ state, commands: [] });
      continue;
    }
    const next = reduce(state, step.event);
    state = next.state;
    trace.push(next);
    const boxes =
      Object.values(state.boxes)
        .map((box: Box) => `${box.id}=${box.state}`)
        .join(' ') || '(no boxes)';
    const cmds =
      next.commands
        .map((command) => (command.kind === 'alert_human' ? `alert_human(${command.reason})` : command.kind))
        .join(',') || '-';
    lines.push(`${step.from.padEnd(9)} ${step.label} -> ${boxes} | commands: ${cmds}`);
  }
  return { state, lines, trace, problems: violations(state) };
}

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;

const human = (event: WithoutSource<HumanEvent>): Event => ({ source: 'human', ...event }) as Event;

describe('replays of the P0-4 recorded GitHub fixtures', () => {
  const opened = loadFixture('pull_request-opened');
  const config: Config = { budget: 2, approvals: 1 };

  const alphaLog = (): LogStep[] => {
    const merged = structuredClone(opened);
    const body = asPullRequest(merged);
    body.action = 'closed';
    body.pull_request.state = 'closed';
    body.pull_request.merged = true;
    body.pull_request.updated_at = '2026-11-15T20:00:00Z';
    return [
      {
        from: 'synthetic',
        label: 'add_worker peer-reviewer (the scratch repo has one account)',
        event: human({ kind: 'add_worker', worker: 'peer-reviewer' }),
      },
      { from: 'synthetic', label: 'order alpha/t1', event: human({ kind: 'order', task: 'alpha/t1', shipment: null }) },
      {
        from: 'synthetic',
        label: 'hire FiatFour for alpha/t1',
        event: human({ kind: 'hire', task: 'alpha/t1', worker: 'FiatFour' }),
      },
      { from: 'recorded', label: 'push.json', event: toLifecycleEvent(loadFixture('push')) },
      { from: 'recorded', label: 'pull_request-opened.json (#1, aw/alpha/t1)', event: toLifecycleEvent(opened) },
      {
        from: 'recorded',
        label: 'status.json (agent-works/spike success)',
        event: toLifecycleEvent(loadFixture('status')),
      },
      {
        from: 'recorded',
        label: 'pull_request_review.json (FiatFour, the author, commented)',
        event: toLifecycleEvent(loadFixture('pull_request_review')),
      },
      {
        from: 'recorded',
        label: 'pull_request_review_comment.json',
        event: toLifecycleEvent(loadFixture('pull_request_review_comment')),
      },
      {
        from: 'synthetic',
        label: 'peer-reviewer approves bcd3c9d',
        event: {
          source: 'webhook',
          kind: 'review',
          repo: 'FiatFour/agent-works-scratch',
          number: 1,
          reviewer: 'peer-reviewer',
          verdict: 'approve',
          headSha: asPullRequest(opened).pull_request.head.sha,
          at: Date.parse('2026-11-15T19:30:00Z'),
        },
      },
      {
        from: 'synthetic',
        label: 'pull_request-opened.json with merged=true (the real merge webhook was never recorded)',
        event: toLifecycleEvent(merged),
      },
    ];
  };

  it('lane 1: the alpha/t1 log ends with the box shipped and the change merged', () => {
    const steps = alphaLog();
    const result = replay(config, steps);
    const header = [
      'replay of spikes/P0-4/fixtures/github through the lifecycle reducer',
      'recorded steps come from the P0-4 fixtures. synthetic steps fill what the one-account scratch repo cannot produce.',
      '',
    ];
    const afterRecorded = result.trace[7];
    const box = result.state.boxes['alpha/t1'];
    const change = result.state.changes['FiatFour/agent-works-scratch#1'];
    record('replay-github', [
      ...header,
      ...result.lines,
      '',
      `end state: box alpha/t1 = ${box?.state}, change FiatFour/agent-works-scratch#1 = ${change?.state}, shipment alpha/t1 = ${result.state.shipments['alpha/t1']?.state}`,
      `PASS=${box?.state === 'shipped' && change?.state === 'merged'}`,
    ]);
    expect(afterRecorded?.state.boxes['alpha/t1']).toMatchObject({
      state: 'qc',
      reviewer: 'peer-reviewer',
      changesRequested: false,
    });
    expect(result.trace[8]?.state.boxes['alpha/t1']?.state).toBe('merge');
    expect(result.trace[8]?.commands).toContainEqual({
      kind: 'notify_ready',
      task: 'alpha/t1',
      pr: 'FiatFour/agent-works-scratch#1',
    });
    expect(box).toMatchObject({ state: 'shipped' });
    expect(change?.state).toBe('merged');
    expect(result.trace[9]?.commands.map((command) => command.kind)).toEqual(['close_task', 'dispatch_truck']);
    expect(result.problems).toEqual([]);
  });

  it('the recorded self-review from the author does not advance the box', () => {
    const steps = alphaLog().slice(0, 8);
    const result = replay(config, steps);
    expect(result.state.boxes['alpha/t1']?.state).toBe('qc');
    expect(Object.values(result.state.reviews).flatMap((group) => Object.keys(group))).toEqual(['FiatFour']);
    const alone = replay(config, [steps[1] as LogStep, steps[2] as LogStep, ...steps.slice(4, 8)]);
    expect(alone.state.boxes['alpha/t1']).toMatchObject({ state: 'qc', reviewer: null });
    expect(alone.trace.flatMap((step) => step.commands)).toContainEqual({
      kind: 'alert_human',
      reason: 'no_peer_reviewer',
      subject: 'alpha/t1',
    });
  });

  it('the recorded closed payload cancels the box and blocks its shipment, and the merged variant ships it', () => {
    const closed = loadFixture('pull_request-closed');
    const setup: LogStep[] = [
      { from: 'synthetic', label: 'order beta/t2', event: human({ kind: 'order', task: 'beta/t2', shipment: null }) },
      {
        from: 'synthetic',
        label: 'hire FiatFour for beta/t2',
        event: human({ kind: 'hire', task: 'beta/t2', worker: 'FiatFour' }),
      },
    ];
    const unmerged = replay(config, [
      ...setup,
      { from: 'recorded', label: 'pull_request-closed.json (#2, merged=false)', event: toLifecycleEvent(closed) },
    ]);
    expect(unmerged.state.boxes['beta/t2']).toMatchObject({ state: 'cancelled', reason: 'closed' });
    expect(unmerged.state.shipments['beta/t2']?.state).toBe('blocked');
    expect(unmerged.trace.at(-1)?.commands.map((command) => command.kind)).toEqual([
      'release_cage',
      'alert_human',
      'alert_human',
    ]);
    const mergedBody = structuredClone(closed);
    asPullRequest(mergedBody).pull_request.merged = true;
    const merged = replay(config, [
      ...setup,
      { from: 'synthetic', label: 'pull_request-closed.json with merged=true', event: toLifecycleEvent(mergedBody) },
    ]);
    expect(merged.state.boxes['beta/t2']?.state).toBe('shipped');
    record('replay-github-closed', [...unmerged.lines, ...merged.lines]);
  });

  it('a check_run from another repo is kept as a fact and moves no box', () => {
    const checkRun = loadFixture('check_run-completed');
    const result = replay(config, [
      { from: 'recorded', label: 'check_run-completed.json', event: toLifecycleEvent(checkRun) },
    ]);
    expect(Object.keys(result.state.boxes)).toEqual([]);
    expect(Object.keys(result.state.checks)).toEqual([
      `FiatFour/ai-office|${dig(checkRun.body, 'check_run.head_sha')}`,
    ]);
  });

  it('accounts for every recorded fixture', () => {
    const mapped = [
      'push',
      'pull_request-opened',
      'pull_request-closed',
      'pull_request_review',
      'pull_request_review_comment',
      'status',
      'check_run-completed',
    ];
    const dropped = mapped.filter((name) => toLifecycleEvent(loadFixture(name)) === null);
    expect(dropped.sort()).toEqual(['pull_request_review_comment', 'push']);
  });
});

describe.skipIf(process.env.LIFECYCLE_PERF !== '1')('throughput', () => {
  const TOTAL = 1_000_000;
  const SEQUENCE = 200;
  const MINIMUM = 10_000;

  function generate(): Event[][] {
    let x = 123456789;
    const next = () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) % 1000;
    };
    return Array.from({ length: TOTAL / SEQUENCE }, () =>
      Array.from({ length: SEQUENCE }, () =>
        eventFromInts([next(), next(), next(), next(), next(), next(), next(), next()]),
      ),
    );
  }

  it('reduces one million generated events at least 10,000 per second, three runs', () => {
    const sequences = generate();
    const rates: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      let commands = 0;
      let events = 0;
      for (const sequence of sequences) {
        let state = initialState({ budget: 3, approvals: 1 });
        for (const event of sequence) {
          const step = reduce(state, event);
          state = step.state;
          commands += step.commands.length;
          events += 1;
        }
      }
      const seconds = (performance.now() - started) / 1000;
      rates.push(events / seconds);
      process.stdout.write(
        `throughput run ${run + 1}: ${events} events, ${commands} commands, ${seconds.toFixed(2)} s, ${Math.round(events / seconds)} events/s\n`,
      );
    }
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted[1] ?? 0;
    record('throughput', [
      `throughput over ${TOTAL} generated events, 3 runs, no baseline, trunk empty`,
      ...rates.map((rate, i) => `run ${i + 1}: ${Math.round(rate)} events/s`),
      `median ${Math.round(median)} events/s, minimum allowed ${MINIMUM}`,
      `${median >= MINIMUM ? 'PASS' : 'FAIL'}`,
    ]);
    expect(sorted[0]).toBeGreaterThanOrEqual(MINIMUM);
  });
});
