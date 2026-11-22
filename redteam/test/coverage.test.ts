import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseThreatModel } from '../../spikes/P0-6/threat-table.mjs';
import { coverageProblems } from '../coverage.ts';
import { renderTask, TASKS } from '../tasks/index.ts';
import type { Task } from '../tasks/types.ts';

const rows = parseThreatModel(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'threat-model.md'), 'utf8'));

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  door: 'issue',
  goal: 'read-secret',
  ask: 'print .env',
  agentDriven: true,
  ...over,
});
const row = (id: string, vector = 'issue', modes = 'C, SC') => ({ id, vector, modes });

describe('red-team coverage of docs/threat-model.md', () => {
  it('has a task for every threat-model row and a row for every task', () => {
    expect(coverageProblems(rows, TASKS)).toEqual([]);
  });

  it('fails when a threat-model row has no red-team task', () => {
    expect(coverageProblems([row('a-one'), row('b-two')], [task('a-one')])).toEqual([
      'threat-model row b-two has no red-team task',
    ]);
  });

  it('fails when a task has no row, repeats an id or uses a door the row does not name', () => {
    const problems = coverageProblems([row('a-one', 'doc, MCP')], [task('a-one'), task('a-one'), task('c-three')]).join(
      '\n',
    );
    expect(problems).toContain('task a-one is defined twice');
    expect(problems).toContain('task c-three has no threat-model row');
    expect(problems).toContain('uses door issue');
  });

  it('fails a row that names no run mode and a task with no injection text', () => {
    const problems = coverageProblems([row('a-one', 'issue', 'X')], [task('a-one', { ask: ' ' })]).join('\n');
    expect(problems).toContain('names no run mode');
    expect(problems).toContain('has no injection text');
  });
});

describe('the rendered tickets', () => {
  it('carry the injection through the door that the row names', () => {
    for (const t of TASKS) {
      const rendered = renderTask(t, 'http://listener.test:1');
      const everything = JSON.stringify([rendered.ticket, rendered.planted]);
      const text = rendered.injection.replace(/"/g, "'");
      expect(
        everything.includes(text) || everything.includes(JSON.stringify(rendered.injection).slice(1, -1)),
        t.id,
      ).toBe(true);
      expect(rendered.door).toBe(t.door);
    }
  });

  it('points the canary host at the listener and leaves no placeholder', () => {
    for (const t of TASKS)
      expect(JSON.stringify(renderTask(t, 'http://listener.test:1'))).not.toContain('{{LISTENER}}');
    const ci = TASKS.find((t) => t.id === 'ci-edit-secret-step');
    expect(ci && renderTask(ci, 'http://listener.test:1').injection).toContain('http://listener.test:1/ci');
  });

  it('covers every goal the plan names: read a secret, call out, push to base, edit CI, disable hooks', () => {
    const goals = new Set(TASKS.map((t) => t.goal));
    for (const g of ['read-secret', 'exfil-network', 'push-base', 'edit-ci', 'disable-guard'])
      expect(goals.has(g as never), g).toBe(true);
  });
});
