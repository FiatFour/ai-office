import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Event } from '@agent-works/core';
import { parseEvent } from '../events.ts';
import type { Mode, ModeFactory } from './cages.ts';

export interface DemoSource {
  readonly label: string;
  readonly sha256: string;
  readonly events: readonly Event[];
}

export const loadDemo = (path: string, label: string): DemoSource => {
  const bytes = readFileSync(path);
  const events = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseEvent((JSON.parse(line) as { event: unknown }).event));
  return { label, sha256: createHash('sha256').update(bytes).digest('hex'), events };
};

export const demoMode =
  (source: DemoSource, intervalMs: number): ModeFactory =>
  (hq): Mode => {
    let next = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      const event = source.events[next];
      if (event === undefined) return;
      next += 1;
      hq.ingest(event);
      timer = setTimeout(step, intervalMs);
    };
    return {
      executors: {},
      actions: () => [],
      view: () => ({ rounds: {}, usage: {}, jobs: [], reviewGap: null }),
      route: (method, path) =>
        method === 'GET' && path === '/api/demo'
          ? Promise.resolve({
              source: source.label,
              sha256: source.sha256,
              total: source.events.length,
              replayed: next,
            })
          : undefined,
      noteDenial: () => {},
      start: () => {
        timer = setTimeout(step, intervalMs);
      },
      close: async () => clearTimeout(timer),
    };
  };
