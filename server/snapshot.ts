import type { State } from '@agent-works/core';
import type { BlockedEntry } from './blocked.ts';
import type { ActionItem, ModeView } from './modes/cages.ts';
import type { RegistryView } from './registry.ts';
import type { CageView } from './sandbox/container.ts';
import type { OutboxEntry } from './store/store.ts';

export interface Denial {
  readonly host: string;
  readonly port: number;
  readonly agent: string;
  readonly reason: string;
  readonly at: string;
  readonly count: number;
  readonly lastAt: string;
}

export interface Snapshot {
  readonly rev: number;
  readonly pushedAt: number;
  readonly hq: { readonly pid: number; readonly startedAt: number; readonly port: number; readonly version: string };
  readonly registry: RegistryView;
  readonly state: State;
  readonly outbox: { readonly pending: number; readonly failed: readonly OutboxEntry[] };
  readonly cages: readonly CageView[];
  readonly denials: readonly Denial[];
  readonly blocked: readonly BlockedEntry[];
  readonly paused: readonly string[];
  readonly actions: readonly ActionItem[];
  readonly mode: ModeView | null;
}

export const outboxSummary = (outbox: readonly OutboxEntry[]): Snapshot['outbox'] => ({
  pending: outbox.filter((entry) => entry.status === 'pending').length,
  failed: outbox.filter((entry) => entry.status === 'failed'),
});
