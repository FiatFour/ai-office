import type { Box, Command, Config, Event, State } from '../src/lifecycle.js';

export type Invariant =
  | 'no-merge'
  | 'one-to-one'
  | 'author-never-reviews'
  | 'one-station'
  | 'shipment'
  | 'budget'
  | 'transition'
  | 'cage-stream'
  | 'spec';

export interface Problem {
  readonly invariant: Invariant;
  readonly detail: string;
}

export const INVARIANTS: readonly Invariant[] = [
  'no-merge',
  'one-to-one',
  'author-never-reviews',
  'one-station',
  'shipment',
  'budget',
  'transition',
  'cage-stream',
  'spec',
];

const ALLOWED_COMMANDS = [
  'start_cage',
  'release_cage',
  'request_review',
  'send_review_to_author',
  'notify_ready',
  'close_task',
  'dispatch_truck',
  'alert_human',
];

const ALLOWED_ALERTS = [
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
];

const PR_STATIONS = ['test', 'qc', 'merge', 'shipping', 'shipped'];
const ALL_STATIONS = ['belt', 'building', 'cancelled', ...PR_STATIONS];

const lower = (text: string): string => text.toLowerCase();
const TASK_NAME = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const TASK_BRANCH = /^aw\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

const EVENT_ALERTS = [
  'invalid_task',
  'unknown_task',
  'order_conflict',
  'hire_refused',
  'cancel_refused',
  'duplicate_pr',
  'change_branch_moved',
];

type Shape = Record<string, string | null>;

interface Snap {
  readonly station: string;
  readonly worker: string | null;
  readonly reviewer: string | null;
  readonly flagged: boolean;
  readonly pr: string | null;
  readonly reason: string | null;
}

type Status = 'loading' | 'blocked' | 'departed';

const NOTHING: Snap = { station: 'none', worker: null, reviewer: null, flagged: false, pr: null, reason: null };
const alertShape = (reason: string, subject: string): Shape => ({ kind: 'alert_human', reason, subject });
const leftTheFactory = (station: string) => station === 'shipping' || station === 'shipped';

function canon(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === undefined) return '<undefined>';
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

const sameBag = (wanted: readonly unknown[], got: readonly unknown[]): boolean =>
  wanted.map(canon).sort().join('\n') === got.map(canon).sort().join('\n');

function transitionCommands(
  prior: ReadonlyMap<string, Snap>,
  next: ReadonlyMap<string, Snap>,
  priorShips: ReadonlyMap<string, Status>,
  nextShips: ReadonlyMap<string, Status>,
): Shape[] {
  const out: Shape[] = [];
  for (const [task, now] of next) {
    const was = prior.get(task) ?? NOTHING;
    if (was.station === 'building' && now.station !== 'building') out.push({ kind: 'release_cage', task });
    if (was.station === 'building' && now.station === 'belt') out.push(alertShape('worker_ended_without_pr', task));
    if (now.station === 'building' && was.station !== 'building')
      out.push({ kind: 'start_cage', task, worker: now.worker });
    if (now.station === 'qc') {
      const fresh = was.station !== 'qc';
      if (now.reviewer !== null && (fresh || was.reviewer !== now.reviewer))
        out.push({ kind: 'request_review', task, pr: now.pr, reviewer: now.reviewer });
      if (fresh && now.reviewer === null) out.push(alertShape('no_peer_reviewer', task));
      if (now.flagged && !(was.station === 'qc' && was.flagged))
        out.push({ kind: 'send_review_to_author', task, pr: now.pr });
    }
    if (now.station === 'merge' && was.station !== 'merge') out.push({ kind: 'notify_ready', task, pr: now.pr });
    if (leftTheFactory(now.station) && !leftTheFactory(was.station)) out.push({ kind: 'close_task', task, pr: now.pr });
    if (now.station === 'cancelled' && now.reason === 'closed' && was.station !== 'cancelled')
      out.push(alertShape('change_closed_unmerged', task));
  }
  for (const [id, status] of nextShips) {
    const was = priorShips.get(id) ?? 'none';
    if (was === status) continue;
    if (status === 'departed') out.push({ kind: 'dispatch_truck', shipment: id });
    if (status === 'blocked') out.push(alertShape('shipment_blocked', id));
  }
  return out;
}

