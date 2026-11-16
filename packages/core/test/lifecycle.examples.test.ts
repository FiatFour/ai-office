import { describe, expect, it } from 'vitest';
import type { Box, Command } from '../src/lifecycle.js';
import { addWorker, cancel, change, check, hire, order, review, run } from './events.js';

const C = { budget: 2, approvals: 1 };
const T1 = 'aw/a/t1';
const T2 = 'aw/a/t2';

const station = (trace: ReturnType<typeof run>, task: string) => trace.state.boxes[task]?.state;
const boundNumber = (trace: ReturnType<typeof run>, task: string): number | undefined => {
  const box = trace.state.boxes[task] as Box | undefined;
  return box && 'pr' in box ? trace.state.changes[box.pr]?.number : undefined;
};
const alerts = (commands: readonly Command[], reason: string) =>
  commands.filter((command) => command.kind === 'alert_human' && command.reason === reason);
const count = (commands: readonly Command[], kind: string) =>
  commands.filter((command) => command.kind === kind).length;

describe('a second PR on one branch', () => {
  it('keeps the box on the lower PR number when #10 appears after #9 (numbers are compared as numbers)', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(9, T1, 'open', 1),
      check(2),
      review(9, 'peer', 3),
      change(10, T1, 'open', 4, { headSha: 's2' }),
    ]);
    expect(station(trace, 'a/t1')).toBe('merge');
    expect(boundNumber(trace, 'a/t1')).toBe(9);
    const [duplicate] = alerts(trace.steps.at(-1)?.commands ?? [], 'duplicate_pr');
    expect(duplicate?.kind === 'alert_human' && trace.state.changes[duplicate.subject]?.number).toBe(10);
  });

  it('ships on #9 when #9 merges after #10 was opened', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(9, T1, 'open', 1),
      change(10, T1, 'open', 2, { headSha: 's2' }),
      change(9, T1, 'merged', 3),
    ]);
    expect(station(trace, 'a/t1')).toBe('shipped');
    expect(boundNumber(trace, 'a/t1')).toBe(9);
  });
});

describe('a departed shipment is terminal', () => {
  const shipped = [order('a/t1'), hire('a/t1', 'w1'), change(9, T1, 'open', 1), change(9, T1, 'merged', 2)];

  it('does not move the box or send a second truck when a later PR on the branch opens and merges', () => {
    const trace = run(C, [
      ...shipped,
      change(10, T1, 'open', 3, { headSha: 's2' }),
      change(10, T1, 'merged', 4, { headSha: 's2' }),
    ]);
    expect(station(trace, 'a/t1')).toBe('shipped');
    expect(trace.state.shipments['a/t1']?.state).toBe('departed');
    expect(count(trace.commands, 'dispatch_truck')).toBe(1);
    expect(count(trace.commands, 'close_task')).toBe(1);
    expect(alerts(trace.commands, 'duplicate_pr').length).toBeGreaterThan(0);
  });

  it('does the same when the later PR has a lower number in another repo', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(2, T1, 'merged', 2, { repo: 'r2' }),
      change(1, T1, 'open', 3, { repo: 'r1', headSha: 's2' }),
      change(1, T1, 'merged', 4, { repo: 'r1', headSha: 's2' }),
    ]);
    expect(station(trace, 'a/t1')).toBe('shipped');
    expect(count(trace.commands, 'dispatch_truck')).toBe(1);
  });
});

describe('logins are case-insensitive', () => {
  it('does not assign or count the author when the staff login differs in case', () => {
    const trace = run(C, [
      addWorker('fiatfour'),
      order('a/t1'),
      hire('a/t1', 'FiatFour'),
      change(1, T1, 'open', 1, { author: 'FiatFour' }),
      check(2),
      review(1, 'fiatfour', 3),
    ]);
    expect(trace.state.boxes['a/t1']).toMatchObject({ state: 'qc', reviewer: null });
    expect(alerts(trace.commands, 'no_peer_reviewer')).toHaveLength(1);
  });

  it('counts a peer approval whatever the case of the reviewer login', () => {
    const trace = run(C, [order('a/t1'), hire('a/t1', 'w1'), change(1, T1, 'open', 1), check(2), review(1, 'PeEr', 3)]);
    expect(station(trace, 'a/t1')).toBe('merge');
  });
});

describe('the builder never reviews', () => {
  const base = [
    addWorker('w1'),
    order('a/t1'),
    hire('a/t1', 'w1'),
    change(1, T1, 'open', 1, { author: 'w2' }),
    check(2),
  ];

  it('is not assigned as reviewer when the host author login differs from the hired worker', () => {
    const trace = run(C, base);
    expect(trace.state.boxes['a/t1']).toMatchObject({ state: 'qc', reviewer: null });
    expect(count(trace.commands, 'request_review')).toBe(0);
  });

  it('does not count the builder approval', () => {
    const trace = run(C, [...base, review(1, 'W1', 3)]);
    expect(station(trace, 'a/t1')).toBe('qc');
  });

  it('stays excluded after its session ended', () => {
    const trace = run(C, [
      ...base,
      { source: 'hook', kind: 'session_ended', task: 'a/t1', worker: 'w1' },
      review(1, 'w1', 3),
    ]);
    expect(station(trace, 'a/t1')).toBe('qc');
  });
});

