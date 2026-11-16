import type { Command, Config, Event, State } from '../src/lifecycle.js';

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
];

const PR_STATIONS = ['test', 'qc', 'merge', 'shipping', 'shipped'];
const ALL_STATIONS = ['belt', 'building', 'cancelled', ...PR_STATIONS];

const lower = (text: string): string => text.toLowerCase();
const TASK_NAME = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const TASK_BRANCH = /^aw\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

const TRACKED_ALERTS = ['no_peer_reviewer', 'worker_ended_without_pr', 'change_closed_unmerged', 'shipment_blocked'];
const TRACKED_KINDS = ['request_review', 'send_review_to_author', 'notify_ready', 'close_task', 'dispatch_truck'];

function tokenOf(command: Command): string | undefined {
  if (command.kind === 'alert_human')
    return TRACKED_ALERTS.includes(command.reason) ? `alert:${command.reason}:${command.subject}` : undefined;
  if (!TRACKED_KINDS.includes(command.kind)) return undefined;
  if (command.kind === 'dispatch_truck') return `dispatch:${command.shipment}`;
  if (command.kind === 'request_review') return `request_review:${command.task}:${command.reviewer}`;
  if (command.kind === 'start_cage' || command.kind === 'release_cage') return undefined;
  return `${command.kind}:${command.task}`;
}

function expectedCommands(before: State, after: State): string[] {
  const wanted: string[] = [];
  for (const box of Object.values(after.boxes)) {
    const prev = before.boxes[box.id];
    if (prev?.state === 'building' && box.state === 'belt') wanted.push(`alert:worker_ended_without_pr:${box.id}`);
    if (box.state === 'qc') {
      const entering = prev?.state !== 'qc';
      const reassigned = prev?.state === 'qc' && prev.reviewer !== box.reviewer;
      if ((entering || reassigned) && box.reviewer !== null) wanted.push(`request_review:${box.id}:${box.reviewer}`);
      if (entering && box.reviewer === null) wanted.push(`alert:no_peer_reviewer:${box.id}`);
      const wasFlagged = prev?.state === 'qc' && prev.changesRequested;
      if (box.changesRequested && !wasFlagged) wanted.push(`send_review_to_author:${box.id}`);
    }
    if (box.state === 'merge' && prev?.state !== 'merge') wanted.push(`notify_ready:${box.id}`);
    const shipping = (state: string | undefined) => state === 'shipping' || state === 'shipped';
    if (shipping(box.state) && !shipping(prev?.state)) wanted.push(`close_task:${box.id}`);
    if (box.state === 'cancelled' && box.reason === 'closed' && prev?.state !== 'cancelled')
      wanted.push(`alert:change_closed_unmerged:${box.id}`);
  }
  for (const shipment of Object.values(after.shipments)) {
    const prev = before.shipments[shipment.id];
    if (prev?.state === shipment.state) continue;
    if (shipment.state === 'departed') wanted.push(`dispatch:${shipment.id}`);
    if (shipment.state === 'blocked') wanted.push(`alert:shipment_blocked:${shipment.id}`);
  }
  return wanted;
}

export class StreamMonitor {
  private readonly cages = new Set<string>();
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
        this.cages.add(command.task);
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
    if (!same)
      add('cage-stream', `commands leave cages [${[...this.cages].sort()}], boxes building [${building.sort()}]`);
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
    const wanted = expectedCommands(before, after);
    const got = commands.flatMap((command) => tokenOf(command) ?? []);
    if (wanted.sort().join('\n') !== got.sort().join('\n'))
      add('transition', `commands differ from the state change: wanted [${wanted.sort()}], got [${got.sort()}]`);
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
}
interface LedgerBox {
  readonly task: string;
  readonly shipment: string;
  worker: string | null;
  builder: string | null;
  cancelled: boolean;
  station: string;
  pr?: string;
}
interface LedgerShipment {
  readonly id: string;
  readonly size: number;
  readonly members: string[];
  departed: boolean;
}
interface Expected {
  station: string;
  pr?: string | undefined;
  reviewer?: string | null;
  changesRequested?: boolean;
  reason?: string;
}