function snapshotOfState(state: State): { boxes: Map<string, Snap>; ships: Map<string, Status> } {
  const boxes = new Map<string, Snap>();
  for (const box of Object.values(state.boxes as Record<string, Box>)) {
    boxes.set(box.id, {
      station: box.state,
      worker: box.worker,
      reviewer: box.state === 'qc' ? box.reviewer : null,
      flagged: box.state === 'qc' && box.changesRequested,
      pr: 'pr' in box ? box.pr : null,
      reason: box.state === 'cancelled' ? box.reason : null,
    });
  }
  const ships = new Map<string, Status>();
  for (const shipment of Object.values(state.shipments)) ships.set(shipment.id, shipment.state);
  return { boxes, ships };
}

export class StreamMonitor {
  private readonly cages = new Map<string, string | null>();
  private readonly dispatched = new Map<string, number>();
  private readonly closed = new Map<string, number>();

  constructor(private readonly budget: number) {}

  step(event: Event, before: State, after: State, commands: readonly Command[]): Problem[] {
    const found: Problem[] = [];
    const add = (invariant: Invariant, detail: string) => found.push({ invariant, detail });

    for (const [id, shipment] of Object.entries(before.shipments)) {
      if (shipment.state === 'departed' && after.shipments[id]?.state !== 'departed') {
        add('transition', `shipment ${id} left and is now ${after.shipments[id]?.state}`);
      }
    }
    for (const [id, box] of Object.entries(before.boxes)) {
      const now = after.boxes[id]?.state;
      if (box.state === 'shipped' && now !== 'shipped') add('transition', `box ${id} moved from shipped to ${now}`);
      if (box.state === 'shipping' && now !== 'shipping' && now !== 'shipped')
        add('transition', `box ${id} moved from shipping to ${now}`);
    }

    const known = new Set<string>([
      ...Object.keys(before.boxes),
      ...Object.keys(after.boxes),
      ...Object.keys(before.shipments),
      ...Object.keys(after.shipments),
      ...Object.keys(before.changes),
      ...Object.keys(after.changes),
    ]);
    if ('task' in event) known.add(event.task);

    for (const command of commands) {
      const text = JSON.stringify(command);
      const carried = Object.entries(command)
        .filter(([key]) => key !== 'reason')
        .map(([, value]) => String(value));
      if (!ALLOWED_COMMANDS.includes(command.kind) || carried.some((value) => /merge/i.test(value)))
        add('no-merge', `command ${text} is not one of the eight kinds or carries a merge`);
      if (command.kind === 'alert_human') {
        if (!ALLOWED_ALERTS.includes(command.reason)) add('no-merge', `unknown alert reason ${command.reason}`);
        if (!known.has(command.subject))
          add('no-merge', `alert subject ${command.subject} names nothing in the factory`);
      }
      if ('pr' in command && after.changes[command.pr] === undefined && before.changes[command.pr] === undefined)
        add('no-merge', `command points at a change that does not exist: ${command.pr}`);
      if (command.kind === 'start_cage') {
        if (this.cages.has(command.task)) add('cage-stream', `start_cage for ${command.task}, already running`);
        this.cages.set(command.task, command.worker);
        if (this.cages.size > this.budget)
          add(
            'cage-stream',
            `${this.cages.size} cages running after start_cage ${command.task}, budget ${this.budget}`,
          );
      } else if (command.kind === 'release_cage') {
        if (!this.cages.delete(command.task)) add('cage-stream', `release_cage for ${command.task}, not running`);
      } else if (command.kind === 'dispatch_truck') {
        const count = (this.dispatched.get(command.shipment) ?? 0) + 1;
        this.dispatched.set(command.shipment, count);
        if (count > 1) add('transition', `dispatch_truck for ${command.shipment} emitted ${count} times`);
        const shipment = after.shipments[command.shipment];
        const ready =
          shipment !== undefined &&
          shipment.state === 'departed' &&
          shipment.members.length === shipment.size &&
          shipment.members.every((id) => after.boxes[id]?.state === 'shipped');
        if (!ready) add('shipment', `truck ${command.shipment} dispatched before every box shipped`);
        if (before.shipments[command.shipment]?.state === 'departed')
          add('transition', `truck ${command.shipment} dispatched for a shipment that had already left`);
      } else if (command.kind === 'close_task') {
        const count = (this.closed.get(command.task) ?? 0) + 1;
        this.closed.set(command.task, count);
        if (count > 1) add('transition', `close_task for ${command.task} emitted ${count} times`);
      }
    }

    const building = Object.values(after.boxes)
      .filter((box) => box.state === 'building')
      .map((box) => box.id);
    const same = building.length === this.cages.size && building.every((id) => this.cages.has(id));
    for (const id of building) {
      const running = this.cages.get(id);
      const named = after.boxes[id]?.worker;
      if (running !== undefined && running !== named)
        add('cage-stream', `cage of ${id} runs for ${running}, the box now names ${named}`);
    }
    if (!same)
      add(
        'cage-stream',
        `commands leave cages [${[...this.cages.keys()].sort()}], boxes building [${building.sort()}]`,
      );
    if (building.length > this.budget) add('budget', `${building.length} cages running, budget ${this.budget}`);

    for (const box of Object.values(after.boxes)) {
      const prev = before.boxes[box.id];
      if (!ALL_STATIONS.includes(box.state)) add('one-station', `${box.id} is at unknown station ${box.state}`);
      if (PR_STATIONS.includes(box.state) !== 'pr' in box)
        add('one-station', `${box.id} at ${box.state} disagrees about having a pr`);
      if (box.state === 'building' && box.worker === null) add('one-station', `${box.id} is building without a worker`);
      const enteredShipping =
        (box.state === 'shipping' || box.state === 'shipped') &&
        prev?.state !== 'shipping' &&
        prev?.state !== 'shipped';
      if (enteredShipping) {
        const fromHost = event.source === 'poll' || (event.source === 'webhook' && event.kind === 'change');
        const fromOrder = event.source === 'human' && event.kind === 'order' && event.task === box.id;
        if (!fromHost && !fromOrder)
          add(
            'no-merge',
            `${box.id} began shipping on a ${event.source} ${'kind' in event ? event.kind : ''} event, not on a host change`,
          );
      }
    }
    if (event.source === 'human' && (event.kind === 'hire' || event.kind === 'cancel')) {
      const was = before.boxes[event.task];
      const now = after.boxes[event.task];
      if (event.kind === 'hire' && was && was.state !== 'belt' && now) {
        if (now.worker !== was.worker || now.builders.join() !== was.builders.join())
          add('transition', `a hire changed ${event.task}, which was at ${was.state}, not on the belt`);
      }
      if (event.kind === 'cancel' && was && leftTheFactory(was.state) && now && now.cancelled !== was.cancelled)
        add('transition', `a cancel changed ${event.task}, which was already ${was.state}`);
    }
    const prior = snapshotOfState(before);
    const next = snapshotOfState(after);
    const wanted = transitionCommands(prior.boxes, next.boxes, prior.ships, next.ships);
    const got = commands.filter((command) => command.kind !== 'alert_human' || !EVENT_ALERTS.includes(command.reason));
    if (!sameBag(wanted, got))
      add(
        'transition',
        `commands differ from the state change: wanted ${wanted.map(canon).sort().join(' ')}, got ${got.map(canon).sort().join(' ')}`,
      );
    return found;
  }
}

