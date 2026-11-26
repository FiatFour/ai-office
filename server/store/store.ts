import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Command, Event, State } from '@agent-works/core';
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
  readonly pid: number | null;
  constructor(pid: number | null) {
    super(`another HQ${pid === null ? '' : ` (pid ${pid})`} owns this state directory`);
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
CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sum TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, sum TEXT NOT NULL) STRICT;
`;

const sumOf = (seq: number, body: string): string =>
  createHash('sha256').update(`${seq}\n${body}`).digest('hex').slice(0, 32);

const GENESIS = 'genesis';

const stateSumOf = (eventSeq: number, lastEventSum: string, body: string): string =>
  createHash('sha256').update(`${eventSeq}\n${lastEventSum}\n${body}`).digest('hex').slice(0, 32);

const decode = (row: Record<string, unknown>): LoggedEvent => {
  const seq = Number(row.seq);
  const body = String(row.body);
  if (sumOf(seq, body) !== row.sum) throw new StoreCorruptError(`event ${seq} does not match its checksum`);
  return { seq, event: JSON.parse(body) as Event };
};

const isBusy = (error: unknown): boolean => {
  const { errcode, message } = error as { errcode?: number; message?: string };
  return errcode === 5 || errcode === 6 || /database is locked|busy/i.test(message ?? '');
};

const isNotDatabase = (error: unknown): boolean => {
  const { errcode, message } = error as { errcode?: number; message?: string };
  return errcode === 26 || errcode === 11 || /not a database|malformed/i.test(message ?? '');
};

const notDatabase = (): StoreCorruptError =>
  new StoreCorruptError('hq.db is not a valid database, it was overwritten or damaged');

const CLAIM_WINDOW_MS = 100;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export class Store {
  private readonly lockPath: string;
  private readonly db: Database;
  private held = false;

  private constructor(dir: string) {
    this.lockPath = join(dir, 'hq.lock');
    this.db = this.claim(join(dir, 'hq.db'));
    try {
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec(SCHEMA);
      this.verify();
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      this.release();
      if (!(error instanceof StoreCorruptError) && isNotDatabase(error)) throw notDatabase();
      throw error;
    }
  }

  static open(dir: string): Store {
    mkdirSync(dir, { recursive: true });
    return new Store(dir);
  }

  private claim(file: string): Database {
    const deadline = Date.now() + CLAIM_WINDOW_MS;
    for (;;) {
      const db = openDatabase(file);
      try {
        db.exec('PRAGMA locking_mode = EXCLUSIVE');
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('BEGIN IMMEDIATE');
        db.exec('COMMIT');
        this.held = true;
        writeFileSync(this.lockPath, String(process.pid));
        return db;
      } catch (error) {
        try {
          db.close();
        } catch {}
        if (isNotDatabase(error)) throw notDatabase();
        if (!isBusy(error)) throw error;
        if (Date.now() >= deadline) throw new StoreLockedError(this.owner());
        sleepSync(2 + Math.random() * 10);
      }
    }
  }

  private owner(): number | null {
    try {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private release(): void {
    if (!this.held) return;
    this.held = false;
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
    const saved = this.readState();
    if (saved !== null && saved.persisted.eventSeq !== n)
      throw new StoreCorruptError(`the state was saved at event ${saved.persisted.eventSeq} but the log holds ${n}`);
    if (saved === null && n > 0) throw new StoreCorruptError(`the log holds ${n} events and the state row is missing`);
    if (saved !== null && saved.sum !== this.stateSum(saved.persisted.eventSeq, saved.body))
      throw new StoreCorruptError('the state row does not match its checksum, it was edited or damaged');
  }

  private stateSum(eventSeq: number, body: string): string {
    const last = this.db.prepare('SELECT sum FROM events WHERE seq = ?').get(eventSeq);
    return stateSumOf(eventSeq, last === undefined ? GENESIS : String(last.sum), body);
  }

  private readState(): { persisted: Persisted; body: string; sum: string } | null {
    const row = this.db.prepare('SELECT body, sum FROM state WHERE id = 1').get();
    if (row === undefined) return null;
    const body = String(row.body);
    try {
      return { persisted: JSON.parse(body) as Persisted, body, sum: String(row.sum) };
    } catch {
      throw new StoreCorruptError('the state row is not valid JSON');
    }
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
    return this.readState()?.persisted ?? null;
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
    const body = canonicalJson(persisted);
    this.db
      .prepare(
        'INSERT INTO state (id, body, sum) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, sum = excluded.sum',
      )
      .run(body, this.stateSum(persisted.eventSeq, body));
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
