import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Command, Event, State } from '@agent-works/core';
import { pidAlive } from '../config.ts';
import { canonicalJson } from './atomic.ts';

export type OutboxStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface OutboxEntry {
  readonly id: string;
  readonly command: Command;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly error: string | null;
}

export interface Persisted {
  readonly v: 1;
  readonly eventSeq: number;
  readonly rev: number;
  readonly state: State;
  readonly outbox: readonly OutboxEntry[];
  readonly superseded: readonly string[];
}

export interface LoggedEvent {
  readonly seq: number;
  readonly event: Event;
}

export class StoreLockedError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`another HQ (pid ${pid}) owns this state directory`);
    this.pid = pid;
  }
}

export class StoreCorruptError extends Error {}

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const openDatabase = (path: string): Database => {
  let module: { DatabaseSync: new (path: string) => Database };
  try {
    module = createRequire(import.meta.url)('node:sqlite') as typeof module;
  } catch {
    throw new Error(
      `HQ stores its state with node:sqlite, which needs Node 22.18 or newer. This is ${process.version}.`,
    );
  }
  return new module.DatabaseSync(path);
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, sum TEXT NOT NULL) STRICT;
`;

const sumOf = (seq: number, body: string): string =>
  createHash('sha256').update(`${seq}\n${body}`).digest('hex').slice(0, 32);

const decode = (row: Record<string, unknown>): LoggedEvent => {
  const seq = Number(row.seq);
  const body = String(row.body);
  if (sumOf(seq, body) !== row.sum) throw new StoreCorruptError(`event ${seq} does not match its checksum`);
  return { seq, event: JSON.parse(body) as Event };
};

export class Store {
  private readonly lockPath: string;
  private readonly db: Database;

  private constructor(dir: string) {
    this.lockPath = join(dir, 'hq.lock');
    this.lock();
    const db = this.attempt(() => openDatabase(join(dir, 'hq.db')));
    this.db = db;
    this.attempt(() => {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec(SCHEMA);
      this.verify();
    }, db);
  }

  private attempt<T>(work: () => T, db?: Database): T {
    try {
      return work();
    } catch (error) {
      try {
        db?.close();
      } catch {}
      this.release();
      throw error;
    }
  }

  static open(dir: string): Store {
    mkdirSync(dir, { recursive: true });
    return new Store(dir);
  }

  private lock(): void {
    for (;;) {
      try {
        writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(readFileSync(this.lockPath, 'utf8'));
        if (Number.isInteger(owner) && owner !== process.pid && pidAlive(owner)) throw new StoreLockedError(owner);
        unlinkSync(this.lockPath);
      }
    }
  }

  private release(): void {
    try {
      if (readFileSync(this.lockPath, 'utf8') === String(process.pid)) unlinkSync(this.lockPath);
    } catch {}
  }

  private verify(): void {
    const span = this.db.prepare('SELECT count(*) AS n, min(seq) AS low, max(seq) AS high FROM events').get();
    const n = Number(span?.n ?? 0);
    if (n > 0 && (Number(span?.low) !== 1 || Number(span?.high) !== n))
      throw new StoreCorruptError(
        `the event log has a gap, it holds ${n} events between ${span?.low} and ${span?.high}`,
      );
    for (const row of this.db.prepare('SELECT seq, body, sum FROM events ORDER BY seq').all()) decode(row);
    const saved = this.load();
    if (saved !== null && saved.eventSeq !== n)
      throw new StoreCorruptError(`the state was saved at event ${saved.eventSeq} but the log holds ${n}`);
    if (saved === null && n > 0) throw new StoreCorruptError(`the log holds ${n} events and the state row is missing`);
  }

  durability(): { journal: string; synchronous: number } {
    return {
      journal: String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode),
      synchronous: Number(this.db.prepare('PRAGMA synchronous').get()?.synchronous),
    };
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      this.release();
    }
  }

  load(): Persisted | null {
    const row = this.db.prepare('SELECT body FROM state WHERE id = 1').get();
    return row === undefined ? null : (JSON.parse(String(row.body)) as Persisted);
  }

  events(afterSeq: number): LoggedEvent[] {
    return this.db.prepare('SELECT seq, body, sum FROM events WHERE seq > ? ORDER BY seq').all(afterSeq).map(decode);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private put(persisted: Persisted): void {
    this.db
      .prepare('INSERT INTO state (id, body) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body')
      .run(canonicalJson(persisted));
  }

  record(event: Event, next: (seq: number) => Persisted): Persisted {
    return this.transaction(() => {
      const seq = Number(this.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS seq FROM events').get()?.seq);
      const body = canonicalJson(event);
      this.db.prepare('INSERT INTO events (seq, body, sum) VALUES (?, ?, ?)').run(seq, body, sumOf(seq, body));
      const persisted = next(seq);
      this.put(persisted);
      return persisted;
    });
  }

  commit(persisted: Persisted): void {
    this.transaction(() => this.put(persisted));
  }
}