interface ChangeFact {
  readonly repo: string;
  readonly headRepo: string;
  readonly number: number;
  readonly branch: string;
  readonly author: string;
  readonly life: 'open' | 'closed' | 'merged';
  readonly head: string;
  readonly at: number;
}
interface ReviewFact {
  readonly repo: string;
  readonly number: number;
  readonly head: string;
  readonly reviewer: string;
  readonly verdict: string;
  readonly at: number;
}
interface CheckFact {
  readonly repo: string;
  readonly head: string;
  readonly name: string;
  readonly state: string;
  readonly at: number;
}
interface Entity {
  readonly repo: string;
  readonly number: number;
  readonly branch: string;
  readonly author: string;
  readonly head: string;
  readonly life: 'open' | 'closed' | 'merged';
  readonly first: number;
}
interface LedgerBox {
  readonly task: string;
  readonly shipment: string;
  worker: string | null;
  readonly builders: Set<string>;
  cancelled: boolean;
  station: string;
  reviewer: string | null;
  flagged: boolean;
  pr?: string;
  reason?: string;
}
interface LedgerShipment {
  readonly id: string;
  readonly size: number;
  readonly members: string[];
  status: Status;
}
interface Expected {
  station: string;
  pr?: string | undefined;
  reviewer?: string | null;
  changesRequested?: boolean;
  reason?: string;
}
interface Alert {
  readonly reason: string;
  readonly subject: string;
}

