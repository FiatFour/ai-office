import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Event, initialState, reduce, type State } from '@agent-works/core';
import { describe, expect, it } from 'vitest';
import { floorView, STATIONS, stationOf } from '../floor/model.ts';

const TASK = 'alpha/box-one';
const REPO = 'acme/app';
const HEAD = 'a'.repeat(40);

const run = (events: readonly Event[], budget = 3): State =>
  events.reduce((state, event) => reduce(state, event).state, initialState({ budget, approvals: 1 }));

const staff: Event[] = [
  { source: 'human', kind: 'add_worker', worker: 'nova' },
  { source: 'human', kind: 'add_worker', worker: 'vega' },
];
const order: Event = { source: 'human', kind: 'order', task: TASK, shipment: null };
const hire: Event = { source: 'human', kind: 'hire', task: TASK, worker: 'nova' };
const change = (state: 'open' | 'merged', at = 1000): Event => ({
  source: 'webhook',
  kind: 'change',
  repo: REPO,
  headRepo: REPO,
  number: 7,
  branch: `aw/${TASK}`,
  author: 'nova',
  state,
  headSha: HEAD,
  at,
});
const green: Event = {
  source: 'webhook',
  kind: 'check',
  repo: REPO,
  headSha: HEAD,
  name: 'ci',
  state: 'success',
  at: 1001,
};
const review = (verdict: 'approve' | 'changes'): Event => ({
  source: 'webhook',
  kind: 'review',
  repo: REPO,
  number: 7,
  reviewer: 'vega',
  verdict,
  headSha: HEAD,
  at: 1002,
});

const atBelt = [...staff, order];
const atCode = [...atBelt, hire];
const atTest = [...atCode, change('open')];
const atQc = [...atTest, green];
const atChanges = [...atQc, review('changes')];
const atMerge = [...atQc, review('approve')];
const atShipped = [...atMerge, change('merged', 2000)];

const view = (events: readonly Event[], actions: Parameters<typeof floorView>[0]['actions'] = []) =>
  floorView({ rev: events.length, state: run(events), actions });
const box = (events: readonly Event[]) => {
  const found = view(events).boxes[0];
  if (found === undefined) throw new Error('no box');
  return found;
};
const mood = (events: readonly Event[], name: string) =>
  view(events).workers.find((worker) => worker.name === name)?.mood;

describe('box station for each snapshot state', () => {
  it.each([
    ['belt', atBelt, 'ORDER', null],
    ['building', atCode, 'CODE', null],
    ['test', atTest, 'TEST', null],
    ['qc', atQc, 'QC', null],
    ['qc with changes requested', atChanges, 'QC', 'CHANGES'],
    ['merge', atMerge, 'MERGE', null],
    ['shipped', atShipped, 'SHIPPING', 'SHIPPED'],
  ] as const)('%s', (_name, events, station, stamp) => {
    expect(box(events)).toMatchObject({ id: TASK, station, stamp });
  });

  it('a box whose change merged inside a shipment that is still loading is at SHIPPING without the SHIPPED stamp', () => {
    const events: Event[] = [
      ...staff,
      { source: 'human', kind: 'order', task: TASK, shipment: { id: 's1', size: 2 } },
      { source: 'human', kind: 'order', task: 'alpha/box-two', shipment: { id: 's1', size: 2 } },
      hire,
      change('open'),
      change('merged', 2000),
    ];
    const first = view(events).boxes.find((found) => found.id === TASK);
    expect(first).toMatchObject({ station: 'SHIPPING', stamp: null, shipment: 's1' });
  });

  it('a cancelled box is off the belt and stamped SCRAPPED', () => {
    expect(box([...atCode, { source: 'human', kind: 'cancel', task: TASK }])).toMatchObject({
      station: null,
      stamp: 'SCRAPPED',
    });
  });

  it('covers every box state the reducer can produce', () => {
    const states = new Set(
      [
        atBelt,
        atCode,
        atTest,
        atQc,
        atMerge,
        atShipped,
        [...atCode, { source: 'human', kind: 'cancel', task: TASK } as Event],
      ].map((events) => run(events).boxes[TASK]?.state),
    );
    expect(states).toEqual(new Set(['belt', 'building', 'test', 'qc', 'merge', 'shipped', 'cancelled']));
  });

  it('stationOf takes a shipping box to SHIPPING with no stamp', () => {
    const shipping = { ...run(atMerge).boxes[TASK], state: 'shipping' } as Parameters<typeof stationOf>[0];
    expect(stationOf(shipping)).toEqual({ station: 'SHIPPING', stamp: null });
  });

  it('counts boxes per station and the shipped total', () => {
    const counts = view(atShipped).counts;
    expect(STATIONS.map((station) => counts[station])).toEqual([0, 0, 0, 0, 0, 1]);
    expect(view(atShipped).shipped).toBe(1);
    expect(view(atQc).shipped).toBe(0);
    expect(view(atQc).counts.QC).toBe(1);
  });

  it('keeps boxes in the order they were ordered', () => {
    const events: Event[] = [
      { source: 'human', kind: 'order', task: 'a/two', shipment: null },
      { source: 'human', kind: 'order', task: 'a/one', shipment: null },
    ];
    expect(view(events).boxes.map((found) => found.id)).toEqual(['a/two', 'a/one']);
  });
});