const newest = <T>(items: readonly T[], at: (item: T) => number, tie: (item: T) => string): T =>
  items.reduce((a, b) => (at(b) > at(a) || (at(b) === at(a) && tie(b) > tie(a)) ? b : a));

const LIFE_ORDER = { open: 0, closed: 1, merged: 2 } as const;
const PREFERENCE = { merged: 0, open: 1, closed: 2 } as const;

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
    this.record(event);
    this.checkChangeAlerts(entitiesBefore, commands, found);
    const expected = this.expect();
    this.compare(expected, after, found);
    this.checkInvariants(after, found);
    return found;
  }

  private checkChangeAlerts(entitiesBefore: readonly Entity[], commands: readonly Command[], found: Problem[]): void {
    const keyOf = (entity: Entity) => `${entity.repo}#${entity.number}@${entity.branch}`;
    const strays = (entities: readonly Entity[]) =>
      new Set(
        [...new Set(entities.map((entity) => entity.branch))].flatMap((branch) =>
          entities
            .filter((entity) => entity.branch === branch)
            .sort(
              (a, b) =>
                PREFERENCE[a.life] - PREFERENCE[b.life] ||
                (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) ||
                a.number - b.number,
            )
            .slice(1)
            .filter((entity) => entity.life !== 'closed')
            .map(keyOf),
        ),
      );
    const entitiesAfter = this.entities();
    const known = strays(entitiesBefore);
    const duplicates = [...strays(entitiesAfter)].filter((key) => !known.has(key)).map((key) => `duplicate_pr:${key}`);
    const existed = new Set(entitiesBefore.map(keyOf));
    const moved = entitiesAfter
      .filter(
        (entity) =>
          !existed.has(keyOf(entity)) &&
          entitiesAfter.some(
            (other) => other.repo === entity.repo && other.number === entity.number && other.branch !== entity.branch,
          ),
      )
      .map((entity) => `change_branch_moved:${keyOf(entity)}`);
    const wanted = [...duplicates, ...moved].sort();
    const got = commands
      .flatMap((command) =>
        command.kind === 'alert_human' &&
        (command.reason === 'duplicate_pr' || command.reason === 'change_branch_moved')
          ? [`${command.reason}:${command.subject}`]
          : [],
      )
      .sort();
    if (wanted.join() !== got.join())
      found.push({ invariant: 'transition', detail: `change alerts differ: wanted [${wanted}], got [${got}]` });
  }

  private box(task: string): LedgerBox | undefined {
    return this.boxes.find((box) => box.task === task);
  }

  private record(event: Event): void {
    if (event.source === 'human') {
      if (event.kind === 'add_worker') {
        if (!this.staff.includes(lower(event.worker))) this.staff.push(lower(event.worker));
        return;
      }
      if (!TASK_NAME.test(event.task)) return;
      const box = this.box(event.task);
      if (event.kind === 'order') {
        if (box) return;
        const spec = event.shipment ?? { id: event.task, size: 1 };
        if (!Number.isInteger(spec.size) || spec.size < 1) return;
        const shipment = this.shipments.find((entry) => entry.id === spec.id);
        if (shipment && (shipment.size !== spec.size || shipment.members.length >= shipment.size)) return;
        if (shipment) shipment.members.push(event.task);
        else this.shipments.push({ id: spec.id, size: spec.size, members: [event.task], departed: false });
        this.boxes.push({
          task: event.task,
          shipment: spec.id,
          worker: null,
          builder: null,
          cancelled: false,
          station: 'belt',
        });
        return;
      }
      if (!box) return;
      if (event.kind === 'cancel') {
        box.cancelled = true;
        return;
      }
      const worker = lower(event.worker);
      if (!this.staff.includes(worker)) this.staff.push(worker);
      if (box.station === 'belt' && box.worker !== worker) {
        box.worker = worker;
        box.builder = worker;
      }
      return;
    }
    if (event.source === 'hook') {
      const box = this.box(event.task);
      if (box && box.worker === lower(event.worker)) box.worker = null;
      return;
    }
    if (event.source === 'poll') {
      this.changeFacts.push({
        repo: event.repo,
        headRepo: event.headRepo,
        number: event.number,
        branch: event.branch,
        author: lower(event.author),
        life: event.state,
        head: event.headSha,
        at: event.at,
      });
      for (const check of event.checks)
        this.checkFacts.push({
          repo: event.repo,
          head: event.headSha,
          name: check.name,
          state: check.state,
          at: event.at,
        });
      for (const review of event.reviews)
        this.reviewFacts.push({
          repo: event.repo,
          number: event.number,
          head: event.headSha,
          reviewer: lower(review.reviewer),
          verdict: review.verdict,
          at: event.at,
        });
      return;
    }
    if (event.kind === 'change') {
      this.changeFacts.push({
        repo: event.repo,
        headRepo: event.headRepo,
        number: event.number,
        branch: event.branch,
        author: lower(event.author),
        life: event.state,
        head: event.headSha,
        at: event.at,
      });
    } else if (event.kind === 'review') {
      this.reviewFacts.push({
        repo: event.repo,
        number: event.number,
        head: event.headSha,
        reviewer: lower(event.reviewer),
        verdict: event.verdict,
        at: event.at,
      });
    } else {
      this.checkFacts.push({
        repo: event.repo,
        head: event.headSha,
        name: event.name,
        state: event.state,
        at: event.at,
      });
    }
  }

  private entities(): Entity[] {
    const groups: { repo: string; number: number; branch: string; facts: ChangeFact[] }[] = [];
    for (const fact of this.changeFacts) {
      if (!TASK_BRANCH.test(fact.branch) || lower(fact.headRepo) !== lower(fact.repo)) continue;
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
    return [...candidates].sort(
      (a, b) =>
        PREFERENCE[a.life] - PREFERENCE[b.life] ||
        (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) ||
        a.number - b.number,
    )[0];
  }

  private eligible(login: string, entity: Entity, box: LedgerBox): boolean {
    return login !== entity.author && login !== box.builder;
  }

  private expect(): Map<string, Expected> {
    const entities = this.entities();
    const result = new Map<string, Expected>();
    const wanting: LedgerBox[] = [];
    for (const box of this.boxes) {
      if (box.station === 'shipped') {
        result.set(box.task, { station: 'shipped', pr: box.pr });
        continue;
      }
      const entity = this.chosen(box.task, entities);
      if (entity) {
        const pr = `${entity.repo}#${entity.number}@${entity.branch}`;
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
      if (shipment.departed) continue;
      const members = shipment.members.map((task) => result.get(task)?.station);
      const complete = members.length === shipment.size;
      if (complete && members.every((station) => station === 'shipping' || station === 'shipped'))
        shipment.departed = true;
    }
    for (const box of this.boxes) {
      const entry = result.get(box.task);
      const shipment = this.shipments.find((candidate) => candidate.id === box.shipment);
      if (entry && entry.station === 'shipping' && shipment?.departed) entry.station = 'shipped';
      box.station = entry?.station ?? box.station;
      if (entry?.pr !== undefined) box.pr = entry.pr;
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
      if (actual.builder !== box.builder) add(`${here} builder ${actual.builder}, spec says ${box.builder}`);
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
      const members = shipment.members.map((task) => expected.get(task)?.station);
      const state = shipment.departed ? 'departed' : members.includes('cancelled') ? 'blocked' : 'loading';
      if (actual.state !== state) add(`shipment ${shipment.id} is ${actual.state}, spec says ${state}`);
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
      if (box.state === 'qc' && box.reviewer !== null && ledger && !this.eligible(box.reviewer, entity, ledger))
        add('author-never-reviews', `${box.id} assigns ${box.reviewer}, the author or the builder, as reviewer`);
      if (box.state === 'merge' && ledger) {
        const votes = this.votes(entity).filter((vote) => this.eligible(vote.reviewer, entity, ledger));
        if (votes.filter((vote) => vote.verdict === 'approve').length < this.config.approvals)
          add('author-never-reviews', `${box.id} is ready on fewer than ${this.config.approvals} peer approvals`);
        if (votes.some((vote) => vote.verdict === 'changes'))
          add('author-never-reviews', `${box.id} is ready past a peer's changes request`);
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
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
