import { type Command, type Config, type Event, initialState, reduce, type State } from '@agent-works/core';
import { pruneSuperseded, supersededBy } from './store/prune.ts';
import type { OutboxEntry, OutboxStatus, Persisted, Store } from './store/store.ts';

export const DEFAULT_CONFIG: Config = { budget: 3, approvals: 1 };
const SUPERSEDED_CAP = 10_000;
const DONE_KEPT = 200;

export interface Ingested {
  readonly rev: number;
  readonly commands: readonly OutboxEntry[];
}

const entriesFor = (seq: number, commands: readonly Command[]): OutboxEntry[] =>
  commands.map((command, index) => ({ id: `${seq}.${index}`, command, status: 'pending', attempts: 0, error: null }));

const settle = (outbox: readonly OutboxEntry[]): OutboxEntry[] => {
  const open = outbox.filter((entry) => entry.status === 'pending' || entry.status === 'failed');
  const closed = outbox.filter((entry) => entry.status !== 'pending' && entry.status !== 'failed');
  return [...open, ...closed.slice(-DONE_KEPT)];
};

export class Ledger {
  private readonly store: Store;
  private persisted: Persisted;

  constructor(store: Store, config: Config = DEFAULT_CONFIG) {
    this.store = store;
    const loaded = store.load();
    const saved = loaded ?? {
      v: 1 as const,
      eventSeq: 0,
      rev: 0,
      state: initialState(config),
      outbox: [],
      superseded: [],
    };
    this.persisted = saved;
    const replay = store.events(saved.eventSeq);
    for (const logged of replay) this.apply(logged.seq, logged.event);
    if (replay.length > 0 || loaded === null) this.store.commit(this.persisted);
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
    const seq = this.store.append(event);
    const commands = this.apply(seq, event);
    this.store.commit(this.persisted);
    return { rev: this.persisted.rev, commands };
  }

  bump(): number {
    this.persisted = { ...this.persisted, rev: this.persisted.rev + 1 };
    this.store.commit(this.persisted);
    return this.persisted.rev;
  }

  mark(id: string, status: OutboxStatus, error: string | null = null): void {
    const outbox = this.persisted.outbox.map((entry) =>
      entry.id === id
        ? { ...entry, status, error, attempts: status === 'failed' ? entry.attempts + 1 : entry.attempts }
        : entry,
    );
    this.persisted = { ...this.persisted, rev: this.persisted.rev + 1, outbox: settle(outbox) };
    this.store.commit(this.persisted);
  }

  pending(): readonly OutboxEntry[] {
    return this.persisted.outbox.filter((entry) => entry.status === 'pending');
  }

  private apply(seq: number, event: Event): OutboxEntry[] {
    const before = this.persisted;
    const reduced = reduce(before.state, event);
    const fresh = entriesFor(seq, reduced.commands);
    const moved = supersededBy(before.state, reduced.state);
    const superseded =
      moved.length === 0 ? before.superseded : [...new Set([...before.superseded, ...moved])].slice(-SUPERSEDED_CAP);
    const state = moved.length > 0 ? pruneSuperseded(reduced.state, new Set(superseded)) : reduced.state;
    this.persisted = {
      ...before,
      eventSeq: seq,
      rev: before.rev + 1,
      state,
      outbox: settle([...before.outbox, ...fresh]),
      superseded,
    };
    return fresh;
  }
}
