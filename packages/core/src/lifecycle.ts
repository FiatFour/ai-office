export type TaskId = string;
export type ShipmentId = string;
export type PrKey = string;
export type CheckState = 'pending' | 'success' | 'failure';
export type Verdict = 'approve' | 'changes' | 'comment';
export type HostChangeState = 'open' | 'closed' | 'merged';

export interface Stamped<T> {
  readonly v: T;
  readonly at: number;
}

export interface Config {
  readonly budget: number;
  readonly approvals: number;
}

export interface Rules {
  canReview(reviewer: string, author: string): boolean;
}

export const STATIONS = ['belt', 'building', 'test', 'qc', 'merge', 'shipping', 'shipped', 'cancelled'] as const;
export type Station = (typeof STATIONS)[number];

interface BoxBase {
  readonly id: TaskId;
  readonly shipment: ShipmentId;
  readonly seq: number;
  readonly worker: string | null;
  readonly cancelled: boolean;
}

export type Box = BoxBase &
  (
    | { readonly state: 'belt' }
    | { readonly state: 'building' }
    | { readonly state: 'test'; readonly pr: PrKey }
    | { readonly state: 'qc'; readonly pr: PrKey; readonly reviewer: string | null; readonly changesRequested: boolean }
    | { readonly state: 'merge'; readonly pr: PrKey }
    | { readonly state: 'shipping'; readonly pr: PrKey }
    | { readonly state: 'shipped'; readonly pr: PrKey }
    | { readonly state: 'cancelled'; readonly reason: 'human' | 'closed' }
  );

export type Change = {
  readonly repo: string;
  readonly number: number;
  readonly branch: Stamped<string>;
  readonly author: Stamped<string>;
  readonly head: Stamped<string>;
  readonly at: number;
} & ({ readonly state: 'open' } | { readonly state: 'closed' } | { readonly state: 'merged' });

export type Shipment = {
  readonly id: ShipmentId;
  readonly size: number;
  readonly members: readonly TaskId[];
} & ({ readonly state: 'loading' } | { readonly state: 'blocked' } | { readonly state: 'departed' });

export interface State {
  readonly config: Config;
  readonly seq: number;
  readonly staff: Readonly<Record<string, true>>;
  readonly boxes: Readonly<Record<TaskId, Box>>;
  readonly changes: Readonly<Record<PrKey, Change>>;
  readonly checks: Readonly<Record<string, Readonly<Record<string, Stamped<CheckState>>>>>;
  readonly reviews: Readonly<Record<string, Readonly<Record<string, Stamped<Verdict>>>>>;
  readonly shipments: Readonly<Record<ShipmentId, Shipment>>;
}

export type HumanEvent =
  | { readonly source: 'human'; readonly kind: 'add_worker'; readonly worker: string }
  | {
      readonly source: 'human';
      readonly kind: 'order';
      readonly task: TaskId;
      readonly shipment: { readonly id: ShipmentId; readonly size: number } | null;
    }
  | { readonly source: 'human'; readonly kind: 'hire'; readonly task: TaskId; readonly worker: string }
  | { readonly source: 'human'; readonly kind: 'cancel'; readonly task: TaskId };

export type HookEvent = {
  readonly source: 'hook';
  readonly kind: 'session_ended';
  readonly task: TaskId;
  readonly worker: string;
};

export type HostFact =
  | {
      readonly kind: 'change';
      readonly repo: string;
      readonly number: number;
      readonly branch: string;
      readonly author: string;
      readonly state: HostChangeState;
      readonly headSha: string;
      readonly at: number;
    }
  | {
      readonly kind: 'review';
      readonly repo: string;
      readonly number: number;
      readonly reviewer: string;
      readonly verdict: Verdict;
      readonly headSha: string;
      readonly at: number;
    }
  | {
      readonly kind: 'check';
      readonly repo: string;
      readonly headSha: string;
      readonly name: string;
      readonly state: CheckState;
      readonly at: number;
    };

export type WebhookEvent = { readonly source: 'webhook' } & HostFact;

export interface PollEvent {
  readonly source: 'poll';
  readonly repo: string;
  readonly number: number;
  readonly branch: string;
  readonly author: string;
  readonly state: HostChangeState;
  readonly headSha: string;
  readonly checks: readonly { readonly name: string; readonly state: CheckState }[];
  readonly reviews: readonly { readonly reviewer: string; readonly verdict: Verdict }[];
  readonly at: number;
}