const newest = <T>(items: readonly T[], at: (item: T) => number, tie: (item: T) => string): T =>
  items.reduce((a, b) => (at(b) > at(a) || (at(b) === at(a) && tie(b) > tie(a)) ? b : a));

const LIFE_ORDER = { open: 0, closed: 1, merged: 2 } as const;

const earlier = (a: Entity, b: Entity): boolean =>
  a.first < b.first || (a.first === b.first && (a.repo < b.repo || (a.repo === b.repo && a.number < b.number)));

const firstOf = (entities: readonly Entity[]): Entity | undefined =>
  entities.reduce<Entity | undefined>(
    (best, one) => (best === undefined || earlier(one, best) ? one : best),
    undefined,
  );

const entityKey = (entity: Entity) => `${entity.repo}#${entity.number}@${entity.branch}`;

export class Oracle {
  private readonly stream: StreamMonitor;
  private readonly changeFacts: ChangeFact[] = [];
  private readonly reviewFacts: ReviewFact[] = [];
  private readonly checkFacts: CheckFact[] = [];
  private readonly staff: string[] = [];
  private readonly boxes: LedgerBox[] = [];
  private readonly shipments: LedgerShipment[] = [];

  constructor(private readonly config: Config) {
    this.stream = new StreamMonitor(config.budget);
  }

  step(event: Event, before: State, after: State, commands: readonly Command[]): Problem[] {
    const found = this.stream.step(event, before, after, commands);
    const entitiesBefore = this.entities();
    const prior = this.snapshot();
    const refused = this.record(event);
    const expected = this.expect();
    const next = this.snapshot();
    const wanted: Shape[] = [
      ...transitionCommands(prior.boxes, next.boxes, prior.ships, next.ships),
      ...refused.map((one) => alertShape(one.reason, one.subject)),
      ...this.changeAlerts(entitiesBefore),
    ];
    if (!sameBag(wanted, commands))
      found.push({
        invariant: 'transition',
        detail: `commands differ from the oracle's: wanted ${wanted.map(canon).sort().join(' ')}, got ${commands.map(canon).sort().join(' ')}`,
      });
    this.compare(expected, after, found);
    this.checkInvariants(after, found);
    return found;
  }

  private snapshot(): { boxes: Map<string, Snap>; ships: Map<string, Status> } {
    const boxes = new Map<string, Snap>();
    for (const box of this.boxes) {
      boxes.set(box.task, {
        station: box.station,
        worker: box.worker,
        reviewer: box.reviewer,
        flagged: box.flagged,
        pr: box.pr ?? null,
        reason: box.reason ?? null,
      });
    }
    const ships = new Map<string, Status>();
    for (const shipment of this.shipments) ships.set(shipment.id, shipment.status);
    return { boxes, ships };
  }

  private changeAlerts(entitiesBefore: readonly Entity[]): Shape[] {
    const strays = (entities: readonly Entity[]) => {
      const result = new Set<string>();
      for (const branch of new Set(entities.map((entity) => entity.branch))) {
        const open = entities.filter((entity) => entity.branch === branch && entity.life !== 'closed');
        const followed = firstOf(open);
        for (const entity of open) if (entity !== followed) result.add(entityKey(entity));
      }
      return result;
    };
    const entitiesAfter = this.entities();
    const known = strays(entitiesBefore);
    const duplicates = [...strays(entitiesAfter)]
      .filter((key) => !known.has(key))
      .map((key) => alertShape('duplicate_pr', key));
    const existed = new Set(entitiesBefore.map(entityKey));
    const moved = entitiesAfter
      .filter(
        (entity) =>
          !existed.has(entityKey(entity)) &&
          entitiesAfter.some(
            (other) => other.repo === entity.repo && other.number === entity.number && other.branch !== entity.branch,
          ),
      )
      .map((entity) => alertShape('change_branch_moved', entityKey(entity)));
    return [...duplicates, ...moved];
  }