describe('worker state', () => {
  it('a hired worker with a box in CODE is Working, the idle one is On break', () => {
    expect(mood(atCode, 'nova')).toBe('working');
    expect(mood(atCode, 'vega')).toBe('break');
  });

  it('keeps Working while the box is in TEST and in QC with changes requested', () => {
    expect(mood(atTest, 'nova')).toBe('working');
    expect(mood(atChanges, 'nova')).toBe('working');
  });

  it('the reviewer of a box in QC is At QC', () => {
    expect(mood(atQc, 'vega')).toBe('qc');
    expect(mood(atQc, 'nova')).toBe('working');
  });

  it('only the reviewer of a box in QC is At QC', () => {
    expect(mood(atTest, 'vega')).toBe('break');
  });

  it('the builder of a box at MERGE Needs you and the reviewer goes On break', () => {
    expect(mood(atMerge, 'nova')).toBe('needs');
    expect(mood(atMerge, 'vega')).toBe('break');
  });

  it('Needs you wins over At QC and Working', () => {
    const second: Event[] = [
      { source: 'human', kind: 'order', task: 'beta/two', shipment: null },
      { source: 'human', kind: 'hire', task: 'beta/two', worker: 'nova' },
    ];
    expect(mood([...atMerge, ...second], 'nova')).toBe('needs');
  });

  it('Needs you wins over At QC', () => {
    const second: Event[] = [
      { source: 'human', kind: 'order', task: 'beta/two', shipment: null },
      { source: 'human', kind: 'hire', task: 'beta/two', worker: 'vega' },
      { ...change('open', 1500), number: 8, branch: 'aw/beta/two', author: 'vega', headSha: 'b'.repeat(40) } as Event,
      { ...green, headSha: 'b'.repeat(40) },
    ];
    const events = [...atMerge, ...second];
    expect(run(events).boxes['beta/two']).toMatchObject({ state: 'qc', reviewer: 'nova' });
    expect(mood(events, 'nova')).toBe('needs');
  });

  it('At QC wins over Working', () => {
    const events: Event[] = [
      ...atQc,
      { source: 'human', kind: 'order', task: 'beta/two', shipment: null },
      { source: 'human', kind: 'hire', task: 'beta/two', worker: 'vega' },
    ];
    expect(mood(events, 'vega')).toBe('qc');
  });

  it('a shipped box leaves both workers On break', () => {
    expect(mood(atShipped, 'nova')).toBe('break');
    expect(mood(atShipped, 'vega')).toBe('break');
  });

  it('a closed PR needs its builder', () => {
    const closed: Event = { ...change('open', 3000), state: 'closed' } as Event;
    expect(mood([...atTest, closed], 'nova')).toBe('needs');
    expect(view([...atTest, closed]).actions.map((action) => action.kind)).toEqual(['closed_unmerged']);
  });

  it('lists every worker from the staff and from the boxes, sorted', () => {
    expect(view(atCode).workers.map((worker) => worker.name)).toEqual(['nova', 'vega']);
  });

  it('gives a worker its box and the station of that box', () => {
    expect(view(atQc).workers.find((worker) => worker.name === 'vega')).toMatchObject({ task: TASK, station: 'QC' });
    expect(view(atCode).workers.find((worker) => worker.name === 'vega')).toMatchObject({ task: null, station: null });
  });
});

