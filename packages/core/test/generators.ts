import fc from 'fast-check';
import type { Config, Event } from '../src/lifecycle.js';

export const SEED = Number(process.env.LIFECYCLE_SEED ?? 20261117);

export const TASKS = ['a/t1', 'a/t2', 'a/t3', 'b/t1', 'b/t2', 'b/t3'];
export const WORKERS = ['w1', 'W1', 'w2', 'W2', 'w3', 'peer', 'Peer', 'PEER'];
const REPOS = ['r1', 'r2', 'Org/R'];
const SHAS = ['s1', 's2', 's3', 's4'];
const CHECKS = ['ci', 'lint'];
const SHIPMENTS = [null, null, { id: 'ship-a', size: 2 }, { id: 'ship-b', size: 3 }, { id: 'ship-a', size: 3 }];
const BRANCHES = [...TASKS.map((task) => `aw/${task}`), 'feature/x', 'aw/BAD'];
const NUMBERS = [
  ...[9, 10, 9, 10, 1, 2, 3, 99, 100, 99, 100, 101, 98, 11],
  ...Array.from({ length: 30 }, (_, i) => i + 1),
];
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

export const pick = <T>(items: readonly T[], n: number): T => items[n % items.length] as T;

export type Ints = readonly [number, number, number, number, number, number, number, number];

export function eventFromInts([k, a, b, c, d, e, f, g]: Ints): Event {
  const at = 1 + (g % 30);
  const repo = pick(REPOS, a);
  const headRepo = (a + b + c + d + e + f) % 17 === 0 ? 'fork/x' : repo;
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
        repo,
        headRepo,
        number: pick(NUMBERS, b),
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
        repo,
        number: pick(NUMBERS, b),
        reviewer: pick(WORKERS, c),
        verdict: pick(VERDICTS, d),
        headSha: pick(SHAS, e),
        at,
      };
    case 'check':
      return {
        source: 'webhook',
        kind: 'check',
        repo,
        headSha: pick(SHAS, b),
        name: pick(CHECKS, c),
        state: pick(CHECK_STATES, d),
        at,
      };
    default:
      return {
        source: 'poll',
        repo,
        headRepo,
        number: pick(NUMBERS, b),
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

export const ints = fc.tuple(
  ...(Array(8).fill(fc.nat({ max: 1000 })) as [fc.Arbitrary<number>, ...fc.Arbitrary<number>[]]),
) as unknown as fc.Arbitrary<Ints>;
export const arbitraryEvent = ints.map(eventFromInts);
const WEB = new Set(['webhook', 'poll']);
export const isWeb = (event: Event) => WEB.has(event.source);

export const configArb: fc.Arbitrary<Config> = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 2 }))
  .map(([budget, approvals]) => ({ budget, approvals }));

export interface StorySpec {
  readonly task: string;
  readonly shipment: { id: string; size: number } | null;
  readonly worker: string;
  readonly numberSeed: number;
  readonly repo: string;
  readonly checkOk: boolean;
  readonly peers: number;
  readonly authorApproves: boolean;
  readonly changesFirst: boolean;
  readonly stale: boolean;
  readonly rename: boolean;
  readonly replace: boolean;
  readonly progress: number;
}

const PEERS = ['peer', 'Peer2', 'PEER3'];

