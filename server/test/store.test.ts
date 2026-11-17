import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { initialState, type State } from '@agent-works/core';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../events.ts';
import { Ledger } from '../ledger.ts';
import { pruneSuperseded } from '../store/prune.ts';
import { type OutboxEntry, type Persisted, Store, StoreCorruptError, StoreLockedError } from '../store/store.ts';
import { change, check, hasSqlite, human, tempDir } from './helpers.ts';

const ev = (raw: unknown) => parseEvent(raw);

const open = (dir: string) => {
  const store = Store.open(dir);
  return { store, ledger: new Ledger(store) };
};

const story = [
  human.addWorker('nova'),
  human.addWorker('reviewer'),
  human.order('acme/t1'),
  human.hire('acme/t1', 'nova'),
  change(),
  check(),
];

describe.skipIf(!hasSqlite)('ledger and store', () => {
  it('survives a restart with the same state, revision and no repeated commands', () => {
    const dir = tempDir('ledger-restart');
    const first = open(dir);
    for (const event of story) first.ledger.ingest(ev(event));
    const before = { state: first.ledger.state, rev: first.ledger.rev, outbox: first.ledger.outbox };
    expect(before.outbox.some((entry) => entry.command.kind === 'start_cage')).toBe(true);
    first.store.close();
    const second = open(dir);
    expect(second.ledger.state).toEqual(before.state);
    expect(second.ledger.rev).toBe(before.rev);
    expect(second.ledger.outbox).toEqual(before.outbox);
    second.store.close();
  });

  it('writes an event and the state it produced together or not at all', () => {
    const dir = tempDir('ledger-atomic');
    const { store, ledger } = open(dir);
    for (const event of story.slice(0, 3)) ledger.ingest(ev(event));
    const before = { state: ledger.state, rev: ledger.rev };
    expect(() =>
      store.record(ev(story[3]), () => {
        throw new Error('boom');
      }),
    ).toThrow();
    expect(store.events(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ledger.state).toEqual(before.state);
    ledger.ingest(ev(story[3]));
    expect(store.events(0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    store.close();
    const again = open(dir);
    expect(again.ledger.rev).toBe(before.rev + 1);
    expect(again.store.events(0)).toHaveLength(4);
    again.store.close();
  });

  it('opens with every acknowledged event and no repeated command after a restart', () => {
    const dir = tempDir('ledger-replay');
    const first = open(dir);
    for (const event of story) first.ledger.ingest(ev(event));
    const ids = first.ledger.outbox.map((entry) => entry.id);
    first.store.close();
    const second = open(dir);
    expect(second.store.events(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(second.ledger.outbox.map((entry) => entry.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    second.store.close();
  });

  describe('a damaged database fails loudly, never by dropping events', () => {
    const seeded = (label: string, count = 4) => {
      const dir = tempDir(label);
      const first = open(dir);
      for (const event of story.slice(0, count)) first.ledger.ingest(ev(event));
      first.store.close();
      return dir;
    };
    const rawSql = (dir: string, sql: string) => {
      const db = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(join(dir, 'hq.db'));
      db.exec(sql);
      db.close();
    };
    const countEvents = (dir: string): number => {
      const db = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(join(dir, 'hq.db'));
      const n = Number(db.prepare('SELECT count(*) AS n FROM events').get().n);
      db.close();
      return n;
    };

    it('refuses one altered byte in a middle event and keeps every event', () => {
      const dir = seeded('corrupt-middle');
      const file = join(dir, 'hq.db');
      const bytes = readFileSync(file);
      const needle = '"kind":"add_worker","source":"human","worker":"reviewer"';
      const at = bytes.indexOf(needle);
      expect(at).toBeGreaterThan(0);
      bytes[at + needle.length - 3] = 'X'.charCodeAt(0);
      writeFileSync(file, bytes);
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
      expect(() => Store.open(dir)).toThrow(/event 2/);
      expect(countEvents(dir)).toBe(4);
    });

    it('refuses a changed event body that kept its length', () => {
      const dir = seeded('corrupt-sql');
      rawSql(dir, "UPDATE events SET body = replace(body, 'reviewer', 'attacker') WHERE seq = 2");
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
      expect(countEvents(dir)).toBe(4);
    });

    it('refuses a log with a missing event and does not reuse its number', () => {
      const dir = seeded('corrupt-gap');
      rawSql(dir, 'DELETE FROM events WHERE seq = 2');
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
      expect(countEvents(dir)).toBe(3);
    });

    it('refuses a state row that is ahead of or behind the log', () => {
      const dir = seeded('corrupt-behind');
      rawSql(dir, 'DELETE FROM events WHERE seq = 4');
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
    });

    it('releases the lock when it refuses, so the operator can repair and retry', () => {
      const dir = seeded('corrupt-lock');
      rawSql(dir, "UPDATE events SET sum = 'x' WHERE seq = 1");
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
      expect(existsSync(join(dir, 'hq.lock'))).toBe(false);
    });
  });

  it('commits through the write-ahead log with a full sync on every commit', () => {
    const store = Store.open(tempDir('ledger-durable'));
    expect(store.durability()).toEqual({ journal: 'wal', synchronous: 2 });
    store.close();
  });

  it('lets one HQ own the directory', () => {
    const dir = tempDir('ledger-lock');
    const first = Store.open(dir);
    expect(() => Store.open(dir)).not.toThrow();
    first.close();
    const other = Store.open(dir);
    other.close();
    writeFileSync(join(dir, 'hq.lock'), String(process.ppid));
    expect(() => Store.open(dir)).toThrow(StoreLockedError);
  });

  it('marks a command done and keeps the revision rising', () => {
    const dir = tempDir('ledger-mark');
    const { store, ledger } = open(dir);
    for (const event of story) ledger.ingest(ev(event));
    const [entry] = ledger.pending();
    const rev = ledger.rev;
    ledger.mark(entry?.id ?? '', 'done');
    expect(ledger.rev).toBe(rev + 1);
    expect(ledger.outbox.find((e) => e.id === entry?.id)?.status).toBe('done');
    store.close();
  });

  it('trims closed commands to the newest 200 and keeps every open one', () => {
    const { store, ledger } = open(tempDir('ledger-trim'));
    for (const event of story) ledger.ingest(ev(event));
    const saved = store.load() as Persisted;
    const open1 = saved.outbox.find((entry) => entry.status === 'pending') as OutboxEntry;
    const closed = Array.from({ length: 250 }, (_, i) => ({ ...open1, id: `old.${i}`, status: 'done' as const }));
    store.commit({ ...saved, outbox: [...closed, open1] });
    const reloaded = new Ledger(store);
    reloaded.mark(open1.id, 'done');
    const ids = reloaded.outbox.map((entry) => entry.id);
    expect(ids).toHaveLength(200);
    expect(ids).toContain(open1.id);
    expect(ids).not.toContain('old.0');
    expect(ids).toContain('old.249');
    store.close();
  });

  it('prunes facts of a head that was replaced and never the live head', () => {
    const dir = tempDir('ledger-prune');
    const { store, ledger } = open(dir);
    for (const event of story) ledger.ingest(ev(event));
    expect(Object.keys(ledger.state.checks)).toEqual(['acme/app|a1']);
    ledger.ingest(ev(change({ headSha: 'b2', at: 200 })));
    expect(Object.keys(ledger.state.checks)).toEqual([]);
    ledger.ingest(ev(check({ headSha: 'b2', at: 210 })));
    expect(Object.keys(ledger.state.checks)).toEqual(['acme/app|b2']);
    ledger.ingest(ev(change({ headSha: 'c3', at: 300 })));
    expect(Object.keys(ledger.state.checks)).toEqual([]);
    store.close();
  });

  it('keeps the facts of a head that returns after it was replaced', () => {
    const dir = tempDir('ledger-return');
    const { store, ledger } = open(dir);
    for (const event of story) ledger.ingest(ev(event));
    ledger.ingest(ev(change({ headSha: 'b2', at: 200 })));
    ledger.ingest(ev(check({ headSha: 'a1', at: 250 })));
    ledger.ingest(ev(change({ headSha: 'a1', at: 300 })));
    expect(Object.keys(ledger.state.checks)).toEqual(['acme/app|a1']);
    store.close();
  });

  it('keeps facts for a head it has not seen move, so a check that arrives early survives', () => {
    const dir = tempDir('ledger-early');
    const { store, ledger } = open(dir);
    ledger.ingest(ev(check({ headSha: 'zz', at: 50 })));
    ledger.ingest(ev(change({ headSha: 'a1' })));
    expect(Object.keys(ledger.state.checks)).toContain('acme/app|zz');
    store.close();
  });

  it('pruning leaves a state that equals the unpruned one for every box and command', () => {
    const base: State = initialState({ budget: 3, approvals: 1 });
    const state: State = {
      ...base,
      checks: { 'r|old': { ci: { v: 'success', at: 1 } }, 'r|new': { ci: { v: 'success', at: 2 } } },
      reviews: { 'r#1|old': { x: { v: 'approve', at: 1 } }, 'r#1|new': { x: { v: 'approve', at: 2 } } },
      changes: {
        'r#1@aw/a/b': {
          repo: 'r',
          number: 1,
          branch: 'aw/a/b',
          author: { v: 'n' as never, at: 1 },
          head: { v: 'new', at: 2 },
          first: 1,
          at: 2,
          state: 'open',
        },
      },
    };
    const pruned = pruneSuperseded(state, new Set(['old', 'new']));
    expect(Object.keys(pruned.checks)).toEqual(['r|new']);
    expect(Object.keys(pruned.reviews)).toEqual(['r#1|new']);
    expect(pruneSuperseded(state, new Set())).toBe(state);
  });
});
