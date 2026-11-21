declare const loginBrand: unique symbol;
export type Login = string & { readonly [loginBrand]: true };
export const toLogin = (raw: string): Login => raw.toLowerCase() as Login;

export type TaskId = string;
export type ShipmentId = string;
export type PrKey = string & { readonly prKey: true };
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
  canReview(reviewer: Login, author: Login): boolean;
}

export const STATIONS = ['belt', 'building', 'test', 'qc', 'merge', 'shipping', 'shipped', 'cancelled'] as const;
export type Station = (typeof STATIONS)[number];

interface BoxBase {
  readonly id: TaskId;
  readonly shipment: ShipmentId;
  readonly seq: number;
  readonly worker: Login | null;
  readonly builders: readonly Login[];
  readonly cancelled: boolean;
}

export type Box = BoxBase &
  (
    | { readonly state: 'belt' }
    | { readonly state: 'building' }
    | { readonly state: 'test'; readonly pr: PrKey }
    | { readonly state: 'qc'; readonly pr: PrKey; readonly reviewer: Login | null; readonly changesRequested: boolean }
    | { readonly state: 'merge'; readonly pr: PrKey }
    | { readonly state: 'shipping'; readonly pr: PrKey }
    | { readonly state: 'shipped'; readonly pr: PrKey }
    | { readonly state: 'cancelled'; readonly reason: 'human' | 'closed' }
  );

export type Change = {
  readonly repo: string;
  readonly number: number;
  readonly branch: string;
  readonly author: Stamped<Login>;
  readonly head: Stamped<string>;
  readonly first: number;
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
  readonly changes: Readonly<Record<string, Change>>;
  readonly checks: Readonly<Record<string, Readonly<Record<string, Stamped<CheckState>>>>>;
  readonly reviews: Readonly<Record<string, Readonly<Record<string, Stamped<Verdict>>>>>;
  readonly shipments: Readonly<Record<ShipmentId, Shipment>>;
}

export type HumanEvent<L extends string = string> =
  | { readonly source: 'human'; readonly kind: 'add_worker'; readonly worker: L }
  | {
      readonly source: 'human';
      readonly kind: 'order';
      readonly task: TaskId;
      readonly shipment: { readonly id: ShipmentId; readonly size: number } | null;
    }
  | { readonly source: 'human'; readonly kind: 'hire'; readonly task: TaskId; readonly worker: L }
  | { readonly source: 'human'; readonly kind: 'cancel'; readonly task: TaskId };

export type HookEvent<L extends string = string> = {
  readonly source: 'hook';
  readonly kind: 'session_ended';
  readonly task: TaskId;
  readonly worker: L;
};

