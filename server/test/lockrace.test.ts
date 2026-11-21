import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasSqlite, tempDir } from './helpers.ts';

const CHILD = fileURLToPath(new URL('./lockrace-child.mjs', import.meta.url));
const canRun = (process.features as { typescript?: boolean | string }).typescript ? hasSqlite : false;
const TRIALS = 60;
const PROCESSES = 6;
const GAP_MS = 120;

const racer = (base: string, startAt: number) => {
  const child = spawn(process.execPath, [CHILD, base, String(startAt), String(TRIALS), String(GAP_MS)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes('DONE')) finished();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) =>
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`racer exited ${code}: ${err}`)))),
  );
  return { done, release: () => child.stdin.end(), exited, lines: () => out.trim().split('\n') };
};

describe.skipIf(!canRun)('the state directory lock', () => {
  it(`lets exactly one of ${PROCESSES} processes open a store over a stale lock, in each of ${TRIALS} trials`, async () => {
    const base = tempDir('lockrace');
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dir = join(base, `t${trial}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'hq.lock'), '4000000');
    }
    const startAt = Date.now() + 3000;
    const racers = Array.from({ length: PROCESSES }, () => racer(base, startAt));
    await Promise.all(racers.map((r) => r.done));
    for (const r of racers) r.release();
    await Promise.all(racers.map((r) => r.exited));
    const lines = racers.flatMap((r) => r.lines());
    const opened = new Array<number>(TRIALS).fill(0);
    for (const line of lines) {
      const [trial, verdict] = line.split(' ');
      if (verdict === 'OPEN') opened[Number(trial)] = (opened[Number(trial)] ?? 0) + 1;
    }
    expect(opened.filter((count) => count > 1).length, 'trials with more than one owner').toBe(0);
    expect(opened.filter((count) => count === 0).length, 'trials with no owner').toBe(0);
  }, 60_000);
});