export function storyOf(spec: StorySpec, index: number): Event[] {
  const base = index * 1000;
  let t = 0;
  const at = () => base + ++t;
  const { task, worker, repo } = spec;
  const branch = `aw/${task}`;
  const number = pick(NUMBERS, spec.numberSeed);
  const sha = `story-${index}-a`;
  const steps: Event[] = [
    { source: 'human', kind: 'order', task, shipment: spec.shipment },
    { source: 'human', kind: 'hire', task, worker },
  ];
  const open = (n: number, head: string, state: 'open' | 'closed' | 'merged'): Event => ({
    source: 'webhook',
    kind: 'change',
    repo,
    headRepo: repo,
    number: n,
    branch,
    author: worker,
    state,
    headSha: head,
    at: at(),
  });
  const checkOn = (head: string, ok: boolean): Event => ({
    source: 'webhook',
    kind: 'check',
    repo,
    headSha: head,
    name: 'ci',
    state: ok ? 'success' : 'failure',
    at: at(),
  });
  const reviewOn = (n: number, reviewer: string, verdict: 'approve' | 'changes', head: string): Event => ({
    source: 'webhook',
    kind: 'review',
    repo,
    number: n,
    reviewer,
    verdict,
    headSha: head,
    at: at(),
  });
  const approvals = (n: number, head: string): Event[] => [
    ...(spec.changesFirst ? [reviewOn(n, 'Blocker', 'changes', head)] : []),
    ...(spec.authorApproves ? [reviewOn(n, worker, 'approve', head)] : []),
    ...PEERS.slice(0, spec.peers).map((peer) => reviewOn(n, peer, 'approve', head)),
  ];
  let head = sha;
  steps.push(open(number, head, 'open'), checkOn(head, spec.checkOk));
  if (spec.stale) {
    steps.push(reviewOn(number, PEERS[0] as string, 'approve', head));
    head = `story-${index}-b`;
    steps.push(open(number, head, 'open'), checkOn(head, true));
  }
  if (spec.rename) {
    steps.push({
      source: 'webhook',
      kind: 'change',
      repo,
      headRepo: repo,
      number,
      branch: `aw/${pick(TASKS, spec.numberSeed + 1)}`,
      author: worker,
      state: 'open',
      headSha: head,
      at: at(),
    });
  }
  steps.push(...approvals(number, head));
  let finalNumber = number;
  if (spec.replace) {
    steps.push(open(number, head, 'closed'));
    finalNumber = number + 100;
    head = `story-${index}-c`;
    steps.push(open(finalNumber, head, 'open'), checkOn(head, true), ...approvals(finalNumber, head));
  }
  steps.push(open(finalNumber, head, 'merged'));
  return steps.slice(0, spec.progress);
}

const shipmentFor = (n: number) =>
  pick<{ id: string; size: number } | null>([null, { id: 'ship-a', size: 2 }, { id: 'ship-a', size: 2 }], n);

const storySpecBase = {
  task: fc.constantFrom(...TASKS),
  worker: fc.constantFrom('w1', 'W2', 'w3'),
  numberSeed: fc.nat(60),
  repo: fc.constantFrom(...REPOS),
  checkOk: fc.boolean(),
  peers: fc.integer({ min: 0, max: 3 }),
  authorApproves: fc.boolean(),
  changesFirst: fc.boolean(),
  stale: fc.boolean(),
  rename: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  replace: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
  progress: fc.integer({ min: 1, max: 26 }),
};

const distinctTasks = <T extends { task: string }>(specs: T[]) =>
  specs.filter((spec, i) => specs.findIndex((other) => other.task === spec.task) === i);

const storySpecArb: fc.Arbitrary<StorySpec[]> = fc
  .array(fc.record({ ...storySpecBase, shipment: fc.nat(2).map(shipmentFor) }), { minLength: 1, maxLength: 5 })
  .map(distinctTasks);

const shipmentSpecArb: fc.Arbitrary<StorySpec[]> = fc
  .tuple(
    fc.integer({ min: 2, max: 3 }),
    fc.array(fc.record({ ...storySpecBase, shipment: fc.constant(null), progress: fc.integer({ min: 20, max: 40 }) }), {
      minLength: 3,
      maxLength: 3,
    }),
    fc.integer({ min: 0, max: 5 }),
  )
  .map(([size, specs, drop]) => {
    const members = distinctTasks(specs).slice(0, size);
    return members.map((spec, i) => ({
      ...spec,
      shipment: { id: 'ship-s', size: drop === 0 ? size + 1 : size },
      checkOk: drop !== 1 || i > 0,
      peers: 3,
      authorApproves: false,
      changesFirst: false,
      stale: spec.stale && drop > 3,
    }));
  });

function interleave(specs: StorySpec[], order: number[], noise: Event[], noiseAt: number[]): Event[] {
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
}

const storyOver = (specs: fc.Arbitrary<StorySpec[]>) =>
  fc
    .tuple(
      specs,
      fc.array(fc.nat(), { maxLength: 60 }),
      fc.array(arbitraryEvent, { maxLength: 6 }),
      fc.array(fc.nat(), { maxLength: 6 }),
    )
    .map(([chosen, order, noise, noiseAt]) => interleave(chosen, order, noise, noiseAt));

export const storyArb: fc.Arbitrary<Event[]> = storyOver(storySpecArb);
export const shipmentStoryArb: fc.Arbitrary<Event[]> = storyOver(shipmentSpecArb);

export interface Scenario {
  readonly config: Config;
  readonly events: Event[];
}

export const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  config: configArb,
  events: fc.oneof(
    { weight: 3, arbitrary: fc.array(arbitraryEvent, { minLength: 1, maxLength: 50 }) },
    { weight: 3, arbitrary: storyArb },
    { weight: 3, arbitrary: shipmentStoryArb },
  ),
});