  private box(task: string): LedgerBox | undefined {
    return this.boxes.find((box) => box.task === task);
  }

  private record(event: Event): Alert[] {
    if (event.source === 'human') return this.recordHuman(event);
    if (event.source === 'hook') {
      const box = this.box(event.task);
      if (!box) return [{ reason: 'unknown_task', subject: event.task }];
      if (box.worker === lower(event.worker)) box.worker = null;
      return [];
    }
    if (event.source === 'poll') {
      this.recordChange(event);
      for (const check of event.checks)
        this.checkFacts.push({
          repo: lower(event.repo),
          head: event.headSha,
          name: check.name,
          state: check.state,
          at: event.at,
        });
      for (const review of event.reviews)
        this.reviewFacts.push({
          repo: lower(event.repo),
          number: event.number,
          head: event.headSha,
          reviewer: lower(review.reviewer),
          verdict: review.verdict,
          at: event.at,
        });
    } else if (event.kind === 'change') {
      this.recordChange(event);
    } else if (event.kind === 'review') {
      this.reviewFacts.push({
        repo: lower(event.repo),
        number: event.number,
        head: event.headSha,
        reviewer: lower(event.reviewer),
        verdict: event.verdict,
        at: event.at,
      });
    } else {
      this.checkFacts.push({
        repo: lower(event.repo),
        head: event.headSha,
        name: event.name,
        state: event.state,
        at: event.at,
      });
    }
    return [];
  }

  private recordChange(event: {
    repo: string;
    headRepo: string;
    number: number;
    branch: string;
    author: string;
    headSha: string;
    state: 'open' | 'closed' | 'merged';
    at: number;
  }): void {
    this.changeFacts.push({
      repo: lower(event.repo),
      headRepo: lower(event.headRepo),
      number: event.number,
      branch: event.branch,
      author: lower(event.author),
      life: event.state,
      head: event.headSha,
      at: event.at,
    });
  }

  private recordHuman(event: Extract<Event, { source: 'human' }>): Alert[] {
    if (event.kind === 'add_worker') {
      if (!this.staff.includes(lower(event.worker))) this.staff.push(lower(event.worker));
      return [];
    }
    if (!TASK_NAME.test(event.task)) return [{ reason: 'invalid_task', subject: event.task }];
    const box = this.box(event.task);
    if (event.kind === 'order') return this.recordOrder(event, box);
    if (!box) return [{ reason: 'unknown_task', subject: event.task }];
    if (event.kind === 'cancel') {
      if (box.station === 'shipping' || box.station === 'shipped')
        return [{ reason: 'cancel_refused', subject: box.task }];
      box.cancelled = true;
      return [];
    }
    const worker = lower(event.worker);
    if (box.worker === worker) return [];
    if (box.station !== 'belt') return [{ reason: 'hire_refused', subject: box.task }];
    box.worker = worker;
    box.builders.add(worker);
    if (!this.staff.includes(worker)) this.staff.push(worker);
    return [];
  }

  private recordOrder(event: Extract<Event, { kind: 'order' }>, box: LedgerBox | undefined): Alert[] {
    const spec = event.shipment ?? { id: event.task, size: 1 };
    const conflict: Alert[] = [{ reason: 'order_conflict', subject: event.task }];
    if (box) return box.shipment === spec.id ? [] : conflict;
    if (!Number.isInteger(spec.size) || spec.size < 1) return conflict;
    const shipment = this.shipments.find((entry) => entry.id === spec.id);
    if (shipment && (shipment.size !== spec.size || shipment.members.length >= shipment.size)) return conflict;
    if (shipment) shipment.members.push(event.task);
    else this.shipments.push({ id: spec.id, size: spec.size, members: [event.task], status: 'loading' });
    this.boxes.push({
      task: event.task,
      shipment: spec.id,
      worker: null,
      builders: new Set(),
      cancelled: false,
      station: 'belt',
      reviewer: null,
      flagged: false,
    });
    return [];
  }

