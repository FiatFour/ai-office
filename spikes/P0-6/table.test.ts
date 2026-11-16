import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACKS } from './attacks.mjs';
import { matches, parseThreatModel, tableProblems } from './threat-table.mjs';

const MODEL = join(import.meta.dirname, '..', '..', 'docs', 'threat-model.md');
const rows = parseThreatModel(readFileSync(MODEL, 'utf8'));
const attackIds = Object.keys(ATTACKS);

const row = (id: string, overrides: Record<string, string> = {}) => ({
  id,
  attack: 'an attack',
  vector: 'issue',
  modes: 'C, SC',
  expect: 'L2',
  named: '',
  rating: 'stopped',
  note: 'a note',
  ...overrides,
});

describe('docs/threat-model.md', () => {
  it('has a row for every replay id and a replay id for every row', () => {
    expect(tableProblems(rows, attackIds)).toEqual([]);
  });

  it('has one row per attack path', () => {
    expect(rows.length).toBe(attackIds.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe('tableProblems', () => {
  it('fails a row with no replay id', () => {
    const problems = tableProblems([row('')], []);
    expect(problems.join('\n')).toContain('has no replay id');
  });

  it('fails a replay id that has no row', () => {
    expect(tableProblems([row('a-one')], ['a-one', 'b-two'])).toEqual([
      'replay id b-two has no row in the threat model',
    ]);
  });

  it('fails a row whose id has no attack', () => {
    expect(tableProblems([row('a-one'), row('c-three')], ['a-one']).join('\n')).toContain('c-three has no attack');
  });

  it('fails a repeated id, a bad rating, a bad layer and a bad mode', () => {
    const problems = tableProblems(
      [row('a-one'), row('a-one'), row('b-two', { rating: 'safe', expect: 'L9', modes: 'X' })],
      ['a-one', 'b-two'],
    ).join('\n');
    expect(problems).toContain('repeats a replay id');
    expect(problems).toContain('rating "safe"');
    expect(problems).toContain('stopped-by "L9"');
    expect(problems).toContain('modes "X"');
  });

  it('fails an open row that names a layer and a stopped row that names none', () => {
    const problems = tableProblems(
      [row('a-one', { rating: 'open' }), row('b-two', { rating: 'stopped', expect: 'none' })],
      ['a-one', 'b-two'],
    ).join('\n');
    expect(problems).toContain('a-one is rated open but names a layer');
    expect(problems).toContain('b-two is rated stopped but names no layer');
  });
});

describe('parseThreatModel', () => {
  const md =
    '## Attack paths\n\n| Replay id | Attack path | Vector | Modes | Stopped by | Named | Rating | Note |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| `a-one` | x | issue | C | `L2` | - | `stopped` | n |\n|  | y | issue | C | `L2` | - | `stopped` | n |\n';

  it('reads a row without an id as an empty id', () => {
    expect(parseThreatModel(md).map((r) => r.id)).toEqual(['a-one', '']);
  });

  it('throws when the section is missing', () => {
    expect(() => parseThreatModel('# nothing')).toThrow('Attack paths');
  });
});

describe('matches', () => {
  it.each([
    ['L2', ['L2'], true],
    ['L2', [], false],
    ['L2', ['L2', 'L4'], false],
    ['F1+F2', ['F2', 'F1'], true],
    ['F1+F2', ['F1'], false],
    ['L3/L4', ['L4'], true],
    ['L3/L4', ['L3', 'L4'], true],
    ['L3/L4', ['L2'], false],
    ['L3/L4', [], false],
    ['none', [], true],
    ['none', ['L4'], false],
  ])('expects %s, observed %j, matches %s', (expected, observed, result) => {
    expect(matches(expected, observed)).toBe(result);
  });
});