describe('cage commands in one batch', () => {
  it('releases a cage before it starts the cage that takes its place', () => {
    const trace = run({ budget: 1, approvals: 1 }, [
      order('a/t1'),
      order('a/t2'),
      hire('a/t2', 'w2'),
      hire('a/t1', 'w1'),
      change(1, T2, 'open', 1, { author: 'w2' }),
    ]);
    const kinds = (trace.steps.at(-1)?.commands ?? []).map((command) => command.kind);
    expect(kinds).toEqual(['release_cage', 'start_cage']);
  });
});

describe('a PR whose head branch changes', () => {
  it('is a new change: the first box keeps its change and the move is alerted', () => {
    const trace = run(C, [
      order('a/t1'),
      order('a/t2'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      change(1, T2, 'open', 2),
    ]);
    expect(station(trace, 'a/t1')).toBe('test');
    expect(boundNumber(trace, 'a/t1')).toBe(1);
    expect(trace.state.changes[(trace.state.boxes['a/t1'] as { pr: string }).pr]?.branch).toBe(T1);
    expect(alerts(trace.commands, 'change_branch_moved')).toHaveLength(1);
  });
});

describe('a replacement PR after a close', () => {
  it('lets the box follow the open replacement and ship on it', () => {
    const trace = run(C, [
      order('a/t1', { id: 'S', size: 1 }),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      change(1, T1, 'closed', 2),
    ]);
    expect(station(trace, 'a/t1')).toBe('cancelled');
    expect(trace.state.shipments.S?.state).toBe('blocked');
    const next = run(C, [
      order('a/t1', { id: 'S', size: 1 }),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      change(1, T1, 'closed', 2),
      change(2, T1, 'open', 3, { headSha: 's2' }),
    ]);
    expect(station(next, 'a/t1')).toBe('test');
    expect(next.state.shipments.S?.state).toBe('loading');
    const merged = run(C, [
      order('a/t1', { id: 'S', size: 1 }),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      change(1, T1, 'closed', 2),
      change(2, T1, 'open', 3, { headSha: 's2' }),
      change(2, T1, 'merged', 4, { headSha: 's2' }),
    ]);
    expect(station(merged, 'a/t1')).toBe('shipped');
    expect(count(merged.commands, 'dispatch_truck')).toBe(1);
  });

  it('does not revive a box that a human cancelled', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      cancel('a/t1'),
      change(2, T1, 'open', 3, { headSha: 's2' }),
    ]);
    expect(trace.state.boxes['a/t1']).toMatchObject({ state: 'cancelled', reason: 'human' });
  });
});

describe('a fork PR', () => {
  it('never claims a task, even on an aw/ branch', () => {
    const trace = run(C, [order('a/t1'), hire('a/t1', 'w1'), change(1, T1, 'open', 1, { headRepo: 'mallory/r' })]);
    expect(station(trace, 'a/t1')).toBe('building');
    expect(Object.keys(trace.state.changes)).toEqual([]);
  });

  it('compares the head repo to the base repo without regard to case', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1, { repo: 'Org/R', headRepo: 'org/r' }),
    ]);
    expect(station(trace, 'a/t1')).toBe('test');
  });
});

describe('a human cancel', () => {
  it('cancels a box whose PR is open', () => {
    const trace = run(C, [order('a/t1'), hire('a/t1', 'w1'), change(1, T1, 'open', 1), cancel('a/t1')]);
    expect(trace.state.boxes['a/t1']).toMatchObject({ state: 'cancelled', reason: 'human' });
  });
});

describe('peer reviews', () => {
  it('lets a later approval from the same peer replace changes requested', () => {
    const trace = run(C, [
      addWorker('peer'),
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      check(2),
      review(1, 'peer', 3, 'changes'),
      review(1, 'peer', 4, 'approve'),
    ]);
    expect(station(trace, 'a/t1')).toBe('merge');
  });

  it('keeps a second peer changes request in force over a first approval', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      check(2),
      review(1, 'peer', 3, 'approve'),
      review(1, 'peer2', 4, 'changes'),
    ]);
    expect(station(trace, 'a/t1')).toBe('qc');
  });

  it('counts approvals from distinct logins only, however often one peer approves', () => {
    const trace = run({ budget: 2, approvals: 2 }, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      check(2),
      review(1, 'peer', 3),
      review(1, 'peer', 4),
    ]);
    expect(station(trace, 'a/t1')).toBe('qc');
  });

  it('ignores a review of an older head after the head moved', () => {
    const trace = run(C, [
      order('a/t1'),
      hire('a/t1', 'w1'),
      change(1, T1, 'open', 1),
      check(2),
      change(1, T1, 'open', 3, { headSha: 's2' }),
      check(4, 's2'),
      review(1, 'peer', 5, 'approve', 's1'),
    ]);
    expect(station(trace, 'a/t1')).toBe('qc');
  });
});
