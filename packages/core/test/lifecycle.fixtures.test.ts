import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEvent } from '../../../spikes/P0-4/githost.mjs';
import type { Box, Command, Config, Event, HumanEvent, State } from '../src/lifecycle.js';
import { record } from './harness.js';
import { Oracle } from './oracle.js';
import { initialState, reduce } from './subject.js';

const FIXTURES = join(import.meta.dirname, '../../../spikes/P0-4/fixtures/github');

interface Recorded {
  readonly name: string;
  readonly event: string;
  readonly body: unknown;
}

const dig = (body: unknown, path: string): string => {
  let value = body;
  for (const key of path.split('.')) value = (value as Record<string, unknown>)[key];
  return String(value);
};

interface PullRequestBody {
  action: string;
  pull_request: { state: string; merged: boolean; updated_at: string; head: { sha: string } };
}

const asPullRequest = (fixture: Recorded) => fixture.body as PullRequestBody;

const loadFixture = (name: string): Recorded => {
  const file = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    event: string;
    body: unknown;
  };
  return { name, event: file.event, body: structuredClone(file.body) };
};

const VERDICT_OF: Record<string, 'approve' | 'changes' | 'comment'> = {
  approved: 'approve',
  changes_requested: 'changes',
  commented: 'comment',
};

function toLifecycleEvent(fixture: Recorded): Event | null {
  const parsed = parseEvent('github', fixture.event, fixture.body);
  if (parsed === null) return null;
  const at = (iso: string) => Date.parse(iso);
  if (parsed.kind === 'change') {
    return {
      source: 'webhook',
      kind: 'change',
      repo: parsed.repo,
      headRepo: dig(fixture.body, 'pull_request.head.repo.full_name'),
      number: parsed.number,
      branch: parsed.branch,
      author: dig(fixture.body, 'pull_request.user.login'),
      state: parsed.state,
      headSha: parsed.headSha,
      at: at(dig(fixture.body, 'pull_request.updated_at')),
    };
  }
  if (parsed.kind === 'review') {
    return {
      source: 'webhook',
      kind: 'review',
      repo: parsed.repo,
      number: parsed.number,
      reviewer: dig(fixture.body, 'review.user.login'),
      verdict: VERDICT_OF[parsed.verdict] ?? 'comment',
      headSha: dig(fixture.body, 'review.commit_id'),
      at: at(dig(fixture.body, 'review.submitted_at')),
    };
  }
  if (parsed.kind === 'check') {
    const stamp =
      fixture.event === 'check_run' ? dig(fixture.body, 'check_run.completed_at') : dig(fixture.body, 'updated_at');
    return {
      source: 'webhook',
      kind: 'check',
      repo: parsed.repo,
      headSha: parsed.headSha,
      name: parsed.name,
      state: parsed.state,
      at: at(stamp),
    };
  }
  return null;
}

type Provenance = 'recorded' | 'synthetic';
interface LogStep {
  readonly from: Provenance;
  readonly label: string;
  readonly event: Event | null;
}

function replay(config: Config, steps: readonly LogStep[]) {
  let state = initialState(config);
  const oracle = new Oracle(config);
  const problems: { invariant: string; detail: string }[] = [];
  const lines: string[] = [];
  const trace: { state: State; commands: readonly Command[] }[] = [];
  for (const step of steps) {
    if (step.event === null) {
      lines.push(`${step.from.padEnd(9)} ${step.label} -> no lifecycle event (dropped on purpose)`);
      trace.push({ state, commands: [] });
      continue;
    }
    const before = state;
    const next = reduce(state, step.event);
    state = next.state;
    problems.push(...oracle.step(step.event, before, state, next.commands));
    trace.push(next);
    const boxes =
      Object.values(state.boxes)
        .map((box: Box) => `${box.id}=${box.state}`)
        .join(' ') || '(no boxes)';
    const cmds =
      next.commands
        .map((command) => (command.kind === 'alert_human' ? `alert_human(${command.reason})` : command.kind))
        .join(',') || '-';
    lines.push(`${step.from.padEnd(9)} ${step.label} -> ${boxes} | commands: ${cmds}`);
  }
  return { state, lines, trace, problems };
}

