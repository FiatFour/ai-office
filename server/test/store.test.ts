import { appendFileSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, type State } from '@agent-works/core';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../events.ts';
import { Ledger } from '../ledger.ts';
import { pruneSuperseded } from '../store/prune.ts';
import { Store, StoreLockedError } from '../store/store.ts';
import { change, check, human, tempDir } from './helpers.ts';

const ev = (raw: unknown) => parseEvent(raw);

const open = (dir: string) => {
  const store = Store.open(dir);
  return { store, ledger: new Ledger(store) };
};

const story = [
  human.addWorker('nova'),
  human.addWorker('reviewer'),
  human.order('acme/t1'),
  human.hire('acme/t1', 'nova'),
  change(),
  check(),
];

describe('ledger and store', () => {
  it('survives a restart with the same state, revision and no repeated commands', () => {
    const dir = tempDir('ledger-restart');
    const first = open(dir);
    for (const event of story) first.ledger.ingest(ev(event));
    const before = { state: first.ledger.state, rev: first.ledger.rev, outbox: first.ledger.outbox };
    expect(before.outbox.some((entry) => entry.command.kind === 'start_cage')).toBe(true);
    first.store.close();
    const second = open(dir);
    expect(second.ledger.state).toEqual(before.state);
    expect(second.ledger.rev).toBe(before.rev);
    expect(second.ledger.outbox).toEqual(before.outbox);
    second.store.close();
  });

  it('replays an event that reached the log but not the state file', () => {
    const dir = tempDir('ledger-crash');
    const first = open(dir);
    for (const event of story.slice(0, 4)) first.ledger.ingest(ev(event));
    const committedState = readFileSync(join(dir, 'state.json'), 'utf8');
    const lastRev = first.ledger.rev;
    first.ledger.ingest(ev(story[4]));
    first.ledger.ingest(ev(story[5]));
    const full = first.ledger.state;
    first.store.close();
    writeFileSync(join(dir, 'state.json'), committedState);
    const recovered = open(dir);
    expect(recovered.ledger.state).toEqual(full);
    expect(recovered.ledger.rev).toBe(lastRev + 2);
    const ids = recovered.ledger.outbox.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    recovered.store.close();
  });

  it('drops a torn last line and keeps every complete event', () => {
    const dir = tempDir('ledger-torn');
    const first = open(dir);
    for (const event of story.slice(0, 3)) first.ledger.ingest(ev(event));
    first.store.close();
    appendFileSync(join(dir, 'events.jsonl'), 'deadbeef\t{"seq":4,"event":{"sour');
    const second = open(dir);
    expect(second.store.events(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    second.ledger.ingest(ev(story[3]));
    expect(second.store.events(0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    second.store.close();
  });

  it('rejects a corrupted middle line instead of trusting its checksum', () => {
    const dir = tempDir('ledger-corrupt');
    const first = open(dir);
    for (const event of story.slice(0, 3)) first.ledger.ingest(ev(event));
    first.store.close();
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n');
    lines[1] = (lines[1] ?? '').replace('reviewer', 'attacker');
    writeFileSync(join(dir, 'events.jsonl'), lines.join('\n'));
    truncateSync(join(dir, 'state.json'), 0);
    const second = Store.open(dir);
    expect(second.events(0).map((e) => e.seq)).toEqual([1]);
    second.close();
  });

  it('lets one HQ own the directory', () => {
    const dir = tempDir('ledger-lock');
    const first = Store.open(dir);
    expect(() => Store.open(dir)).not.toThrow();
    first.close();
    const other = Store.open(dir);
    other.close();
    writeFileSync(join(dir, 'hq.lock'), String(process.ppid));
    expect(() => Store.open(dir)).toThrow(StoreLockedError);
  });

  it('marks a command done and keeps the revision rising', () => {
    const dir = tempDir('ledger-mark');
    const { store, ledger } = open(dir);
    for (const event of story) ledger.ingest(ev(event));
    const [entry] = ledger.pending();
    const rev = ledger.rev;
    ledger.mark(entry?.id ?? '', 'done');
    expect(ledger.rev).toBe(rev + 1);
    expect(ledger.outbox.find((e) => e.id === entry?.id)?.status).toBe('done');
    store.close();
  });

  it('prunes facts of a head that was replaced and never the live head', () => {
    const dir = tempDir('ledger-prune');
    const { store, ledger } = open(dir);
    for (const event of story) ledger.ingest(ev(event));
    expect(Object.keys(ledger.state.checks)).toEqual(['acme/app|a1']);
    ledger.ingest(ev(change({ headSha: 'b2', at: 200 })));
    expect(Object.keys(ledger.state.checks)).toEqual([]);
    ledger.ingest(ev(check({ headSha: 'b2', at: 210 })));
    expect(Object.keys(ledger.state.checks)).toEqual(['acme/app|b2']);
    ledger.ingest(ev(change({ headSha: 'c3', at: 300 })));
    expect(Object.keys(ledger.state.checks)).toEqual([]);
    store.close();
  });

  it('keeps the facts of a head that returns after it was replaced', () => {
    const dir = tempDir('ledger-return');
    const { store, ledger } = open(dir);
    for (const event of story) ledger.ingest(ev(event));
    ledger.ingest(ev(change({ headSha: 'b2', at: 200 })));
    ledger.ingest(ev(check({ headSha: 'a1', at: 250 })));
    ledger.ingest(ev(change({ headSha: 'a1', at: 300 })));
    expect(Object.keys(ledger.state.checks)).toEqual(['acme/app|a1']);
    store.close();
  });

  it('keeps facts for a head it has not seen move, so a check that arrives early survives', () => {
    const dir = tempDir('ledger-early');
    const { store, ledger } = open(dir);
    ledger.ingest(ev(check({ headSha: 'zz', at: 50 })));
    ledger.ingest(ev(change({ headSha: 'a1' })));
    expect(Object.keys(ledger.state.checks)).toContain('acme/app|zz');
    store.close();
  });

  it('pruning leaves a state that equals the unpruned one for every box and command', () => {
    const base: State = initialState({ budget: 3, approvals: 1 });
    const state: State = {
      ...base,
      checks: { 'r|old': { ci: { v: 'success', at: 1 } }, 'r|new': { ci: { v: 'success', at: 2 } } },
      reviews: { 'r#1|old': { x: { v: 'approve', at: 1 } }, 'r#1|new': { x: { v: 'approve', at: 2 } } },
      changes: {
        'r#1@aw/a/b': {
          repo: 'r',
          number: 1,
          branch: 'aw/a/b',
          author: { v: 'n' as never, at: 1 },
          head: { v: 'new', at: 2 },
          first: 1,
          at: 2,
          state: 'open',
        },
      },
    };
    const pruned = pruneSuperseded(state, new Set(['old', 'new']));
    expect(Object.keys(pruned.checks)).toEqual(['r|new']);
    expect(Object.keys(pruned.reviews)).toEqual(['r#1|new']);
    expect(pruneSuperseded(state, new Set())).toBe(state);
  });
});