  private entities(): Entity[] {
    const groups: { repo: string; number: number; branch: string; facts: ChangeFact[] }[] = [];
    for (const fact of this.changeFacts) {
      if (!TASK_BRANCH.test(fact.branch) || fact.headRepo !== fact.repo) continue;
      const group = groups.find(
        (entry) => entry.repo === fact.repo && entry.number === fact.number && entry.branch === fact.branch,
      );
      if (group) group.facts.push(fact);
      else groups.push({ repo: fact.repo, number: fact.number, branch: fact.branch, facts: [fact] });
    }
    return groups.map((group) => {
      const life = group.facts.some((fact) => fact.life === 'merged')
        ? 'merged'
        : newest(
            group.facts,
            (fact) => fact.at,
            (fact) => String(LIFE_ORDER[fact.life]),
          ).life;
      return {
        repo: group.repo,
        number: group.number,
        branch: group.branch,
        author: newest(
          group.facts,
          (fact) => fact.at,
          (fact) => fact.author,
        ).author,
        head: newest(
          group.facts,
          (fact) => fact.at,
          (fact) => fact.head,
        ).head,
        first: Math.min(...group.facts.map((fact) => fact.at)),
        life,
      };
    });
  }

  private votes(entity: Entity): { reviewer: string; verdict: string }[] {
    const relevant = this.reviewFacts.filter(
      (fact) => fact.repo === entity.repo && fact.number === entity.number && fact.head === entity.head,
    );
    const reviewers = [...new Set(relevant.map((fact) => fact.reviewer))];
    return reviewers.map((reviewer) => {
      const own = relevant.filter((fact) => fact.reviewer === reviewer);
      return {
        reviewer,
        verdict: newest(
          own,
          (fact) => fact.at,
          (fact) => fact.verdict,
        ).verdict,
      };
    });
  }

  private checksGreen(entity: Entity): boolean {
    const relevant = this.checkFacts.filter((fact) => fact.repo === entity.repo && fact.head === entity.head);
    const names = [...new Set(relevant.map((fact) => fact.name))];
    return (
      names.length > 0 &&
      names.every((name) => {
        const own = relevant.filter((fact) => fact.name === name);
        return (
          newest(
            own,
            (fact) => fact.at,
            (fact) => fact.state,
          ).state === 'success'
        );
      })
    );
  }

  private chosen(task: string, entities: readonly Entity[]): Entity | undefined {
    const candidates = entities.filter((entity) => entity.branch === `aw/${task}`);
    return firstOf(candidates.filter((entity) => entity.life !== 'closed')) ?? firstOf(candidates);
  }

  private eligible(login: string, entity: Entity, box: LedgerBox): boolean {
    return login !== entity.author && !box.builders.has(login);
  }

