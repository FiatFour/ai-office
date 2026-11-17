import type { State } from '@agent-works/core';

const heads = (state: State): Set<string> => {
  const live = new Set<string>();
  for (const change of Object.values(state.changes)) live.add(change.head.v);
  return live;
};

const keepsGroup = (key: string, superseded: ReadonlySet<string>, live: ReadonlySet<string>): boolean => {
  const sha = key.slice(key.lastIndexOf('|') + 1);
  return !superseded.has(sha) || live.has(sha);
};

const pick = <T>(groups: Readonly<Record<string, T>>, keep: (key: string) => boolean): Readonly<Record<string, T>> => {
  const kept = Object.entries(groups).filter(([key]) => keep(key));
  return kept.length === Object.keys(groups).length ? groups : Object.fromEntries(kept);
};

export const pruneSuperseded = (state: State, superseded: ReadonlySet<string>): State => {
  if (superseded.size === 0) return state;
  const live = heads(state);
  const keep = (key: string) => keepsGroup(key, superseded, live);
  const checks = pick(state.checks, keep);
  const reviews = pick(state.reviews, keep);
  return checks === state.checks && reviews === state.reviews ? state : { ...state, checks, reviews };
};

export const supersededBy = (before: State, after: State): string[] => {
  const moved: string[] = [];
  for (const [key, change] of Object.entries(before.changes)) {
    const next = after.changes[key];
    if (next !== undefined && next.head.v !== change.head.v) moved.push(change.head.v);
  }
  return moved;
};