describe('Action items', () => {
  it('a box at MERGE is one ready_to_merge item owned by its builder', () => {
    expect(view(atMerge).actions).toEqual([
      { key: `ready_to_merge:${TASK}`, kind: 'ready_to_merge', task: TASK, worker: 'nova', detail: null, url: null },
    ]);
    expect(view(atMerge).workers.find((worker) => worker.name === 'nova')?.actions).toBe(1);
  });

  it('no item while nothing waits on a person', () => {
    expect(view(atQc).actions).toEqual([]);
  });

  it('an HQ item for the same task is not listed twice and keeps its link', () => {
    const merged = view(atMerge, [{ kind: 'ready_to_merge', task: TASK, url: 'https://example.test/pr/7' }]);
    expect(merged.actions).toHaveLength(1);
    expect(merged.actions[0]).toMatchObject({
      kind: 'ready_to_merge',
      worker: 'nova',
      url: 'https://example.test/pr/7',
    });
  });

  it('keeps the HQ items that name no box and drops kinds it does not know', () => {
    const items = view(atCode, [
      { kind: 'website', site: 'api.stripe.com' },
      { kind: 'alert', subject: 'alpha/x' },
      { kind: 'job_failed', task: TASK, subject: 'push' },
      { kind: 'round_limit', task: TASK, url: 'https://example.test/pr/8' },
      { kind: 'surprise' },
    ]).actions;
    expect(items.map((item) => item.kind)).toEqual(['website', 'alert', 'job_failed', 'round_limit']);
    expect(items[0]).toMatchObject({ detail: 'api.stripe.com', worker: null });
    expect(items[1]).toMatchObject({ detail: 'alpha/x', worker: null });
    expect(items[2]).toMatchObject({ detail: 'push' });
    expect(items[3]).toMatchObject({ url: 'https://example.test/pr/8', worker: 'nova' });
  });
});

describe('the recorded demo run', () => {
  const lines = readFileSync(join(import.meta.dirname, '../../fixtures/demo/events.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const events = lines.map((line) => (JSON.parse(line) as { event: Event }).event);

  it('takes the box through every station in order and ends at SHIPPING with the SHIPPED stamp', () => {
    let state = initialState({ budget: 3, approvals: 1 });
    const seen: string[] = [];
    for (const event of events) {
      state = reduce(state, event).state;
      const found = floorView({ rev: 0, state }).boxes[0];
      const station = found?.station;
      if (station !== undefined && station !== null && seen.at(-1) !== station) seen.push(station);
    }
    expect(seen).toEqual(['ORDER', 'CODE', 'TEST', 'QC', 'TEST', 'QC', 'MERGE', 'SHIPPING']);
    expect(floorView({ rev: 0, state }).boxes[0]).toMatchObject({ station: 'SHIPPING', stamp: 'SHIPPED' });
  });

  it('shows all four worker states at some point of the run', () => {
    let state = initialState({ budget: 3, approvals: 1 });
    const moods = new Set<string>();
    for (const event of events) {
      state = reduce(state, event).state;
      for (const worker of floorView({ rev: 0, state }).workers) moods.add(worker.mood);
    }
    expect(moods).toEqual(new Set(['working', 'needs', 'qc', 'break']));
  });
});
