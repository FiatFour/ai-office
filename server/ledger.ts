import { type Command, type Config, type Event, initialState, reduce, type State } from '@agent-works/core';
import { pruneSuperseded, supersededBy } from './store/prune.ts';
import type { OutboxEntry, OutboxStatus, Persisted, Store } from './store/store.ts';

export const DEFAULT_CONFIG: Config = { budget: 3, approvals: 1 };
const SUPERSEDED_CAP = 10_000;
const DONE_KEPT = 200;
export const MAX_ATTEMPTS = 3;

const retryable = (entry: OutboxEntry): boolean => entry.status === 'failed' && entry.attempts < MAX_ATTEMPTS;

export interface Ingested {
  readonly rev: number;
  readonly commands: readonly OutboxEntry[];
}

const entriesFor = (seq: number, commands: readonly Command[]): OutboxEntry[] =>
  commands.map((command, index) => ({ id: `${seq}.${index}`, command, status: 'pending', attempts: 0, error: null }));

const settle = (outbox: readonly OutboxEntry[]): OutboxEntry[] => {
  const isOpen = (entry: OutboxEntry): boolean => entry.status === 'pending' || retryable(entry);
  const open = outbox.filter(isOpen);
  const closed = outbox.filter((entry) => !isOpen(entry));
  return [...open, ...closed.slice(-DONE_KEPT)];
};

export class Ledger {
  private readonly store: Store;
  private persisted: Persisted;

  constructor(store: Store, config: Config = DEFAULT_CONFIG) {
    this.store = store;
    const loaded = store.load();
    this.persisted = loaded ?? {
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

  mark(id: string, status: OutboxStatus, error: string | null = null): void {
    const outbox = this.persisted.outbox.map((entry) => {
      if (entry.id !== id) return entry;
      const attempts = status === 'failed' ? entry.attempts + 1 : entry.attempts;
      const reason =
        status === 'failed' && attempts >= MAX_ATTEMPTS ? `${error} (gave up after ${attempts} attempts)` : error;
      return { ...entry, status, error: reason, attempts };
    });
    this.save({ ...this.persisted, rev: this.persisted.rev + 1, outbox: settle(outbox) });
  }

  pending(): readonly OutboxEntry[] {
    return this.persisted.outbox.filter((entry) => entry.status === 'pending');
  }

  runnable(): readonly OutboxEntry[] {
    return this.persisted.outbox.filter((entry) => entry.status === 'pending' || retryable(entry));
  }

  private save(next: Persisted): void {
    this.store.commit(next);
    this.persisted = next;
  }

  private next(seq: number, event: Event): { persisted: Persisted; fresh: OutboxEntry[] } {
    const before = this.persisted;
    const reduced = reduce(before.state, event);
    const fresh = entriesFor(seq, reduced.commands);
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