export type HostFact<L extends string = string> =
  | {
      readonly kind: 'change';
      readonly repo: string;
      readonly headRepo: string;
      readonly number: number;
      readonly branch: string;
      readonly author: L;
      readonly state: HostChangeState;
      readonly headSha: string;
      readonly at: number;
    }
  | {
      readonly kind: 'review';
      readonly repo: string;
      readonly number: number;
      readonly reviewer: L;
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

export type WebhookEvent<L extends string = string> = { readonly source: 'webhook' } & HostFact<L>;

export interface PollEvent<L extends string = string> {
  readonly source: 'poll';
  readonly repo: string;
  readonly headRepo: string;
  readonly number: number;
  readonly branch: string;
  readonly author: L;
  readonly state: HostChangeState;
  readonly headSha: string;
  readonly checks: readonly { readonly name: string; readonly state: CheckState }[];
  readonly reviews: readonly { readonly reviewer: L; readonly verdict: Verdict }[];
  readonly at: number;
}

export type Event<L extends string = string> = HumanEvent<L> | HookEvent<L> | WebhookEvent<L> | PollEvent<L>;

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

export const ALERT_REASONS = [
  'invalid_task',
  'unknown_task',
  'order_conflict',
  'no_peer_reviewer',
  'worker_ended_without_pr',
  'change_closed_unmerged',
  'duplicate_pr',
  'change_branch_moved',
  'shipment_blocked',
  'hire_refused',
  'cancel_refused',
] as const;
export type AlertReason = (typeof ALERT_REASONS)[number];

export type Command =
  | { readonly kind: 'start_cage'; readonly task: TaskId; readonly worker: Login }
  | { readonly kind: 'release_cage'; readonly task: TaskId }
  | { readonly kind: 'request_review'; readonly task: TaskId; readonly pr: PrKey; readonly reviewer: Login }
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
export const taskOfBranch = (branch: string): TaskId | null => BRANCH.exec(branch)?.[1] ?? null;
const hostRef = (repo: string, number: number): string => `${repo}#${number}`;
const changeKey = (repo: string, number: number, branch: string): PrKey => `${repo}#${number}@${branch}` as PrKey;
const keyOf = (change: Pick<Change, 'repo' | 'number' | 'branch'>): PrKey =>
  changeKey(change.repo, change.number, change.branch);

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

const logins = (record: Readonly<Record<string, unknown>>): Login[] => Object.keys(record) as Login[];

function canonical(event: Event): Event<Login> {
  if (event.source === 'human') {
    return event.kind === 'add_worker' || event.kind === 'hire' ? { ...event, worker: toLogin(event.worker) } : event;
  }
  if (event.source === 'hook') return { ...event, worker: toLogin(event.worker) };
  const repo = event.repo.toLowerCase();
  if (event.source === 'poll') {
    return {
      ...event,
      repo,
      headRepo: event.headRepo.toLowerCase(),
      author: toLogin(event.author),
      reviews: event.reviews.map((review) => ({ ...review, reviewer: toLogin(review.reviewer) })),
    };
  }
  if (event.kind === 'change') {
    return { ...event, repo, headRepo: event.headRepo.toLowerCase(), author: toLogin(event.author) };
  }
  if (event.kind === 'review') return { ...event, repo, reviewer: toLogin(event.reviewer) };
  return { ...event, repo };
}

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

function observeChange(state: State, fact: Extract<HostFact<Login>, { kind: 'change' }>): State {
  if (taskOfBranch(fact.branch) === null) return state;
  if (fact.headRepo !== fact.repo) return state;
  const key = changeKey(fact.repo, fact.number, fact.branch);
  const before = get(state.changes, key);
  const author = joinStamped(before?.author, { v: fact.author, at: fact.at });
  const head = joinStamped(before?.head, { v: fact.headSha, at: fact.at });
  const life = before ? joinLife(before, fact.state, fact.at) : { state: fact.state, at: fact.at };
  const first = before ? Math.min(before.first, fact.at) : fact.at;
  if (
    before &&
    author === before.author &&
    head === before.head &&
    first === before.first &&
    life.state === before.state &&
    life.at === before.at
  ) {
    return state;
  }
  const change: Change = { repo: fact.repo, number: fact.number, branch: fact.branch, author, head, first, ...life };
  return { ...state, changes: put(state.changes, key, change) };
}

function observeReview(state: State, fact: Extract<HostFact<Login>, { kind: 'review' }>): State {
  const key = `${hostRef(fact.repo, fact.number)}|${fact.headSha}`;
  const group = get(state.reviews, key) ?? {};
  const incoming: Stamped<Verdict> = { v: fact.verdict, at: fact.at };
  const before = get(group, fact.reviewer);
  const joined = joinStamped(before, incoming);
  if (joined === before) return state;
  return { ...state, reviews: put(state.reviews, key, put(group, fact.reviewer, joined)) };
}

function observeCheck(state: State, fact: Extract<HostFact<Login>, { kind: 'check' }>): State {
  const key = `${fact.repo}|${fact.headSha}`;
  const group = get(state.checks, key) ?? {};
  const incoming: Stamped<CheckState> = { v: fact.state, at: fact.at };
  const before = get(group, fact.name);
  const joined = joinStamped(before, incoming);
  if (joined === before) return state;
  return { ...state, checks: put(state.checks, key, put(group, fact.name, joined)) };
}

function observe(state: State, fact: HostFact<Login>): State {
  if (fact.kind === 'change') return observeChange(state, fact);
  if (fact.kind === 'review') return observeReview(state, fact);
  return observeCheck(state, fact);
}

function observePoll(state: State, poll: PollEvent<Login>): State {
  let next = observeChange(state, {
    kind: 'change',
    repo: poll.repo,
    headRepo: poll.headRepo,
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

function applyHuman(state: State, event: HumanEvent<Login>): Reduced {
  if (event.kind === 'add_worker') {
    if (Object.hasOwn(state.staff, event.worker)) return { state, commands: [] };
    return { state: { ...state, staff: put(state.staff, event.worker, true) }, commands: [] };
  }
  if (!TASK.test(event.task)) return { state, commands: [alert('invalid_task', event.task)] };
  const box = get(state.boxes, event.task);
  if (event.kind === 'order') return applyOrder(state, event, box);
  if (box === undefined) return { state, commands: [alert('unknown_task', event.task)] };
  if (event.kind === 'cancel') {
    if (box.state === 'shipping' || box.state === 'shipped')
      return { state, commands: [alert('cancel_refused', box.id)] };
    return box.cancelled
      ? { state, commands: [] }
      : { state: withBox(state, { ...box, cancelled: true }), commands: [] };
  }
  if (box.worker === event.worker) return { state, commands: [] };
  if (box.state !== 'belt') return { state, commands: [alert('hire_refused', box.id)] };
  const builders = [...new Set([...box.builders, event.worker])].sort();
  const hired = withBox(state, { ...box, worker: event.worker, builders });
  const staff = Object.hasOwn(state.staff, event.worker) ? state.staff : put(state.staff, event.worker, true);
  return { state: staff === state.staff ? hired : { ...hired, staff }, commands: [] };
}

function applyOrder(
  state: State,
  event: Extract<HumanEvent<Login>, { kind: 'order' }>,
  existing: Box | undefined,
): Reduced {
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
  const box: Box = {
    id: event.task,
    shipment: spec.id,
    seq: state.seq,
    worker: null,
    builders: [],
    cancelled: false,
    state: 'belt',
  };
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

function applyHook(state: State, event: HookEvent<Login>): Reduced {
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

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareChange = (a: Change, b: Change): number =>
  Number(a.state === 'closed') - Number(b.state === 'closed') ||
  a.first - b.first ||
  compareText(a.repo, b.repo) ||
  a.number - b.number;

function changesByBranch(changes: State['changes'], branches: ReadonlySet<string>): Map<string, Change[]> {
  const index = new Map<string, Change[]>();
  for (const change of Object.values(changes)) {
    if (!branches.has(change.branch)) continue;
    const list = index.get(change.branch);
    if (list) list.push(change);
    else index.set(change.branch, [change]);
  }
  for (const list of index.values()) list.sort(compareChange);
  return index;
}

function strayKeys(changes: State['changes'], branch: string): PrKey[] {
  const onBranch = Object.values(changes)
    .filter((change) => change.branch === branch)
    .sort(compareChange);
  return onBranch
    .slice(1)
    .filter((change) => change.state !== 'closed')
    .map(keyOf);
}

function placeOnChange(state: State, rules: Rules, base: BoxBase, change: Change): Box {
  const key = keyOf(change);
  if (change.state === 'merged') return { ...base, state: 'shipping', pr: key };
  if (base.cancelled) return { ...base, state: 'cancelled', reason: 'human' };
  if (change.state === 'closed') return { ...base, state: 'cancelled', reason: 'closed' };
  const checks = Object.values(get(state.checks, `${change.repo}|${change.head.v}`) ?? {});
  if (checks.length === 0 || !checks.every((check) => check.v === 'success'))
    return { ...base, state: 'test', pr: key };
  const author = change.author.v;
  const eligible = (login: Login) => !base.builders.includes(login) && rules.canReview(login, author);
  const votes = Object.entries(
    get(state.reviews, `${hostRef(change.repo, change.number)}|${change.head.v}`) ?? {},
  ).filter(([reviewer]) => eligible(reviewer as Login));
  const changesRequested = votes.some(([, vote]) => vote.v === 'changes');
  const approvals = votes.filter(([, vote]) => vote.v === 'approve').length;
  if (!changesRequested && approvals >= state.config.approvals) return { ...base, state: 'merge', pr: key };
  const reviewer = logins(state.staff).sort().find(eligible) ?? null;
  return { ...base, state: 'qc', pr: key, reviewer, changesRequested };
}

const baseOf = (box: Box): BoxBase => ({
  id: box.id,
  shipment: box.shipment,
  seq: box.seq,
  worker: box.worker,
  builders: box.builders,
  cancelled: box.cancelled,
});

function settle(state: State, rules: Rules): State {
  const live = Object.values(state.boxes)
    .filter((box) => box.state !== 'shipping' && box.state !== 'shipped')
    .sort((a, b) => a.seq - b.seq);
  const index = changesByBranch(state.changes, new Set(live.map((box) => branchOf(box.id))));
  const placed = new Map<TaskId, Box | 'wants_cage'>();
  let running = 0;
  for (const box of live) {
    const base = baseOf(box);
    const change = index.get(branchOf(box.id))?.[0];
    if (change !== undefined) placed.set(box.id, placeOnChange(state, rules, base, change));
    else if (box.cancelled) placed.set(box.id, { ...base, state: 'cancelled', reason: 'human' });
    else if (box.worker === null) placed.set(box.id, { ...base, state: 'belt' });
    else if (box.state === 'building') {
      running += 1;
      placed.set(box.id, { ...base, state: 'building' });
    } else placed.set(box.id, 'wants_cage');
  }
  let boxes: Record<TaskId, Box> | null = null;
  for (const box of live) {
    let next = placed.get(box.id);
    if (next === 'wants_cage' || next === undefined) {
      const base = baseOf(box);
      if (running < state.config.budget) {
        running += 1;
        next = { ...base, state: 'building' };
      } else next = { ...base, state: 'belt' };
    }
    if (sameShallow(box, next)) continue;
    boxes ??= { ...state.boxes };
    boxes[box.id] = next;
  }
  const settled = boxes ?? state.boxes;
  const shipments = settleShipments(state.shipments, settled);
  const finalBoxes = promoteShipped(settled, shipments);
  if (finalBoxes === state.boxes && shipments === state.shipments) return state;
  return { ...state, boxes: finalBoxes, shipments };
}

function settleShipments(shipments: State['shipments'], boxes: Readonly<Record<TaskId, Box>>): State['shipments'] {
  let next: Record<ShipmentId, Shipment> | null = null;
  for (const shipment of Object.values(shipments)) {
    if (shipment.state === 'departed') continue;
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
    if (box.state !== 'shipping') continue;
    if (get(shipments, box.shipment)?.state === 'departed') {
      next ??= { ...boxes };
      next[box.id] = { ...box, state: 'shipped' };
    }
  }
  return next ?? boxes;
}

function commandsBetween(before: State, after: State, touched: Change | undefined): Command[] {
  const releases: Command[] = [];
  const others: Command[] = [];
  for (const box of before.boxes === after.boxes ? [] : Object.values(after.boxes)) {
    const prev = get(before.boxes, box.id);
    if (prev === box) continue;
    if (prev?.state === 'building' && box.state !== 'building') {
      releases.push({ kind: 'release_cage', task: box.id });
      if (box.state === 'belt') others.push(alert('worker_ended_without_pr', box.id));
    }
    if (box.state === 'building' && prev?.state !== 'building' && box.worker !== null) {
      others.push({ kind: 'start_cage', task: box.id, worker: box.worker });
    }
    if (box.state === 'qc') {
      const entering = prev?.state !== 'qc';
      const reviewerChanged = prev?.state === 'qc' && prev.reviewer !== box.reviewer;
      if ((entering || reviewerChanged) && box.reviewer !== null) {
        others.push({ kind: 'request_review', task: box.id, pr: box.pr, reviewer: box.reviewer });
      }
      if (entering && box.reviewer === null) others.push(alert('no_peer_reviewer', box.id));
      const flagged = prev?.state === 'qc' ? prev.changesRequested : false;
      if (box.changesRequested && !flagged) others.push({ kind: 'send_review_to_author', task: box.id, pr: box.pr });
    }
    if (box.state === 'merge' && prev?.state !== 'merge')
      others.push({ kind: 'notify_ready', task: box.id, pr: box.pr });
    if (
      (box.state === 'shipping' || box.state === 'shipped') &&
      prev?.state !== 'shipping' &&
      prev?.state !== 'shipped'
    ) {
      others.push({ kind: 'close_task', task: box.id, pr: box.pr });
    }
    if (box.state === 'cancelled' && box.reason === 'closed' && !(prev?.state === 'cancelled')) {
      others.push(alert('change_closed_unmerged', box.id));
    }
  }
  for (const shipment of before.shipments === after.shipments ? [] : Object.values(after.shipments)) {
    const prev = get(before.shipments, shipment.id);
    if (prev?.state === shipment.state) continue;
    if (shipment.state === 'departed') others.push({ kind: 'dispatch_truck', shipment: shipment.id });
    if (shipment.state === 'blocked') others.push(alert('shipment_blocked', shipment.id));
  }
  if (touched !== undefined) {
    const known = new Set(strayKeys(before.changes, touched.branch));
    for (const stray of strayKeys(after.changes, touched.branch)) {
      if (!known.has(stray)) others.push(alert('duplicate_pr', stray));
    }
    const key = keyOf(touched);
    const sibling = Object.values(after.changes).some(
      (change) => change.repo === touched.repo && change.number === touched.number && change.branch !== touched.branch,
    );
    if (sibling && get(before.changes, key) === undefined) others.push(alert('change_branch_moved', key));
  }
  return [...releases, ...others];
}

function touchedBy(event: Event<Login>, before: State, after: State): Change | undefined {
  if (event.source !== 'poll' && !(event.source === 'webhook' && event.kind === 'change')) return undefined;
  const key = changeKey(event.repo, event.number, event.branch);
  const now = get(after.changes, key);
  return now !== get(before.changes, key) ? now : undefined;
}

export type Reducer = (state: State, event: Event) => Reduced;

export function createReducer(rules: Rules): Reducer {
  return (state, raw) => {
    const event = canonical(raw);
    let applied: Reduced;
    if (event.source === 'human') applied = applyHuman(state, event);
    else if (event.source === 'hook') applied = applyHook(state, event);
    else if (event.source === 'poll') applied = { state: observePoll(state, event), commands: [] };
    else applied = { state: observe(state, event), commands: [] };
    if (applied.state === state) return applied;
    const settled = settle(applied.state, rules);
    const touched = touchedBy(event, state, settled);
    return { state: settled, commands: [...applied.commands, ...commandsBetween(state, settled, touched)] };
  };
}

export const reduce: Reducer = createReducer(defaultRules);
