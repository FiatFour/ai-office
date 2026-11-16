import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { Box, Command, Config, Event, State } from '../src/lifecycle.js';
import { addWorker, change, check, hire, order, review } from './events.js';
import { arbitraryEvent, configArb, isWeb, type Scenario, SEED, scenarioArb, storyArb, TASKS } from './generators.js';
import { checkProperty, record, summary, walk } from './harness.js';
import { deepFreeze } from './oracle.js';
import { initialState, reduce } from './subject.js';

vi.setConfig({ testTimeout: 600_000 });

const RUNS = { idempotent: 20_000, restart: 20_000, purity: 5_000, liveness: 5_000 };

function permute<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i % Math.max(keys.length, 1)] ?? 0, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((entry) => entry.item);
}

describe('idempotence', () => {
  it('lane 8: duplicate and reordered webhook and poll events reach the in-order end state', () => {
    const arb = fc.record({
      config: configArb,
      setup: fc.array(
        fc.oneof(
          ...TASKS.map((task) => fc.constant<Event>(order(task))),
          ...TASKS.slice(0, 4).map((task) => fc.constant<Event>(order(task, { id: 'ship-a', size: 3 }))),
          arbitraryEvent.filter((event) => event.source === 'human'),
        ),
        { maxLength: 16 },
      ),
      web: fc.oneof(
        fc.array(arbitraryEvent.filter(isWeb), { minLength: 2, maxLength: 30 }),
        storyArb.map((events) => events.filter(isWeb)),
      ),
      keys: fc.array(fc.nat(), { minLength: 1, maxLength: 60 }),
      repeats: fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 60 }),
    });
    let nontrivial = 0;
    let reordered = 0;
    let twoChangesOnABranch = 0;
    let skippedTwoMerged = 0;
    const { details, seconds } = checkProperty(
      arb,
      ({ config, setup, web, keys, repeats }) => {
        const ordered = walk(config, [...setup, ...web], undefined, { deep: false });
        const changesOfBranch = (branch: string) =>
          Object.values(ordered.state.changes).filter((one) => one.branch === branch && one.state === 'merged');
        const branches = new Set(Object.values(ordered.state.changes).map((one) => one.branch));
        if ([...branches].some((branch) => changesOfBranch(branch).length > 1)) {
          skippedTwoMerged += 1;
          return;
        }
        const noisy = permute(
          web.flatMap((event, i) => Array(1 + (repeats[i % repeats.length] ?? 0)).fill(event) as Event[]),
          keys,
        );
        const shuffled = walk(config, [...setup, ...noisy], undefined, { deep: false });
        const changes = Object.values(ordered.state.changes);
        if (changes.length > 0) nontrivial += 1;
        if (changes.some((one) => changes.some((two) => one !== two && one.branch === two.branch)))
          twoChangesOnABranch += 1;
        if (noisy.length !== web.length) reordered += 1;
        expect(shuffled.state).toStrictEqual(ordered.state);
      },
      RUNS.idempotent,
    );
    record('idempotent', [
      summary(
        'end state of duplicated and reordered webhook and poll events equals the in-order end state',
        details,
        seconds,
      ),
      `${nontrivial} of ${details.numRuns} runs built at least one change, ${twoChangesOnABranch} had two changes on one branch, ${skippedTwoMerged} skipped because two changes on one branch merged, ${reordered} added duplicates`,
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
    expect(nontrivial).toBeGreaterThan(details.numRuns / 4);
    expect(twoChangesOnABranch).toBeGreaterThan(details.numRuns / 20);
  });

  it('a duplicate delivery changes nothing and emits no command', () => {
    const { details, seconds } = checkProperty(
      scenarioArb,
      ({ config, events }) => {
        let state = initialState(config);
        for (const event of events) {
          state = reduce(state, event).state;
          if (!isWeb(event)) continue;
          const again = reduce(state, event);
          expect(again.state).toBe(state);
          expect(again.commands).toEqual([]);
        }
      },
      RUNS.idempotent,
    );
    record('idempotent-duplicate', [summary('a repeated webhook or poll event is a no-op', details, seconds)]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  });
});

describe('restart', () => {
  it('lane 9: persist the state at a random cut, reload it and continue to the uncut end state', () => {
    const arb = fc.record({ scenario: scenarioArb, cut: fc.nat() });
    let cutsInside = 0;
    const { details, seconds } = checkProperty(
      arb,
      ({ scenario, cut }) => {
        const { config, events } = scenario;
        const at = events.length === 0 ? 0 : cut % (events.length + 1);
        const uncut = walk(config, events, undefined, { deep: false });
        const head = walk(config, events.slice(0, at), undefined, { deep: false });
        const reloaded = JSON.parse(JSON.stringify(head.state)) as State;
        expect(reloaded).toStrictEqual(head.state);
        let state = reloaded;
        const tail: Command[] = [];
        for (const event of events.slice(at)) {
          const step = reduce(state, event);
          state = step.state;
          tail.push(...step.commands);
        }
        expect(state).toStrictEqual(uncut.state);
        expect([...head.commands, ...tail]).toStrictEqual(uncut.commands);
        if (at > 0 && at < events.length) cutsInside += 1;
      },
      RUNS.restart,
    );
    record('restart', [
      summary('persist, reload, continue equals the uncut run', details, seconds),
      `${cutsInside} of ${details.numRuns} cuts fell inside the sequence`,
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
    expect(cutsInside).toBeGreaterThan(details.numRuns / 2);
  });
});

describe('purity', () => {
  it('lane 13: reduce neither throws on frozen input nor changes its input', () => {
    let steps = 0;
    const { details, seconds } = checkProperty(
      scenarioArb,
      ({ config, events }) => {
        let state = initialState(config);
        for (const event of events) {
          const stateBefore = JSON.stringify(state);
          const eventBefore = JSON.stringify(event);
          const plain = reduce(state, event);
          expect(JSON.stringify(state)).toBe(stateBefore);
          expect(JSON.stringify(event)).toBe(eventBefore);
          const frozen = reduce(deepFreeze(state), deepFreeze(event));
          expect(frozen).toStrictEqual(plain);
          state = frozen.state;
          steps += 1;
        }
      },
      RUNS.purity,
    );
    record('purity', [
      summary('reduce on unfrozen and deep-frozen state and event', details, seconds),
      `${steps} reduce calls`,
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
  });
});

function drive(config: Config, events: readonly Event[]): State {
  let state = walk(config, events, undefined, { deep: false }).state;
  const feed = (event: Event) => {
    state = reduce(state, event).state;
  };
  let at = 1_000_000;
  let fresh = 0;
  for (const shipment of Object.values(state.shipments)) {
    for (let n = shipment.members.length; n < shipment.size; n += 1) {
      feed(order(`z/fill-${fresh++}`, { id: shipment.id, size: shipment.size }));
    }
  }
  const isDone = (box: Box) =>
    box.state === 'shipped' ||
    (box.state === 'cancelled' && box.reason === 'human') ||
    (box.state === 'shipping' &&
      (state.shipments[box.shipment]?.members ?? []).some((id) => {
        const member = state.boxes[id];
        return member?.state === 'cancelled' && member.reason === 'human';
      }));
  for (let round = 0; round < 40; round += 1) {
    let progressed = false;
    for (const box of Object.values(state.boxes).sort((a, b) => a.seq - b.seq)) {
      if (isDone(box)) continue;
      const builder = box.builder ?? 'zz-builder';
      if (box.state === 'belt' && box.worker === null) {
        feed(hire(box.id, builder));
        progressed = true;
        continue;
      }
      if (box.state === 'belt') continue;
      let current = state.boxes[box.id] as Box;
      if (current.state === 'building' || current.state === 'cancelled') {
        const number = 1_000_000 + at;
        feed(change(number, `aw/${box.id}`, 'open', at++, { author: builder, headSha: `z-${number}`, repo: 'z' }));
        current = state.boxes[box.id] as Box;
        progressed = true;
      }
      if (!('pr' in current)) continue;
      const target = state.changes[current.pr];
      if (target?.state !== 'open') continue;
      const head = target.head.v;
      const names = new Set(['ci', ...Object.keys(state.checks[`${target.repo}|${head}`] ?? {})]);
      for (const name of names)
        feed({ source: 'webhook', kind: 'check', repo: target.repo, headSha: head, name, state: 'success', at: at++ });
      const voters = Object.keys(state.reviews[`${target.repo}#${target.number}|${head}`] ?? {});
      for (const voter of [...voters, ...Array.from({ length: config.approvals }, (_, i) => `zz-peer-${i}`)])
        feed(review(target.number, voter, at++, 'approve', head, target.repo));
      feed(
        change(target.number, target.branch, 'merged', at++, {
          author: target.author.v,
          headSha: head,
          repo: target.repo,
        }),
      );
      progressed = true;
    }
    if (!progressed) break;
  }
  return state;
}

describe('liveness', () => {
  it('lane 14: from every reachable state some human and host events finish every box that no human cancelled', () => {
    const stuck: string[] = [];
    let nonTrivial = 0;
    const { details, seconds } = checkProperty(
      scenarioArb,
      ({ config, events }) => {
        const state = drive(config, events);
        if (Object.keys(state.boxes).length > 0) nonTrivial += 1;
        for (const box of Object.values(state.boxes)) {
          const member = (id: string) => state.boxes[id];
          const humanBlocked = (state.shipments[box.shipment]?.members ?? []).some((id) => {
            const other = member(id);
            return other?.state === 'cancelled' && other.reason === 'human';
          });
          const done =
            box.state === 'shipped' ||
            (box.state === 'cancelled' && box.reason === 'human') ||
            (box.state === 'shipping' && humanBlocked);
          if (!done) stuck.push(`${box.id} stays ${box.state}`);
        }
        expect(stuck).toEqual([]);
      },
      RUNS.liveness,
    );
    record('liveness', [
      summary('a recovery script finishes every box a human did not cancel', details, seconds),
      `${nonTrivial} of ${details.numRuns} runs had at least one box`,
      ...(stuck.length > 0 ? [`stuck: ${stuck.slice(0, 5).join('; ')}`] : []),
    ]);
    expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
    expect(nonTrivial).toBeGreaterThan(details.numRuns / 2);
  });

  it('a state that waits only on a human is not a dead end: the recovery events exist', () => {
    const state = drive({ budget: 1, approvals: 2 }, [
      addWorker('w9'),
      order('a/t1', { id: 'S', size: 2 }),
      hire('a/t1', 'w1'),
      change(1, 'aw/a/t1', 'open', 1),
      check(2),
      change(1, 'aw/a/t1', 'closed', 3),
    ]);
    expect(state.boxes['a/t1']?.state).toBe('shipped');
    expect(state.shipments.S?.state).toBe('departed');
  });
});

export type { Scenario };

void SEED;