  private expect(): Map<string, Expected> {
    const entities = this.entities();
    const result = new Map<string, Expected>();
    const wanting: LedgerBox[] = [];
    for (const box of this.boxes) {
      if (box.station === 'shipping' || box.station === 'shipped') {
        result.set(box.task, { station: box.station, pr: box.pr });
        continue;
      }
      const entity = this.chosen(box.task, entities);
      if (entity) {
        const pr = entityKey(entity);
        if (entity.life === 'merged') result.set(box.task, { station: 'shipping', pr });
        else if (box.cancelled) result.set(box.task, { station: 'cancelled', reason: 'human' });
        else if (entity.life === 'closed') result.set(box.task, { station: 'cancelled', reason: 'closed' });
        else if (!this.checksGreen(entity)) result.set(box.task, { station: 'test', pr });
        else {
          const votes = this.votes(entity).filter((vote) => this.eligible(vote.reviewer, entity, box));
          const changesRequested = votes.some((vote) => vote.verdict === 'changes');
          const approvals = votes.filter((vote) => vote.verdict === 'approve').length;
          if (!changesRequested && approvals >= this.config.approvals) result.set(box.task, { station: 'merge', pr });
          else {
            const reviewer = [...this.staff].sort().find((login) => this.eligible(login, entity, box)) ?? null;
            result.set(box.task, { station: 'qc', pr, reviewer, changesRequested });
          }
        }
      } else if (box.cancelled) result.set(box.task, { station: 'cancelled', reason: 'human' });
      else if (box.worker === null) result.set(box.task, { station: 'belt' });
      else wanting.push(box);
    }
    const kept = wanting.filter((box) => box.station === 'building');
    let free = this.config.budget - kept.length;
    for (const box of wanting) {
      if (kept.includes(box)) result.set(box.task, { station: 'building' });
      else if (free > 0) {
        free -= 1;
        result.set(box.task, { station: 'building' });
      } else result.set(box.task, { station: 'belt' });
    }
    for (const shipment of this.shipments) {
      if (shipment.status === 'departed') continue;
      const members = shipment.members.map((task) => result.get(task)?.station);
      const complete = members.length === shipment.size;
      shipment.status =
        complete && members.every((station) => station === 'shipping' || station === 'shipped')
          ? 'departed'
          : members.includes('cancelled')
            ? 'blocked'
            : 'loading';
    }
    for (const box of this.boxes) {
      const entry = result.get(box.task);
      const shipment = this.shipments.find((candidate) => candidate.id === box.shipment);
      if (entry && entry.station === 'shipping' && shipment?.status === 'departed') entry.station = 'shipped';
      box.station = entry?.station ?? box.station;
      box.reviewer = entry?.station === 'qc' ? (entry.reviewer ?? null) : null;
      box.flagged = entry?.station === 'qc' && entry.changesRequested === true;
      if (entry?.pr !== undefined) box.pr = entry.pr;
      if (entry?.station === 'cancelled') box.reason = entry.reason as string;
    }
    return result;
  }

  private compare(expected: Map<string, Expected>, after: State, found: Problem[]): void {
    const add = (detail: string) => found.push({ invariant: 'spec', detail });
    const ids = Object.keys(after.boxes).sort();
    const want = this.boxes.map((box) => box.task).sort();
    if (ids.join() !== want.join()) add(`boxes [${ids}] but orders accepted for [${want}]`);
    for (const box of this.boxes) {
      const actual = after.boxes[box.task];
      const should = expected.get(box.task);
      if (!actual || !should) continue;
      const here = `${box.task}`;
      if (actual.state !== should.station) add(`${here} is ${actual.state}, spec says ${should.station}`);
      if (actual.worker !== box.worker) add(`${here} worker ${actual.worker}, spec says ${box.worker}`);
      if (actual.builders.join() !== [...box.builders].sort().join())
        add(`${here} builders [${actual.builders}], spec says [${[...box.builders].sort()}]`);
      if (actual.cancelled !== box.cancelled) add(`${here} cancelled ${actual.cancelled}, spec says ${box.cancelled}`);
      if (actual.shipment !== box.shipment) add(`${here} ships in ${actual.shipment}, spec says ${box.shipment}`);
      if ('pr' in actual && should.pr !== undefined && actual.pr !== should.pr)
        add(`${here} follows ${actual.pr}, spec says ${should.pr}`);
      if (actual.state === 'qc' && should.station === 'qc') {
        if (actual.reviewer !== should.reviewer)
          add(`${here} reviewer ${actual.reviewer}, spec says ${should.reviewer}`);
        if (actual.changesRequested !== should.changesRequested) add(`${here} changesRequested differs from the spec`);
      }
      if (actual.state === 'cancelled' && should.reason !== undefined && actual.reason !== should.reason)
        add(`${here} cancelled for ${actual.reason}, spec says ${should.reason}`);
    }
    for (const shipment of this.shipments) {
      const actual = after.shipments[shipment.id];
      if (!actual) {
        add(`shipment ${shipment.id} is missing`);
        continue;
      }
      if (actual.size !== shipment.size || actual.members.join() !== shipment.members.join())
        add(
          `shipment ${shipment.id} lists [${actual.members}] of ${actual.size}, spec says [${shipment.members}] of ${shipment.size}`,
        );
      if (actual.state !== shipment.status)
        add(`shipment ${shipment.id} is ${actual.state}, spec says ${shipment.status}`);
    }
    const entities = this.entities();
    const keys = Object.keys(after.changes).sort();
    const wantKeys = entities.map(entityKey).sort();
    if (keys.join() !== wantKeys.join()) add(`changes [${keys}] but facts describe [${wantKeys}]`);
    for (const entity of entities) {
      const actual = after.changes[entityKey(entity)];
      if (!actual) continue;
      const same =
        actual.author.v === entity.author &&
        actual.head.v === entity.head &&
        actual.state === entity.life &&
        actual.first === entity.first;
      if (!same) add(`change ${entityKey(entity)} differs from the facts: ${JSON.stringify(actual)}`);
    }
  }

