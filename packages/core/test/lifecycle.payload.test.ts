import { describe, expect, it } from 'vitest';
import type { Command, Event, Reducer } from '../src/lifecycle.js';
import { addWorker, change, check, hire, order, review } from './events.js';
import { walk } from './harness.js';
import { reduce } from './subject.js';

const C = { budget: 2, approvals: 1 };
const T1 = 'aw/a/t1';
const T2 = 'aw/a/t2';

const tamper =
  (edit: (command: Command, event: Event) => Command | Command[]): Reducer =>
  (state, event) => {
    const step = reduce(state, event);
    return { ...step, commands: step.commands.flatMap((command) => edit(command, event)) };
  };

const problems = (events: readonly Event[], reducer: Reducer) =>
  walk(C, events, reducer).problems.map((problem) => `${problem.invariant}: ${problem.detail}`);

describe('the oracle compares every field of every command', () => {
  const honest = [addWorker('w1'), order('a/t1'), hire('a/t1', 'w1')];

  it('accepts the unmodified reducer on the traces below', () => {
    expect(walk(C, honest, reduce).problems).toEqual([]);
  });

  it('rejects a start_cage that names another worker (R14)', () => {
    const wrong = tamper((command) =>
      command.kind === 'start_cage' ? { ...command, worker: 'nobody' as never } : command,
    );
    expect(problems(honest, wrong)).not.toEqual([]);
  });

  it('rejects a request_review that carries another change, which asks the author of one task to review it (R15)', () => {
    const wrong = tamper((command, event) =>
      command.kind === 'request_review' && event.source === 'webhook'
        ? { ...command, pr: 'r#1@aw/a/t1' as never }
        : command,
    );
    const trace = [
      addWorker('w1'),
      order('a/t1'),
      order('a/t2'),
      hire('a/t1', 'w1'),
      hire('a/t2', 'w2'),
      change(1, T1, 'open', 1, { author: 'w1', headSha: 's1' }),
      change(2, T2, 'open', 2, { author: 'w2', headSha: 's2' }),
      check(3, 's2'),
    ];
    expect(walk(C, trace, reduce).problems).toEqual([]);
    const found = problems(trace, wrong);
    expect(found.some((line) => line.includes('request_review'))).toBe(true);
  });

  it('rejects a close_task that carries another existing change (R16)', () => {
    const wrong = tamper((command) =>
      command.kind === 'close_task' ? { ...command, pr: 'r#2@aw/a/t2' as never } : command,
    );
    const events = [
      order('a/t1'),
      order('a/t2'),
      hire('a/t1', 'w1'),
      hire('a/t2', 'w2'),
      change(2, T2, 'open', 1, { author: 'w2' }),
      change(1, T1, 'open', 2),
      change(1, T1, 'merged', 3),
    ];
    expect(walk(C, events, reduce).problems).toEqual([]);
    expect(problems(events, wrong)).not.toEqual([]);
  });

  it('rejects a missing order_conflict alert for a full shipment (R17)', () => {
    const wrong = tamper((command) =>
      command.kind === 'alert_human' && command.reason === 'order_conflict' ? [] : command,
    );
    const events = [order('a/t1', { id: 'S', size: 1 }), order('a/t2', { id: 'S', size: 1 })];
    expect(walk(C, events, reduce).problems).toEqual([]);
    expect(problems(events, wrong)).not.toEqual([]);
  });

  it('rejects a missing unknown_task alert (R18)', () => {
    const wrong = tamper((command) =>
      command.kind === 'alert_human' && command.reason === 'unknown_task' ? [] : command,
    );
    expect(problems([hire('a/t9', 'w1')], wrong)).not.toEqual([]);
  });

  it('rejects an alert for a task the event never named', () => {
    const wrong = tamper((command, event) =>
      command.kind === 'alert_human' && event.source === 'human' ? { ...command, subject: 'a/t1' } : command,
    );
    expect(problems([order('a/t1'), hire('a/t9', 'w1')], wrong)).not.toEqual([]);
  });

  it('rejects an extra field on any command', () => {
    const wrong = tamper((command) =>
      command.kind === 'notify_ready' ? ({ ...command, extra: 1 } as Command) : command,
    );
    const events = [...honest, change(1, T1, 'open', 1), check(2), review(1, 'peer', 3)];
    expect(walk(C, events, reduce).problems).toEqual([]);
    expect(problems(events, wrong)).not.toEqual([]);
  });

  it('rejects a duplicated command and a dropped one', () => {
    const doubled = tamper((command) => (command.kind === 'notify_ready' ? [command, command] : command));
    const dropped = tamper((command) => (command.kind === 'notify_ready' ? [] : command));
    const events = [...honest, change(1, T1, 'open', 1), check(2), review(1, 'peer', 3)];
    expect(problems(events, doubled)).not.toEqual([]);
    expect(problems(events, dropped)).not.toEqual([]);
  });
});