export type Event = HumanEvent | HookEvent | WebhookEvent | PollEvent;

export const COMMAND_KINDS = [
  'start_cage',
  'release_cage',
  'request_review',
  'send_review_to_author',
  'notify_ready',
  'close_task',
  'dispatch_truck',
  'alert_human',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export type AlertReason =
  | 'invalid_task'
  | 'unknown_task'
  | 'order_conflict'
  | 'no_peer_reviewer'
  | 'worker_ended_without_pr'
  | 'change_closed_unmerged'
  | 'duplicate_pr'
  | 'shipment_blocked';

export type Command =
  | { readonly kind: 'start_cage'; readonly task: TaskId; readonly worker: string }
  | { readonly kind: 'release_cage'; readonly task: TaskId }
  | { readonly kind: 'request_review'; readonly task: TaskId; readonly pr: PrKey; readonly reviewer: string }
  | { readonly kind: 'send_review_to_author'; readonly task: TaskId; readonly pr: PrKey }
  | { readonly kind: 'notify_ready'; readonly task: TaskId; readonly pr: PrKey }
  | { readonly kind: 'close_task'; readonly task: TaskId; readonly pr: PrKey }
  | { readonly kind: 'dispatch_truck'; readonly shipment: ShipmentId }
  | { readonly kind: 'alert_human'; readonly reason: AlertReason; readonly subject: string };

export interface Reduced {
  readonly state: State;
  readonly commands: readonly Command[];
}

const TASK = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const BRANCH = /^aw\/([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)$/;

export const branchOf = (task: TaskId): string => `aw/${task}`;
export const prKey = (repo: string, number: number): PrKey => `${repo}#${number}`;
export const taskOfBranch = (branch: string): TaskId | null => BRANCH.exec(branch)?.[1] ?? null;

export const defaultRules: Rules = { canReview: (reviewer, author) => reviewer !== author };

export const initialState = (config: Config): State => ({
  config,
  seq: 0,
  staff: {},
  boxes: {},
  changes: {},
  checks: {},
  reviews: {},
  shipments: {},
});

const get = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const put = <T>(record: Readonly<Record<string, T>>, key: string, value: T): Record<string, T> => ({
  ...record,
  [key]: value,
});

const joinStamped = <T extends string>(a: Stamped<T> | undefined, b: Stamped<T>): Stamped<T> => {
  if (a === undefined || b.at > a.at || (b.at === a.at && b.v > a.v)) return b;
  return a;
};

const LIFE_RANK: Record<HostChangeState, number> = { open: 0, closed: 1, merged: 2 };

const joinLife = (a: Change, state: HostChangeState, at: number): Pick<Change, 'state' | 'at'> => {
  if (a.state === 'merged') return { state: 'merged', at: state === 'merged' ? Math.max(a.at, at) : a.at };
  if (state === 'merged') return { state, at };
  if (at > a.at || (at === a.at && LIFE_RANK[state] > LIFE_RANK[a.state])) return { state, at };
  return { state: a.state, at: a.at };
};

function observeChange(state: State, fact: Extract<HostFact, { kind: 'change' }>): State {
  if (taskOfBranch(fact.branch) === null) return state;
  const key = prKey(fact.repo, fact.number);
  const before = get(state.changes, key);
  const branch = joinStamped(before?.branch, { v: fact.branch, at: fact.at });
  const author = joinStamped(before?.author, { v: fact.author, at: fact.at });
  const head = joinStamped(before?.head, { v: fact.headSha, at: fact.at });
  const life = before ? joinLife(before, fact.state, fact.at) : { state: fact.state, at: fact.at };
  if (
    before &&
    branch === before.branch &&
    author === before.author &&
    head === before.head &&
    life.state === before.state &&
    life.at === before.at
  ) {
    return state;
  }
  const change: Change = { repo: fact.repo, number: fact.number, branch, author, head, ...life };
  return { ...state, changes: put(state.changes, key, change) };
}

function observeReview(state: State, fact: Extract<HostFact, { kind: 'review' }>): State {
  const key = `${prKey(fact.repo, fact.number)}|${fact.headSha}`;
  const group = get(state.reviews, key) ?? {};
  const incoming: Stamped<Verdict> = { v: fact.verdict, at: fact.at };
  const before = get(group, fact.reviewer);
  const joined = joinStamped(before, incoming);
  if (joined === before) return state;
  return { ...state, reviews: put(state.reviews, key, put(group, fact.reviewer, joined)) };
}

function observeCheck(state: State, fact: Extract<HostFact, { kind: 'check' }>): State {
  const key = `${fact.repo}|${fact.headSha}`;
  const group = get(state.checks, key) ?? {};
  const incoming: Stamped<CheckState> = { v: fact.state, at: fact.at };
  const before = get(group, fact.name);
  const joined = joinStamped(before, incoming);
  if (joined === before) return state;
  return { ...state, checks: put(state.checks, key, put(group, fact.name, joined)) };
}

function observe(state: State, fact: HostFact): State {
  if (fact.kind === 'change') return observeChange(state, fact);
  if (fact.kind === 'review') return observeReview(state, fact);
  return observeCheck(state, fact);
}

function observePoll(state: State, poll: PollEvent): State {
  let next = observeChange(state, {
    kind: 'change',
    repo: poll.repo,
    number: poll.number,
    branch: poll.branch,
    author: poll.author,
    state: poll.state,
    headSha: poll.headSha,
    at: poll.at,
  });
  for (const check of poll.checks) {
    next = observeCheck(next, {
      kind: 'check',
      repo: poll.repo,
      headSha: poll.headSha,
      name: check.name,
      state: check.state,
      at: poll.at,
    });
  }
  for (const review of poll.reviews) {
    next = observeReview(next, {
      kind: 'review',
      repo: poll.repo,
      number: poll.number,
      reviewer: review.reviewer,
      verdict: review.verdict,
      headSha: poll.headSha,
      at: poll.at,
    });
  }
  return next;
}

const alert = (reason: AlertReason, subject: string): Command => ({ kind: 'alert_human', reason, subject });

function withBox(state: State, box: Box): State {
  return { ...state, boxes: put(state.boxes, box.id, box) };
}

function applyHuman(state: State, event: HumanEvent): Reduced {
  if (event.kind === 'add_worker') {
    if (Object.hasOwn(state.staff, event.worker)) return { state, commands: [] };
    return { state: { ...state, staff: put(state.staff, event.worker, true) }, commands: [] };
  }
  if (!TASK.test(event.task)) return { state, commands: [alert('invalid_task', event.task)] };
  const box = get(state.boxes, event.task);
  if (event.kind === 'order') return applyOrder(state, event, box);
  if (box === undefined) return { state, commands: [alert('unknown_task', event.task)] };
  if (event.kind === 'cancel') {
    return box.cancelled
      ? { state, commands: [] }
      : { state: withBox(state, { ...box, cancelled: true }), commands: [] };
  }
  const staff = Object.hasOwn(state.staff, event.worker) ? state.staff : put(state.staff, event.worker, true);
  const hired =
    box.state === 'belt' && box.worker !== event.worker ? withBox(state, { ...box, worker: event.worker }) : state;
  return { state: staff === state.staff ? hired : { ...hired, staff }, commands: [] };
}

function applyOrder(state: State, event: Extract<HumanEvent, { kind: 'order' }>, existing: Box | undefined): Reduced {
  const spec = event.shipment ?? { id: event.task, size: 1 };
  if (existing !== undefined) {
    return existing.shipment === spec.id
      ? { state, commands: [] }
      : { state, commands: [alert('order_conflict', event.task)] };
  }
  const shipment = get(state.shipments, spec.id);
  if (!Number.isInteger(spec.size) || spec.size < 1) return { state, commands: [alert('order_conflict', event.task)] };
  if (shipment !== undefined && (shipment.size !== spec.size || shipment.members.length >= shipment.size)) {
    return { state, commands: [alert('order_conflict', event.task)] };
  }
  const members = [...(shipment?.members ?? []), event.task];
  const nextShipment: Shipment = { id: spec.id, size: spec.size, members, state: 'loading' };
  const box: Box = { id: event.task, shipment: spec.id, seq: state.seq, worker: null, cancelled: false, state: 'belt' };
  return {
    state: {
      ...state,
      seq: state.seq + 1,
      boxes: put(state.boxes, box.id, box),
      shipments: put(state.shipments, spec.id, nextShipment),
    },
    commands: [],
  };
}

function applyHook(state: State, event: HookEvent): Reduced {
  const box = get(state.boxes, event.task);
  if (box === undefined) return { state, commands: [alert('unknown_task', event.task)] };
  if (box.worker !== event.worker) return { state, commands: [] };
  return { state: withBox(state, { ...box, worker: null }), commands: [] };
}

const sameShallow = (a: object, b: object): boolean => {
  const left = Object.entries(a);
  const right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(([key, value]) => Object.hasOwn(b, key) && (b as Record<string, unknown>)[key] === value)
  );
};

function branchIndex(changes: State['changes']): Map<string, PrKey[]> {
  const index = new Map<string, PrKey[]>();
  for (const key of Object.keys(changes).sort()) {
    const branch = changes[key]?.branch.v;
    if (branch === undefined) continue;
    const keys = index.get(branch);
    if (keys) keys.push(key);
    else index.set(branch, [key]);
  }
  return index;
}

export function strayChanges(state: State): PrKey[] {
  const strays: PrKey[] = [];
  for (const keys of branchIndex(state.changes).values()) strays.push(...keys.slice(1));
  return strays.sort();
}

function placeOnChange(state: State, rules: Rules, base: BoxBase, key: PrKey, change: Change): Box {
  if (change.state === 'merged') return { ...base, state: 'shipping', pr: key };
  if (base.cancelled) return { ...base, state: 'cancelled', reason: 'human' };
  if (change.state === 'closed') return { ...base, state: 'cancelled', reason: 'closed' };
  const checks = Object.values(get(state.checks, `${change.repo}|${change.head.v}`) ?? {});
  if (checks.length === 0 || !checks.every((check) => check.v === 'success'))
    return { ...base, state: 'test', pr: key };
  const author = change.author.v;
  const votes = Object.entries(get(state.reviews, `${key}|${change.head.v}`) ?? {}).filter(([reviewer]) =>
    rules.canReview(reviewer, author),
  );
  const changesRequested = votes.some(([, vote]) => vote.v === 'changes');
  const approvals = votes.filter(([, vote]) => vote.v === 'approve').length;
  if (!changesRequested && approvals >= state.config.approvals) return { ...base, state: 'merge', pr: key };
  const reviewer =
    Object.keys(state.staff)
      .sort()
      .find((worker) => rules.canReview(worker, author)) ?? null;
  return { ...base, state: 'qc', pr: key, reviewer, changesRequested };
}

const baseOf = (box: Box): BoxBase => ({
  id: box.id,
  shipment: box.shipment,
  seq: box.seq,
  worker: box.worker,
  cancelled: box.cancelled,
});

function settle(state: State, rules: Rules): State {
  const index = branchIndex(state.changes);
  const ordered = Object.values(state.boxes).sort((a, b) => a.seq - b.seq);
  const placed = new Map<TaskId, Box | 'wants_cage'>();
  let running = 0;
  for (const box of ordered) {
    const base = baseOf(box);
    const key = index.get(branchOf(box.id))?.[0];
    const change = key === undefined ? undefined : get(state.changes, key);
    if (key !== undefined && change !== undefined) placed.set(box.id, placeOnChange(state, rules, base, key, change));
    else if (box.cancelled) placed.set(box.id, { ...base, state: 'cancelled', reason: 'human' });
    else if (box.worker === null) placed.set(box.id, { ...base, state: 'belt' });
    else if (box.state === 'building') {
      running += 1;
      placed.set(box.id, { ...base, state: 'building' });
    } else placed.set(box.id, 'wants_cage');
  }
  let boxes: Record<TaskId, Box> = {};
  let changed = false;
  for (const box of ordered) {
    let next = placed.get(box.id);
    if (next === 'wants_cage' || next === undefined) {
      const base = baseOf(box);
      if (running < state.config.budget) {
        running += 1;
        next = { ...base, state: 'building' };
      } else next = { ...base, state: 'belt' };
    }
    if (sameShallow(box, next)) next = box;
    else changed = true;
    boxes[box.id] = next;
  }
  boxes = changed ? boxes : (state.boxes as Record<TaskId, Box>);
  const shipments = settleShipments(state.shipments, boxes);
  const finalBoxes = promoteShipped(boxes, shipments);
  const boxesChanged = changed || finalBoxes !== boxes;
  if (!boxesChanged && shipments === state.shipments) return state;
  return { ...state, boxes: boxesChanged ? finalBoxes : state.boxes, shipments };
}

function settleShipments(shipments: State['shipments'], boxes: Readonly<Record<TaskId, Box>>): State['shipments'] {
  let next: Record<ShipmentId, Shipment> | null = null;
  for (const shipment of Object.values(shipments)) {
    const members = shipment.members.map((id) => get(boxes, id));
    const complete = members.length === shipment.size;
    const merged = members.every((box) => box !== undefined && (box.state === 'shipping' || box.state === 'shipped'));
    const stuck = members.some((box) => box?.state === 'cancelled');
    const status = complete && merged ? 'departed' : stuck ? 'blocked' : 'loading';
    if (status !== shipment.state) {
      next ??= { ...shipments };
      next[shipment.id] = { ...shipment, state: status };
    }
  }
  return next ?? shipments;
}

function promoteShipped(
  boxes: Readonly<Record<TaskId, Box>>,
  shipments: State['shipments'],
): Readonly<Record<TaskId, Box>> {
  let next: Record<TaskId, Box> | null = null;
  for (const box of Object.values(boxes)) {
    if (box.state !== 'shipping' && box.state !== 'shipped') continue;
    const departed = get(shipments, box.shipment)?.state === 'departed';
    const want = departed ? 'shipped' : 'shipping';
    if (box.state !== want) {
      next ??= { ...boxes };
      next[box.id] = { ...box, state: want };
    }
  }
  return next ?? boxes;
}

function commandsBetween(before: State, after: State): Command[] {
  const commands: Command[] = [];
  for (const box of Object.values(after.boxes)) {
    const prev = get(before.boxes, box.id);
    if (prev === box) continue;
    if (prev?.state === 'building' && box.state !== 'building') {
      commands.push({ kind: 'release_cage', task: box.id });
      if (box.state === 'belt') commands.push(alert('worker_ended_without_pr', box.id));
    }
    if (box.state === 'building' && prev?.state !== 'building' && box.worker !== null) {
      commands.push({ kind: 'start_cage', task: box.id, worker: box.worker });
    }
    if (box.state === 'qc') {
      const entering = prev?.state !== 'qc';
      const reviewerChanged = prev?.state === 'qc' && prev.reviewer !== box.reviewer;
      if ((entering || reviewerChanged) && box.reviewer !== null) {
        commands.push({ kind: 'request_review', task: box.id, pr: box.pr, reviewer: box.reviewer });
      }
      if (entering && box.reviewer === null) commands.push(alert('no_peer_reviewer', box.id));
      const flagged = prev?.state === 'qc' ? prev.changesRequested : false;
      if (box.changesRequested && !flagged) commands.push({ kind: 'send_review_to_author', task: box.id, pr: box.pr });
    }
    if (box.state === 'merge' && prev?.state !== 'merge')
      commands.push({ kind: 'notify_ready', task: box.id, pr: box.pr });
    if (
      (box.state === 'shipping' || box.state === 'shipped') &&
      prev?.state !== 'shipping' &&
      prev?.state !== 'shipped'
    ) {
      commands.push({ kind: 'close_task', task: box.id, pr: box.pr });
    }
    if (box.state === 'cancelled' && box.reason === 'closed' && !(prev?.state === 'cancelled')) {
      commands.push(alert('change_closed_unmerged', box.id));
    }
  }
  for (const shipment of Object.values(after.shipments)) {
    const prev = get(before.shipments, shipment.id);
    if (prev?.state === shipment.state) continue;
    if (shipment.state === 'departed') commands.push({ kind: 'dispatch_truck', shipment: shipment.id });
    if (shipment.state === 'blocked') commands.push(alert('shipment_blocked', shipment.id));
  }
  if (before.changes !== after.changes) {
    const known = new Set(strayChanges(before));
    for (const stray of strayChanges(after)) if (!known.has(stray)) commands.push(alert('duplicate_pr', stray));
  }
  return commands;
}

export type Reducer = (state: State, event: Event) => Reduced;

export function createReducer(rules: Rules): Reducer {
  return (state, event) => {
    let applied: Reduced;
    if (event.source === 'human') applied = applyHuman(state, event);
    else if (event.source === 'hook') applied = applyHook(state, event);
    else if (event.source === 'poll') applied = { state: observePoll(state, event), commands: [] };
    else applied = { state: observe(state, event), commands: [] };
    if (applied.state === state) return applied;
    const settled = settle(applied.state, rules);
    return { state: settled, commands: [...applied.commands, ...commandsBetween(state, settled)] };
  };
}

export const reduce: Reducer = createReducer(defaultRules);

export type InvariantName = 'no-merge' | 'one-to-one' | 'author-never-reviews' | 'one-station' | 'shipment' | 'budget';

export interface Violation {
  readonly invariant: InvariantName;
  readonly detail: string;
}

export function commandViolations(commands: readonly Command[]): Violation[] {
  return commands
    .filter((command) => !(COMMAND_KINDS as readonly string[]).includes(command.kind) || /merge/i.test(command.kind))
    .map((command) => ({ invariant: 'no-merge', detail: `command ${command.kind}` }));
}

const CHANGE_STATE_OF_STATION: Record<string, readonly string[]> = {
  test: ['open'],
  qc: ['open'],
  merge: ['open'],
  shipping: ['merged'],
  shipped: ['merged'],
};

export function violations(state: State, commands: readonly Command[] = []): Violation[] {
  const found: Violation[] = commandViolations(commands);
  const add = (invariant: InvariantName, detail: string) => found.push({ invariant, detail });
  const boxes = Object.values(state.boxes);
  const byBranch = branchIndex(state.changes);
  const claimed = new Map<PrKey, TaskId>();

  for (const box of boxes) {
    if (!(STATIONS as readonly string[]).includes(box.state))
      add('one-station', `${box.id} is at unknown station ${box.state}`);
    const hasPr = 'pr' in box;
    if (box.state === 'building' && box.worker === null) add('one-station', `${box.id} is building without a worker`);
    const first = byBranch.get(branchOf(box.id))?.[0];
    if (box.state !== 'cancelled' && hasPr !== (first !== undefined)) {
      add('one-station', `${box.id} at ${box.state} disagrees with its change ${first ?? 'none'}`);
    }
    if (!hasPr) continue;
    const change = get(state.changes, box.pr);
    if (change === undefined) {
      add('one-to-one', `${box.id} points at missing change ${box.pr}`);
      continue;
    }
    if (change.branch.v !== branchOf(box.id))
      add('one-to-one', `${box.id} adopted ${box.pr} from branch ${change.branch.v}`);
    const owner = claimed.get(box.pr);
    if (owner !== undefined) add('one-to-one', `${box.pr} belongs to both ${owner} and ${box.id}`);
    claimed.set(box.pr, box.id);
    if (first !== box.pr) add('one-to-one', `${box.id} follows ${box.pr} but the branch's first change is ${first}`);
    if (!CHANGE_STATE_OF_STATION[box.state]?.includes(change.state))
      add('one-station', `${box.id} at ${box.state} but ${box.pr} is ${change.state}`);
    if (box.state === 'qc' || box.state === 'merge') {
      const author = change.author.v;
      if (box.state === 'qc' && box.reviewer !== null && box.reviewer === author) {
        add('author-never-reviews', `${box.id} assigns its author ${author} as reviewer`);
      }
      const votes = Object.entries(get(state.reviews, `${box.pr}|${change.head.v}`) ?? {});
      const peers = votes.filter(([reviewer]) => reviewer !== author);
      if (box.state === 'merge') {
        const approvals = peers.filter(([, vote]) => vote.v === 'approve').length;
        if (approvals < state.config.approvals)
          add('author-never-reviews', `${box.id} is ready on ${approvals} peer approvals`);
        if (peers.some(([, vote]) => vote.v === 'changes'))
          add('author-never-reviews', `${box.id} is ready past a peer's changes request`);
      }
    }
    if (box.state === 'shipped' && get(state.shipments, box.shipment)?.state !== 'departed') {
      add('shipment', `${box.id} is shipped but shipment ${box.shipment} has not left`);
    }
  }

  const running = boxes.filter((box) => box.state === 'building');
  if (running.length > state.config.budget)
    add('budget', `${running.length} cages running, budget ${state.config.budget}`);

  for (const shipment of Object.values(state.shipments)) {
    const members = shipment.members.map((id) => get(state.boxes, id));
    if (members.some((member) => member === undefined || member.shipment !== shipment.id)) {
      add('shipment', `${shipment.id} lists a member that is missing or ships elsewhere`);
    }
    if (shipment.state !== 'departed') continue;
    if (shipment.members.length !== shipment.size)
      add('shipment', `${shipment.id} left with ${shipment.members.length} of ${shipment.size} boxes`);
    for (const member of members) {
      const change = member !== undefined && 'pr' in member ? get(state.changes, member.pr) : undefined;
      if (change?.state !== 'merged') add('shipment', `${shipment.id} left but ${member?.id} is not merged`);
    }
  }
  return found;
}
