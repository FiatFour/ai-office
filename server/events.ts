import type { Event } from '@agent-works/core';

export class InvalidEvent extends Error {}

type Obj = Record<string, unknown>;

const str = (o: Obj, key: string): string => {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new InvalidEvent(`${key} must be a non-empty string`);
  return v;
};
const num = (o: Obj, key: string): number => {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvalidEvent(`${key} must be a finite number`);
  return v;
};
const oneOf = <T extends string>(o: Obj, key: string, allowed: readonly T[]): T => {
  const v = str(o, key);
  if (!(allowed as readonly string[]).includes(v))
    throw new InvalidEvent(`${key} must be one of ${allowed.join(', ')}`);
  return v as T;
};
const list = (o: Obj, key: string): Obj[] => {
  const v = o[key];
  if (!Array.isArray(v) || v.some((item) => item === null || typeof item !== 'object'))
    throw new InvalidEvent(`${key} must be a list of objects`);
  return v as Obj[];
};

const STATES = ['open', 'closed', 'merged'] as const;
const CHECKS = ['pending', 'success', 'failure'] as const;
const VERDICTS = ['approve', 'changes', 'comment'] as const;

const change = (o: Obj) => ({
  repo: str(o, 'repo'),
  headRepo: str(o, 'headRepo'),
  number: num(o, 'number'),
  branch: str(o, 'branch'),
  author: str(o, 'author'),
  state: oneOf(o, 'state', STATES),
  headSha: str(o, 'headSha'),
  at: num(o, 'at'),
});

export const parseEvent = (raw: unknown): Event => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidEvent('an event is an object');
  const o = raw as Obj;
  const source = oneOf(o, 'source', ['human', 'hook', 'webhook', 'poll']);
  if (source === 'human') {
    const kind = oneOf(o, 'kind', ['add_worker', 'order', 'hire', 'cancel']);
    if (kind === 'add_worker') return { source, kind, worker: str(o, 'worker') };
    if (kind === 'order') {
      const ship = o.shipment;
      if (ship === null) return { source, kind, task: str(o, 'task'), shipment: null };
      if (typeof ship !== 'object' || ship === undefined) throw new InvalidEvent('shipment must be an object or null');
      return {
        source,
        kind,
        task: str(o, 'task'),
        shipment: { id: str(ship as Obj, 'id'), size: num(ship as Obj, 'size') },
      };
    }
    if (kind === 'hire') return { source, kind, task: str(o, 'task'), worker: str(o, 'worker') };
    return { source, kind, task: str(o, 'task') };
  }
  if (source === 'hook') {
    oneOf(o, 'kind', ['session_ended']);
    return { source, kind: 'session_ended', task: str(o, 'task'), worker: str(o, 'worker') };
  }
  if (source === 'poll') {
    return {
      source,
      ...change(o),
      checks: list(o, 'checks').map((c) => ({ name: str(c, 'name'), state: oneOf(c, 'state', CHECKS) })),
      reviews: list(o, 'reviews').map((r) => ({
        reviewer: str(r, 'reviewer'),
        verdict: oneOf(r, 'verdict', VERDICTS),
      })),
    };
  }
  const kind = oneOf(o, 'kind', ['change', 'review', 'check']);
  if (kind === 'change') return { source, kind, ...change(o) };
  if (kind === 'review') {
    return {
      source,
      kind,
      repo: str(o, 'repo'),
      number: num(o, 'number'),
      reviewer: str(o, 'reviewer'),
      verdict: oneOf(o, 'verdict', VERDICTS),
      headSha: str(o, 'headSha'),
      at: num(o, 'at'),
    };
  }
  return {
    source,
    kind,
    repo: str(o, 'repo'),
    headSha: str(o, 'headSha'),
    name: str(o, 'name'),
    state: oneOf(o, 'state', CHECKS),
    at: num(o, 'at'),
  };
};
