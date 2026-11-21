import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { initialState, type State } from '@agent-works/core';
import { describe, expect, it, vi } from 'vitest';
import { parseEvent } from '../events.ts';
import { Ledger, MAX_ATTEMPTS } from '../ledger.ts';
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

    it('refuses a gap even when the state row was edited to agree with the row count', () => {
      const dir = seeded('corrupt-gap-agreed');
      rawSql(dir, 'DELETE FROM events WHERE seq = 2');
      rawSql(dir, `UPDATE state SET body = replace(body, '"eventSeq":4', '"eventSeq":3')`);
      expect(() => Store.open(dir)).toThrow(/gap/);
    });

    it('refuses a state row that is ahead of or behind the log', () => {
      const dir = seeded('corrupt-behind');
      rawSql(dir, 'DELETE FROM events WHERE seq = 4');
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
    });

    it('refuses a state row that was edited into other valid JSON', () => {
      const dir = seeded('corrupt-state-edit');
      rawSql(dir, `UPDATE state SET body = replace(body, '"nova"', '"evil"') WHERE id = 1`);
      const failure = (() => {
        try {
          Store.open(dir);
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect(failure).toBeInstanceOf(StoreCorruptError);
      expect(String((failure as Error).message)).toContain('state row does not match its checksum');
      expect(countEvents(dir)).toBe(4);
    });

    it('refuses one altered byte inside the state row', () => {
      const dir = seeded('corrupt-state-byte');
      const file = join(dir, 'hq.db');
      const bytes = readFileSync(file);
      const at = bytes.lastIndexOf('"superseded"');
      expect(at).toBeGreaterThan(0);
      bytes[at + 1] = 'X'.charCodeAt(0);
      writeFileSync(file, bytes);
      expect(() => Store.open(dir)).toThrow(/state row does not match its checksum/);
      expect(countEvents(dir)).toBe(4);
    });

    it('refuses a state row that is cut short without leaking a parser error', () => {
      const dir = seeded('corrupt-state-cut');
      rawSql(dir, 'UPDATE state SET body = substr(body, 1, 40) WHERE id = 1');
      expect(() => Store.open(dir)).toThrow(StoreCorruptError);
    });

    it('refuses a log that still has events but lost its state row, and does not reset it', () => {
      const dir = seeded('corrupt-state-missing');
      rawSql(dir, 'DELETE FROM state');
      expect(() => Store.open(dir)).toThrow(/state row is missing/);
      expect(countEvents(dir)).toBe(4);
    });

    it('refuses a last event that was replaced by another valid one, so the state row is bound to the log', () => {
      const dir = seeded('corrupt-bound');
      const db = new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(join(dir, 'hq.db'));
      const row = db.prepare('SELECT body FROM events WHERE seq = 4').get() as { body: string };
      const body = row.body.replace('nova', 'novb');
      const sum = createHash('sha256').update(`4\n${body}`).digest('hex').slice(0, 32);
      db.prepare('UPDATE events SET body = ?, sum = ? WHERE seq = 4').run(body, sum);
      db.close();
      expect(body).not.toBe(row.body);
      expect(() => Store.open(dir)).toThrow(/state row does not match its checksum/);
    });

    it('refuses two events that traded sequence numbers, so the checksum covers the seq', () => {
      const dir = seeded('corrupt-swap');
      rawSql(
        dir,
        'UPDATE events SET seq = 99 WHERE seq = 2; UPDATE events SET seq = 2 WHERE seq = 3; UPDATE events SET seq = 3 WHERE seq = 99',
      );
      expect(() => Store.open(dir)).toThrow(/event [23] does not match its checksum/);
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

  it('lets one HQ own the directory and hands it over on close', () => {
    const dir = tempDir('ledger-lock');
    const first = Store.open(dir);
    const failure = (() => {
      try {
        Store.open(dir);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(failure).toBeInstanceOf(StoreLockedError);
    expect((failure as StoreLockedError).message).toBe(`another HQ (pid ${process.pid}) owns this state directory`);
    expect(first.load()).toBeNull();
    first.close();
    Store.open(dir).close();
  });

  it('is not fooled by a lock file that names a live process that is not an HQ', () => {
    const dir = tempDir('ledger-reuse');
    Store.open(dir).close();
    writeFileSync(join(dir, 'hq.lock'), String(process.ppid));
    const store = Store.open(dir);
    expect(readFileSync(join(dir, 'hq.lock'), 'utf8')).toBe(String(process.pid));
    store.close();
  });

  it('takes the write lock up front on every write', () => {
    const { store, ledger } = open(tempDir('ledger-immediate'));
    const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: { prototype: { exec: unknown } } };
    const exec = vi.spyOn(sqlite.DatabaseSync.prototype as { exec(sql: string): void }, 'exec');
    ledger.ingest(ev(story[0]));
    const statements = exec.mock.calls.map(([sql]) => sql);
    exec.mockRestore();
    expect(statements).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
    store.close();
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

  it('keeps an acknowledged command acknowledged after a restart', () => {
    const dir = tempDir('ledger-ack');
    const first = open(dir);
    for (const event of story) first.ledger.ingest(ev(event));
    const [entry] = first.ledger.pending();
    first.ledger.mark(entry?.id ?? '', 'done');
    first.store.close();
    const second = open(dir);
    expect(second.ledger.outbox.find((e) => e.id === entry?.id)?.status).toBe('done');
    expect(second.ledger.pending().map((e) => e.id)).not.toContain(entry?.id);
    second.store.close();
  });

  describe('a command that fails', () => {
    const seededFailing = () => {
      const { store, ledger } = open(tempDir('ledger-retry'));
      for (const event of story) ledger.ingest(ev(event));
      const [entry] = ledger.pending();
      return { store, ledger, id: entry?.id ?? '' };
    };

    it(`is offered again until it has failed ${MAX_ATTEMPTS} times, then stays failed with the reason`, () => {
      const { store, ledger, id } = seededFailing();
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
        ledger.begin(id);
        ledger.mark(id, 'failed', 'no image');
        expect(ledger.runnable().map((e) => e.id)).toContain(id);
      }
      ledger.begin(id);
      ledger.mark(id, 'failed', 'no image');
      const spent = ledger.outbox.find((e) => e.id === id);
      expect(spent).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
      expect(spent?.error).toBe(`no image (gave up after ${MAX_ATTEMPTS} attempts)`);
      expect(ledger.runnable().map((e) => e.id)).not.toContain(id);
      store.close();
    });

    it('is pruned with the other closed commands once it has given up, never before', () => {
      const { store, ledger, id } = seededFailing();
      ledger.begin(id);
      ledger.mark(id, 'failed', 'x');
      const saved = store.load() as Persisted;
      const retrying = saved.outbox.find((e) => e.id === id) as OutboxEntry;
      const spent = Array.from({ length: 250 }, (_, i) => ({
        ...retrying,
        id: `spent.${i}`,
        attempts: MAX_ATTEMPTS,
      }));
      store.commit({ ...saved, outbox: [...spent, retrying] });
      const reloaded = new Ledger(store);
      reloaded.begin(retrying.id);
      reloaded.mark(retrying.id, 'failed', 'x');
      const ids = reloaded.outbox.map((e) => e.id);
      expect(ids).toContain(retrying.id);
      expect(ids).toContain('spent.249');
      expect(ids).not.toContain('spent.0');
      expect(reloaded.outbox.length).toBeLessThanOrEqual(201);
      store.close();
    });

    it('keeps its attempt count across a restart', () => {
      const dir = tempDir('ledger-retry-restart');
      const first = open(dir);
      for (const event of story) first.ledger.ingest(ev(event));
      const id = first.ledger.pending()[0]?.id ?? '';
      first.ledger.begin(id);
      first.ledger.mark(id, 'failed', 'x');
      first.store.close();
      const second = open(dir);
      expect(second.ledger.outbox.find((e) => e.id === id)?.attempts).toBe(1);
      expect(second.ledger.runnable().map((e) => e.id)).toContain(id);
      second.store.close();
    });
  });

  it('counts a run that never finished as an attempt, so a command that kills HQ is given up', () => {
    const dir = tempDir('ledger-crash');
    let id = '';
    for (let boot = 1; boot <= MAX_ATTEMPTS; boot += 1) {
      const { store, ledger } = open(dir);
      if (boot === 1) for (const event of story) ledger.ingest(ev(event));
      id ||= ledger.pending()[0]?.id ?? '';
      expect(ledger.runnable().map((e) => e.id)).toContain(id);
      ledger.begin(id);
      store.close();
    }
    const { store, ledger } = open(dir);
    const spent = ledger.outbox.find((e) => e.id === id);
    expect(spent).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(spent?.error).toBe(`HQ stopped while it ran (gave up after ${MAX_ATTEMPTS} attempts)`);
    expect(ledger.runnable().map((e) => e.id)).not.toContain(id);
    store.close();
  });

  it('never issues a command id twice, even when the database is rolled back to an older copy', () => {
    const dir = tempDir('ledger-rollback');
    const first = open(dir);
    first.ledger.ingest(ev(story[0]));
    first.store.close();
    const backup = readFileSync(join(dir, 'hq.db'));
    const issued = [0, 1].map(() => {
      writeFileSync(join(dir, 'hq.db'), backup);
      const { store, ledger } = open(dir);
      const ids = story.slice(1).flatMap((event) => ledger.ingest(ev(event)).commands.map((entry) => entry.id));
      store.close();
      return ids;
    });
    const [a = [], b = []] = issued;
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((id) => id.split('.').slice(1).join('.'))).toEqual(b.map((id) => id.split('.').slice(1).join('.')));
    expect(a.filter((id) => b.includes(id))).toEqual([]);
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
