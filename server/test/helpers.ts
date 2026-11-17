import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tempDir = (label: string): string => realpathSync(mkdtempSync(join(tmpdir(), `aw-${label}-`)));

export const folder = (root: string, name: string): string => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

export const human = {
  order: (task: string, shipment: { id: string; size: number } | null = { id: 's1', size: 1 }) => ({
    source: 'human',
    kind: 'order',
    task,
    shipment,
  }),
  hire: (task: string, worker: string) => ({ source: 'human', kind: 'hire', task, worker }),
  addWorker: (worker: string) => ({ source: 'human', kind: 'add_worker', worker }),
};

export const change = (over: Record<string, unknown> = {}) => ({
  source: 'webhook',
  kind: 'change',
  repo: 'acme/app',
  headRepo: 'acme/app',
  number: 1,
  branch: 'aw/acme/t1',
  author: 'nova',
  state: 'open',
  headSha: 'a1',
  at: 100,
  ...over,
});

export const check = (over: Record<string, unknown> = {}) => ({
  source: 'webhook',
  kind: 'check',
  repo: 'acme/app',
  headSha: 'a1',
  name: 'ci',
  state: 'success',
  at: 110,
  ...over,
});