type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;

const human = (event: WithoutSource<HumanEvent>): Event => ({ source: 'human', ...event }) as Event;

describe('replays of the P0-4 recorded GitHub fixtures', () => {
  const opened = loadFixture('pull_request-opened');
  const config: Config = { budget: 2, approvals: 1 };

  const alphaLog = (): LogStep[] => {
    const merged = structuredClone(opened);
    const body = asPullRequest(merged);
    body.action = 'closed';
    body.pull_request.state = 'closed';
    body.pull_request.merged = true;
    body.pull_request.updated_at = '2026-11-15T20:00:00Z';
    return [
      {
        from: 'synthetic',
        label: 'add_worker peer-reviewer (the scratch repo has one account)',
        event: human({ kind: 'add_worker', worker: 'peer-reviewer' }),
      },
      { from: 'synthetic', label: 'order alpha/t1', event: human({ kind: 'order', task: 'alpha/t1', shipment: null }) },
      {
        from: 'synthetic',
        label: 'hire FiatFour for alpha/t1',
        event: human({ kind: 'hire', task: 'alpha/t1', worker: 'FiatFour' }),
      },
      { from: 'recorded', label: 'push.json', event: toLifecycleEvent(loadFixture('push')) },
      { from: 'recorded', label: 'pull_request-opened.json (#1, aw/alpha/t1)', event: toLifecycleEvent(opened) },
      {
        from: 'recorded',
        label: 'status.json (agent-works/spike success)',
        event: toLifecycleEvent(loadFixture('status')),
      },
      {
        from: 'recorded',
        label: 'pull_request_review.json (FiatFour, the author, commented)',
        event: toLifecycleEvent(loadFixture('pull_request_review')),
      },
      {
        from: 'recorded',
        label: 'pull_request_review_comment.json',
        event: toLifecycleEvent(loadFixture('pull_request_review_comment')),
      },
      {
        from: 'synthetic',
        label: 'peer-reviewer approves bcd3c9d',
        event: {
          source: 'webhook',
          kind: 'review',
          repo: 'FiatFour/agent-works-scratch',
          number: 1,
          reviewer: 'peer-reviewer',
          verdict: 'approve',
          headSha: asPullRequest(opened).pull_request.head.sha,
          at: Date.parse('2026-11-15T19:30:00Z'),
        },
      },
      {
        from: 'synthetic',
        label: 'pull_request-opened.json with merged=true (the real merge webhook was never recorded)',
        event: toLifecycleEvent(merged),
      },
    ];
  };

  it('lane 1: the alpha/t1 log ends with the box shipped and the change merged', () => {
    const steps = alphaLog();
    const result = replay(config, steps);
    const header = [
      'replay of spikes/P0-4/fixtures/github through the lifecycle reducer',
      'recorded steps come from the P0-4 fixtures. synthetic steps fill what the one-account scratch repo cannot produce.',
      '',
    ];
    const afterRecorded = result.trace[7];
    const box = result.state.boxes['alpha/t1'];
    const change = result.state.changes['fiatfour/agent-works-scratch#1@aw/alpha/t1'];
    record('replay-github', [
      ...header,
      ...result.lines,
      '',
      `end state: box alpha/t1 = ${box?.state}, change fiatfour/agent-works-scratch#1@aw/alpha/t1 = ${change?.state}, shipment alpha/t1 = ${result.state.shipments['alpha/t1']?.state}`,
      `PASS=${box?.state === 'shipped' && change?.state === 'merged'}`,
    ]);
    expect(afterRecorded?.state.boxes['alpha/t1']).toMatchObject({
      state: 'qc',
      reviewer: 'peer-reviewer',
      changesRequested: false,
    });
    expect(result.trace[8]?.state.boxes['alpha/t1']?.state).toBe('merge');
    expect(result.trace[8]?.commands).toContainEqual({
      kind: 'notify_ready',
      task: 'alpha/t1',
      pr: 'fiatfour/agent-works-scratch#1@aw/alpha/t1',
    });
    expect(box).toMatchObject({ state: 'shipped' });
    expect(change?.state).toBe('merged');
    expect(result.trace[9]?.commands.map((command) => command.kind)).toEqual(['close_task', 'dispatch_truck']);
    expect(result.problems).toEqual([]);
  });

  it('the recorded self-review from the author does not advance the box', () => {
    const steps = alphaLog().slice(0, 8);
    const result = replay(config, steps);
    expect(result.state.boxes['alpha/t1']?.state).toBe('qc');
    expect(Object.values(result.state.reviews).flatMap((group) => Object.keys(group))).toEqual(['fiatfour']);
    const approved = loadFixture('pull_request_review');
    (approved.body as { review: { state: string } }).review.state = 'approved';
    const selfApproved = replay(config, [
      ...steps.slice(0, 6),
      { from: 'synthetic', label: 'the recorded review with state approved', event: toLifecycleEvent(approved) },
    ]);
    expect(selfApproved.state.boxes['alpha/t1']).toMatchObject({ state: 'qc', reviewer: 'peer-reviewer' });
    expect(
      Object.values(selfApproved.state.reviews).flatMap((group) => Object.values(group).map((vote) => vote.v)),
    ).toEqual(['approve']);
    const alone = replay(config, [steps[1] as LogStep, steps[2] as LogStep, ...steps.slice(4, 8)]);
    expect(alone.state.boxes['alpha/t1']).toMatchObject({ state: 'qc', reviewer: null });
    expect(alone.trace.flatMap((step) => step.commands)).toContainEqual({
      kind: 'alert_human',
      reason: 'no_peer_reviewer',
      subject: 'alpha/t1',
    });
  });

  it('the recorded closed payload cancels the box and blocks its shipment, and the merged variant ships it', () => {
    const closed = loadFixture('pull_request-closed');
    const setup: LogStep[] = [
      { from: 'synthetic', label: 'order beta/t2', event: human({ kind: 'order', task: 'beta/t2', shipment: null }) },
      {
        from: 'synthetic',
        label: 'hire FiatFour for beta/t2',
        event: human({ kind: 'hire', task: 'beta/t2', worker: 'FiatFour' }),
      },
    ];
    const unmerged = replay(config, [
      ...setup,
      { from: 'recorded', label: 'pull_request-closed.json (#2, merged=false)', event: toLifecycleEvent(closed) },
    ]);
    expect(unmerged.state.boxes['beta/t2']).toMatchObject({ state: 'cancelled', reason: 'closed' });
    expect(unmerged.state.shipments['beta/t2']?.state).toBe('blocked');
    expect(unmerged.trace.at(-1)?.commands.map((command) => command.kind)).toEqual([
      'release_cage',
      'alert_human',
      'alert_human',
    ]);
    const mergedBody = structuredClone(closed);
    asPullRequest(mergedBody).pull_request.merged = true;
    const merged = replay(config, [
      ...setup,
      { from: 'synthetic', label: 'pull_request-closed.json with merged=true', event: toLifecycleEvent(mergedBody) },
    ]);
    expect(merged.state.boxes['beta/t2']?.state).toBe('shipped');
    record('replay-github-closed', [...unmerged.lines, ...merged.lines]);
  });

  it('a check_run from another repo is kept as a fact and moves no box', () => {
    const checkRun = loadFixture('check_run-completed');
    const result = replay(config, [
      { from: 'recorded', label: 'check_run-completed.json', event: toLifecycleEvent(checkRun) },
    ]);
    expect(Object.keys(result.state.boxes)).toEqual([]);
    expect(Object.keys(result.state.checks)).toEqual([
      `fiatfour/ai-office|${dig(checkRun.body, 'check_run.head_sha')}`,
    ]);
  });

  it('accounts for every recorded fixture', () => {
    const mapped = [
      'push',
      'pull_request-opened',
      'pull_request-closed',
      'pull_request_review',
      'pull_request_review_comment',
      'status',
      'check_run-completed',
    ];
    const dropped = mapped.filter((name) => toLifecycleEvent(loadFixture(name)) === null);
    expect(dropped.sort()).toEqual(['pull_request_review_comment', 'push']);
  });
});