  private checkInvariants(after: State, found: Problem[]): void {
    const add = (invariant: Invariant, detail: string) => found.push({ invariant, detail });
    const entities = this.entities();
    const claimed = new Map<string, string>();
    for (const box of Object.values(after.boxes)) {
      const ledger = this.box(box.id);
      if (!('pr' in box)) continue;
      const change = after.changes[box.pr];
      if (change === undefined) {
        add('one-to-one', `${box.id} points at missing change ${box.pr}`);
        continue;
      }
      if (change.branch !== `aw/${box.id}`)
        add('one-to-one', `${box.id} adopted ${box.pr} from branch ${change.branch}`);
      if (claimed.has(box.pr)) add('one-to-one', `${box.pr} belongs to both ${claimed.get(box.pr)} and ${box.id}`);
      claimed.set(box.pr, box.id);
      const entity = entities.find(
        (candidate) =>
          candidate.repo === change.repo && candidate.number === change.number && candidate.branch === change.branch,
      );
      if (!entity) {
        add('one-to-one', `${box.id} follows ${box.pr}, which no accepted fact describes`);
        continue;
      }
      if (!ledger) continue;
      const barred = new Set([entity.author, ...ledger.builders]);
      if (box.state === 'qc' && box.reviewer !== null && barred.has(box.reviewer))
        add('author-never-reviews', `${box.id} assigns ${box.reviewer}, the author or a builder, as reviewer`);
      if (box.state === 'merge') {
        const tally = this.tally(entity, barred);
        if (tally.approvals < this.config.approvals)
          add('author-never-reviews', `${box.id} is ready on fewer than ${this.config.approvals} peer approvals`);
        if (tally.changes > 0) add('author-never-reviews', `${box.id} is ready past a peer's changes request`);
      }
      if (box.state === 'shipped' && after.shipments[box.shipment]?.state !== 'departed')
        add('shipment', `${box.id} is shipped but shipment ${box.shipment} has not left`);
    }
    for (const shipment of Object.values(after.shipments)) {
      if (shipment.state !== 'departed') continue;
      if (shipment.members.length !== shipment.size)
        add('shipment', `${shipment.id} left with ${shipment.members.length} of ${shipment.size} boxes`);
      for (const task of shipment.members) {
        const merged = entities.some((entity) => entity.branch === `aw/${task}` && entity.life === 'merged');
        if (!merged) add('shipment', `${shipment.id} left but ${task} has no merged change`);
      }
    }
  }

  private tally(entity: Entity, barred: ReadonlySet<string>): { approvals: number; changes: number } {
    const latest = new Map<string, ReviewFact>();
    for (const fact of this.reviewFacts) {
      if (fact.repo !== entity.repo || fact.number !== entity.number || fact.head !== entity.head) continue;
      if (barred.has(fact.reviewer)) continue;
      const held = latest.get(fact.reviewer);
      if (!held || fact.at > held.at || (fact.at === held.at && fact.verdict > held.verdict))
        latest.set(fact.reviewer, fact);
    }
    let approvals = 0;
    let changes = 0;
    for (const fact of latest.values()) {
      if (fact.verdict === 'approve') approvals += 1;
      if (fact.verdict === 'changes') changes += 1;
    }
    return { approvals, changes };
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
