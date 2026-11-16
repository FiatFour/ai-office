import { describe, expect, it } from 'vitest';
import type { Event, State } from '../src/lifecycle.js';
import { eventFromInts, type Ints } from './generators.js';
import { record } from './harness.js';
import { initialState, reduce } from './subject.js';

const MINIMUM = 10_000;
const MIN_SMALL_EVENTS = 200_000;
const MIN_LARGE_EVENTS = 20_000;
const MIN_LARGE_CHUNKS = 4;

function xorshift(seed: number) {
  let x = seed;
  return (modulus: number) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % modulus;
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

describe('throughput', () => {
  it('small states: one million random events in 5,000 runs of 200, reset to empty each run, three runs', () => {
    const TOTAL = 1_000_000;
    const SEQUENCE = 200;
    const next = xorshift(123456789);
    const sequences: Event[][] = Array.from({ length: TOTAL / SEQUENCE }, () =>
      Array.from({ length: SEQUENCE }, () =>
        eventFromInts(Array.from({ length: 8 }, () => next(1000)) as unknown as Ints),
      ),
    );
    const rates: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      let commands = 0;
      let events = 0;
      for (const sequence of sequences) {
        let state = initialState({ budget: 3, approvals: 1 });
        for (const event of sequence) {
          const step = reduce(state, event);
          state = step.state;
          commands += step.commands.length;
          events += 1;
        }
      }
      const seconds = (performance.now() - started) / 1000;
      rates.push(events / seconds);
      process.stdout.write(
        `throughput small run ${run + 1}: ${events} events, ${sequences.length} sequences, ${commands} commands, ${seconds.toFixed(2)} s, ${Math.round(events / seconds)} events/s\n`,
      );
    }
    record('throughput-small', [
      `throughput small states (at most 6 boxes, reset every 200 events), ${TOTAL} events, 3 runs`,
      ...rates.map((rate, i) => `run ${i + 1}: ${Math.round(rate)} events/s`),
      `median ${Math.round(median(rates))} events/s, minimum allowed ${MINIMUM}`,
      Math.min(...rates) >= MINIMUM ? 'PASS' : 'FAIL',
    ]);
    expect(sequences.length * SEQUENCE).toBeGreaterThanOrEqual(MIN_SMALL_EVENTS);
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(MINIMUM);
  });

  it('large states: one factory that never resets, many tasks in flight, state kept as it grows', () => {
    const TASKS_TOTAL = Number(process.env.LIFECYCLE_PERF_TASKS ?? 3000);
    const WINDOW = 25;
    const WORKERS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];
    const next = xorshift(2463534242);
    let at = 1;
    const script = (index: number): Event[] => {
      const task = `x${Math.floor(index / 10)}/t${index % 10}`;
      const repo = `r${index % 3}`;
      const number = index + 1;
      const head = `h${index}`;
      const worker = WORKERS[index % WORKERS.length] as string;
      const shipment =
        index % 2 === 0 ? { id: `s${Math.floor(index / 2)}`, size: 2 } : { id: `s${Math.floor(index / 2)}`, size: 2 };
      const change = (state: 'open' | 'merged'): Event => ({
        source: 'webhook',
        kind: 'change',
        repo,
        headRepo: repo,
        number,
        branch: `aw/${task}`,
        author: worker,
        state,
        headSha: head,
        at: at++,
      });
      return [
        { source: 'human', kind: 'order', task, shipment },
        { source: 'human', kind: 'hire', task, worker },
        change('open'),
        { source: 'webhook', kind: 'check', repo, headSha: head, name: 'ci', state: 'success', at: at++ },
        {
          source: 'webhook',
          kind: 'review',
          repo,
          number,
          reviewer: 'peer',
          verdict: 'approve',
          headSha: head,
          at: at++,
        },
        { source: 'webhook', kind: 'check', repo, headSha: head, name: 'ci', state: 'success', at: at++ },
        change('open'),
        change('merged'),
      ];
    };
    const live: Event[][] = [];
    let spawned = 0;
    const CHUNK = 5_000;
    let state: State = initialState({ budget: 8, approvals: 1 });
    let events = 0;
    let chunkStart = performance.now();
    let chunkEvents = 0;
    const curve: { boxes: number; changes: number; rate: number }[] = [];
    while (spawned < TASKS_TOTAL || live.length > 0) {
      while (live.length < WINDOW && spawned < TASKS_TOTAL) live.push(script(spawned++));
      const index = next(live.length);
      const queue = live[index] as Event[];
      const event = queue.shift() as Event;
      if (queue.length === 0) live.splice(index, 1);
      state = reduce(state, event).state;
      events += 1;
      chunkEvents += 1;
      if (chunkEvents === CHUNK) {
        const seconds = (performance.now() - chunkStart) / 1000;
        curve.push({
          boxes: Object.keys(state.boxes).length,
          changes: Object.keys(state.changes).length,
          rate: CHUNK / seconds,
        });
        chunkStart = performance.now();
        chunkEvents = 0;
      }
    }
    const shipped = Object.values(state.boxes).filter((box) => box.state === 'shipped').length;
    record('throughput-large', [
      `throughput large state: ${events} events, ${spawned} tasks ordered and merged in a window of ${WINDOW}, state never reset, nothing pruned`,
      ...curve.map(
        (point, i) =>
          `chunk ${i + 1} of ${curve.length}: ${point.boxes} boxes, ${point.changes} changes, ${Math.round(point.rate)} events/s`,
      ),
      `median ${Math.round(median(curve.map((point) => point.rate)))} events/s over ${curve.length} chunks, end state ${Object.keys(state.boxes).length} boxes of which ${shipped} shipped`,
    ]);
    expect(events).toBeGreaterThanOrEqual(MIN_LARGE_EVENTS);
    expect(curve.length).toBeGreaterThanOrEqual(MIN_LARGE_CHUNKS);
    expect(shipped).toBeGreaterThan(spawned * 0.9);
  });
});
