import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, Event, State } from '@agent-works/core';
import { appendDurable, canonicalJson, writeAtomic } from './atomic.ts';

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

const checksum = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 8);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const parseLogLine = (line: string): LoggedEvent | null => {
  const tab = line.indexOf('\t');
  if (tab !== 8) return null;
  const body = line.slice(tab + 1);
  if (checksum(body) !== line.slice(0, tab)) return null;
  try {
    return JSON.parse(body) as LoggedEvent;
  } catch {
    return null;
  }
};

export class Store {
  readonly dir: string;
  private readonly statePath: string;
  private readonly logPath: string;
  private readonly lockPath: string;
  private seq = 0;

  private constructor(dir: string) {
    this.dir = dir;
    this.statePath = join(dir, 'state.json');
    this.logPath = join(dir, 'events.jsonl');
    this.lockPath = join(dir, 'hq.lock');
  }

  static open(dir: string): Store {
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    store.lock();
    store.repairTail();
    return store;
  }

  private lock(): void {
    for (;;) {
      try {
        writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(readFileSync(this.lockPath, 'utf8'));
        if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) throw new StoreLockedError(owner);
        unlinkSync(this.lockPath);
      }
    }
  }

  private repairTail(): void {
    if (!existsSync(this.logPath)) return;
    const text = readFileSync(this.logPath, 'utf8');
    let good = 0;
    let offset = 0;
    for (const line of text.split('\n')) {
      const end = offset + Buffer.byteLength(line) + 1;
      if (line === '') break;
      const parsed = parseLogLine(line);
      if (parsed === null || end > Buffer.byteLength(text)) break;
      good = end;
      this.seq = parsed.seq;
      offset = end;
    }
    if (good < Buffer.byteLength(text)) truncateSync(this.logPath, good);
  }

  close(): void {
    try {
      if (readFileSync(this.lockPath, 'utf8') === String(process.pid)) unlinkSync(this.lockPath);
    } catch {}
  }

  load(): Persisted | null {
    if (!existsSync(this.statePath)) return null;
    return JSON.parse(readFileSync(this.statePath, 'utf8')) as Persisted;
  }

  events(afterSeq: number): LoggedEvent[] {
    if (!existsSync(this.logPath)) return [];
    const out: LoggedEvent[] = [];
    for (const line of readFileSync(this.logPath, 'utf8').split('\n')) {
      const parsed = line === '' ? null : parseLogLine(line);
      if (parsed !== null && parsed.seq > afterSeq) out.push(parsed);
    }
    return out;
  }

  append(event: Event): number {
    this.seq += 1;
    const body = canonicalJson({ seq: this.seq, event });
    appendDurable(this.logPath, `${checksum(body)}\t${body}\n`);
    return this.seq;
  }

  commit(persisted: Persisted): void {
    writeAtomic(this.statePath, canonicalJson(persisted));
  }
}
