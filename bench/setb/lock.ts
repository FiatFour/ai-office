import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TaskRefused } from '../model.ts';

interface Holder {
  readonly pid: number;
  readonly startedAt: string;
  readonly command: string;
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const createExclusive = (file: string, text: string): boolean => {
  try {
    writeFileSync(file, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
    return false;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === 'EPERM';
  }
};

const holderOf = (file: string): Holder => {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as Holder;
    if (Number.isInteger(held.pid) && held.pid > 0) return held;
  } catch {}
  throw new TaskRefused(`${file} is held by an unreadable lock; if no driver is running, delete it by hand`);
};

/** Removes a lock whose process is gone. Only one process at a time may do this, or two could each remove the other's. */
const breakStale = (file: string): void => {
  const breaker = `${file}.break`;
  if (!createExclusive(breaker, String(process.pid)))
    throw new TaskRefused(`${breaker} exists: another process is clearing a stale lock; if none is, delete it by hand`);
  try {
    const held = holderOf(file);
    if (alive(held.pid))
      throw new TaskRefused(
        `${file} is held by pid ${held.pid} (${held.command}, started ${held.startedAt}); one driver at a time. If that pid is not a driver (a pid is reused after a reboot), delete the file by hand`,
      );
    unlinkSync(file);
  } finally {
    unlinkSync(breaker);
  }
};

/** Takes the lock or throws. The returned function releases it, and only if it is still this process's lock. */
export const acquireLock = (file: string, command: string): (() => void) => {
  mkdirSync(dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command } satisfies Holder);
  if (!createExclusive(file, mine)) {
    breakStale(file);
    if (!createExclusive(file, mine)) throw new TaskRefused(`${file} was taken while a stale lock was cleared`);
  }
  return () => {
    try {
      if (readFileSync(file, 'utf8') === mine) unlinkSync(file);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
  };
};

type Cleanup = () => Promise<unknown>;

const cleanups = new Set<Cleanup>();
let listening = false;
const CLEANUP_MS = 60_000;

/** On SIGINT, SIGTERM and SIGHUP: runs every registered cleanup, then exits, which releases the locks. */
const listen = (): void => {
  if (listening) return;
  listening = true;
  let stopping = false;
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const exit = () => process.exit(code);
      setTimeout(exit, CLEANUP_MS).unref();
      void Promise.allSettled([...cleanups].map(async (cleanup) => cleanup())).then(exit);
    });
};

/** Registers what a signal must stop before the process exits. The returned function removes it. */
export const onStop = (cleanup: Cleanup): (() => void) => {
  listen();
  cleanups.add(cleanup);
  return () => void cleanups.delete(cleanup);
};

/** Holds the lock for the rest of the process: released on exit, a signal's exit included. */
export const holdLock = (file: string, command: string): void => {
  process.on('exit', acquireLock(file, command));
  listen();
};
