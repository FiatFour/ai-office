import { randomBytes } from 'node:crypto';
import { type Command, type Config, type Event, initialState, reduce, type State } from '@agent-works/core';
import { pruneSuperseded, supersededBy } from './store/prune.ts';
import type { OutboxEntry, OutboxStatus, Persisted, Store } from './store/store.ts';

export const DEFAULT_CONFIG: Config = { budget: 3, approvals: 1 };
const SUPERSEDED_CAP = 10_000;
const DONE_KEPT = 200;
export const MAX_ATTEMPTS = 3;

const runnable = (entry: OutboxEntry): boolean =>
  (entry.status === 'pending' || entry.status === 'failed') && entry.attempts < MAX_ATTEMPTS;

const gaveUp = (error: string | null, attempts: number): string => `${error} (gave up after ${attempts} attempts)`;

export interface Ingested {
  readonly rev: number;
  readonly commands: readonly OutboxEntry[];
}

const entriesFor = (epoch: string, seq: number, commands: readonly Command[]): OutboxEntry[] =>
  commands.map((command, index) => ({
    id: `${epoch}.${seq}.${index}`,
    command,
    status: 'pending',
    attempts: 0,
    error: null,
  }));

const settle = (outbox: readonly OutboxEntry[]): OutboxEntry[] => {
  const open = outbox.filter(runnable);
  const closed = outbox.filter((entry) => !runnable(entry));
  return [...open, ...closed.slice(-DONE_KEPT)];
};

const crashed = (entry: OutboxEntry): OutboxEntry =>
  entry.status === 'pending' && entry.attempts >= MAX_ATTEMPTS
    ? { ...entry, status: 'failed', error: gaveUp('HQ stopped while it ran', entry.attempts) }
    : entry;

export class Ledger {
  private readonly store: Store;
  private persisted: Persisted;
  private readonly epoch = randomBytes(4).toString('hex');

  constructor(store: Store, config: Config = DEFAULT_CONFIG) {
    this.store = store;
    const loaded = store.load();
    if (loaded?.outbox.some((entry) => crashed(entry) !== entry))
      store.commit({ ...loaded, outbox: settle(loaded.outbox.map(crashed)) });
    this.persisted = store.load() ?? {
      v: 1 as const,
      eventSeq: 0,
      rev: 0,
      state: initialState(config),
      outbox: [],
      superseded: [],
    };
    if (loaded === null) store.commit(this.persisted);
  }

  get state(): State {
    return this.persisted.state;
  }
  get rev(): number {
    return this.persisted.rev;
  }
  get outbox(): readonly OutboxEntry[] {
    return this.persisted.outbox;
  }

  ingest(event: Event): Ingested {
    let fresh: OutboxEntry[] = [];
    this.persisted = this.store.record(event, (seq) => {
      const next = this.next(seq, event);
      fresh = next.fresh;
      return next.persisted;
    });
    return { rev: this.persisted.rev, commands: fresh };
  }

  bump(): number {
    this.save({ ...this.persisted, rev: this.persisted.rev + 1 });
    return this.persisted.rev;
  }

  begin(id: string): void {
    this.update(id, (entry) => ({ ...entry, attempts: entry.attempts + 1 }));
  }

  mark(id: string, status: OutboxStatus, error: string | null = null): void {
    this.update(id, (entry) => ({
      ...entry,
      status,
      error: status === 'failed' && entry.attempts >= MAX_ATTEMPTS ? gaveUp(error, entry.attempts) : error,
    }));
  }

  pending(): readonly OutboxEntry[] {
    return this.persisted.outbox.filter((entry) => entry.status === 'pending');
  }

  runnable(): readonly OutboxEntry[] {
    return this.persisted.outbox.filter(runnable);
  }

  private update(id: string, change: (entry: OutboxEntry) => OutboxEntry): void {
    const outbox = this.persisted.outbox.map((entry) => (entry.id === id ? change(entry) : entry));
    this.save({ ...this.persisted, rev: this.persisted.rev + 1, outbox: settle(outbox) });
  }

  private save(next: Persisted): void {
    this.store.commit(next);
    this.persisted = next;
  }

  private next(seq: number, event: Event): { persisted: Persisted; fresh: OutboxEntry[] } {
    const before = this.persisted;
    const reduced = reduce(before.state, event);
    const fresh = entriesFor(this.epoch, seq, reduced.commands);
    const moved = supersededBy(before.state, reduced.state);
    const superseded =
      moved.length === 0 ? before.superseded : [...new Set([...before.superseded, ...moved])].slice(-SUPERSEDED_CAP);
    const state = moved.length > 0 ? pruneSuperseded(reduced.state, new Set(superseded)) : reduced.state;
    return {
      fresh,
      persisted: {
        ...before,
        eventSeq: seq,
        rev: before.rev + 1,
        state,
        outbox: settle([...before.outbox, ...fresh]),
        superseded,
      },
    };
  }
}
