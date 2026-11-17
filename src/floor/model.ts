import type { Box, State } from '@agent-works/core';

export const STATIONS = ['ORDER', 'CODE', 'TEST', 'QC', 'MERGE', 'SHIPPING'] as const;
export type StationLabel = (typeof STATIONS)[number];

export const STAMPS = ['SHIPPED', 'SCRAPPED', 'CHANGES'] as const;
export type Stamp = (typeof STAMPS)[number];

export const MOODS = ['working', 'needs', 'qc', 'break'] as const;
export type Mood = (typeof MOODS)[number];

export const ACTION_KINDS = [
  'ready_to_merge',
  'closed_unmerged',
  'round_limit',
  'website',
  'alert',
  'job_failed',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface SnapshotActionLike {
  readonly kind: string;
  readonly task?: string;
  readonly subject?: string;
  readonly site?: string;
  readonly url?: string;
}

export interface SnapshotLike {
  readonly rev: number;
  readonly state: State;
  readonly actions?: readonly SnapshotActionLike[];
}

export interface BoxView {
  readonly id: string;
  readonly code: string;
  readonly station: StationLabel | null;
  readonly stamp: Stamp | null;
  readonly shipment: string;
}

export interface ActionView {
  readonly key: string;
  readonly kind: ActionKind;
  readonly task: string | null;
  readonly worker: string | null;
  readonly detail: string | null;
  readonly url: string | null;
}

export interface WorkerView {
  readonly name: string;
  readonly mood: Mood;
  readonly task: string | null;
  readonly station: StationLabel | null;
  readonly actions: number;
}

export interface FloorView {
  readonly rev: number;
  readonly boxes: readonly BoxView[];
  readonly workers: readonly WorkerView[];
  readonly actions: readonly ActionView[];
  readonly counts: Readonly<Record<StationLabel, number>>;
  readonly shipped: number;
}

export const stationOf = (box: Box): { station: StationLabel | null; stamp: Stamp | null } => {
  switch (box.state) {
    case 'belt':
      return { station: 'ORDER', stamp: null };
    case 'building':
      return { station: 'CODE', stamp: null };
    case 'test':
      return { station: 'TEST', stamp: null };
    case 'qc':
      return { station: 'QC', stamp: box.changesRequested ? 'CHANGES' : null };
    case 'merge':
      return { station: 'MERGE', stamp: null };
    case 'shipping':
      return { station: 'SHIPPING', stamp: null };
    case 'shipped':
      return { station: 'SHIPPING', stamp: 'SHIPPED' };
    case 'cancelled':
      return { station: null, stamp: 'SCRAPPED' };
  }
};

const codeOf = (id: string): string => (id.split('/').pop() ?? id).toUpperCase();

const BUILDING = new Set<Box['state']>(['building', 'test', 'qc']);

const owners = (box: Box): readonly string[] => [
  ...new Set([...box.builders, ...(box.worker === null ? [] : [box.worker])]),
];

const actionOf = (action: SnapshotActionLike): { kind: ActionKind; detail: string | null } | null => {
  switch (action.kind) {
    case 'ready_to_merge':
      return { kind: 'ready_to_merge', detail: null };
    case 'round_limit':
      return { kind: 'round_limit', detail: null };
    case 'website':
      return { kind: 'website', detail: action.site ?? null };
    case 'alert':
      return { kind: 'alert', detail: action.subject ?? null };
    case 'job_failed':
      return { kind: 'job_failed', detail: action.subject ?? null };
    default:
      return null;
  }
};

const actionsOf = (state: State, fromSnapshot: readonly SnapshotActionLike[]): readonly ActionView[] => {
  const boxes = Object.values(state.boxes);
  const out = new Map<string, ActionView>();
  const add = (view: Omit<ActionView, 'key' | 'worker'>): void => {
    const key = `${view.kind}:${view.task ?? view.detail ?? ''}`;
    const seen = out.get(key);
    if (seen !== undefined) {
      if (seen.url === null && view.url !== null) out.set(key, { ...seen, url: view.url });
      return;
    }
    const box = view.task === null ? undefined : state.boxes[view.task];
    out.set(key, { ...view, key, worker: box === undefined ? null : (owners(box)[0] ?? null) });
  };
  for (const box of boxes) {
    if (box.state === 'merge') add({ kind: 'ready_to_merge', task: box.id, detail: null, url: null });
    if (box.state === 'cancelled' && box.reason === 'closed')
      add({ kind: 'closed_unmerged', task: box.id, detail: null, url: null });
  }
  for (const action of fromSnapshot) {
    const known = actionOf(action);
    if (known !== null) add({ ...known, task: action.task ?? null, url: action.url ?? null });
  }
  return [...out.values()];
};

const moodOf = (
  name: string,
  boxes: readonly Box[],
  actions: readonly ActionView[],
): Pick<WorkerView, 'mood' | 'task'> => {
  const mine = actions.find((action) => action.worker === name);
  if (mine !== undefined) return { mood: 'needs', task: mine.task };
  const reviewing = boxes.find((box) => box.state === 'qc' && box.reviewer === name);
  if (reviewing !== undefined) return { mood: 'qc', task: reviewing.id };
  const working = boxes.find((box) => box.worker === name && BUILDING.has(box.state));
  if (working !== undefined) return { mood: 'working', task: working.id };
  return { mood: 'break', task: null };
};

export const floorView = (snapshot: SnapshotLike): FloorView => {
  const { state } = snapshot;
  const boxes = Object.values(state.boxes).sort((a, b) => a.seq - b.seq);
  const actions = actionsOf(state, snapshot.actions ?? []);
  const names = new Set<string>(Object.keys(state.staff));
  for (const box of boxes) for (const owner of owners(box)) names.add(owner);
  const counts = Object.fromEntries(STATIONS.map((station) => [station, 0])) as Record<StationLabel, number>;
  const boxViews = boxes.map((box): BoxView => {
    const { station, stamp } = stationOf(box);
    if (station !== null) counts[station] += 1;
    return { id: box.id, code: codeOf(box.id), station, stamp, shipment: box.shipment };
  });
  const workers = [...names].sort().map((name): WorkerView => {
    const { mood, task } = moodOf(name, boxes, actions);
    const station = boxViews.find((box) => box.id === task)?.station ?? null;
    return { name, mood, task, station, actions: actions.filter((action) => action.worker === name).length };
  });
  return {
    rev: snapshot.rev,
    boxes: boxViews,
    workers,
    actions,
    counts,
    shipped: boxes.filter((box) => box.state === 'shipped').length,
  };
};
