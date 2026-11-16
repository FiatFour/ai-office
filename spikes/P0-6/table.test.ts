import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACKS, SCOPES } from './attacks.mjs';
import { flipProblems, isMutation, MUTATIONS, parseReplay } from './mutations.mjs';
import { LIVE_ROWS } from './rows-live.mjs';
import { matches, parseThreatModel, tableProblems } from './threat-table.mjs';

const MODEL = join(import.meta.dirname, '..', '..', 'docs', 'threat-model.md');
const rows = parseThreatModel(readFileSync(MODEL, 'utf8'));
const attackIds = Object.keys(ATTACKS);
const mutationIds = Object.keys(MUTATIONS);
const liveIds = Object.keys(LIVE_ROWS);
const flipsNothing = Object.entries(MUTATIONS)
  .filter(([, mutation]) => 'flipsNothing' in mutation)
  .map(([id]) => id);

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  attack: 'an attack',
  vector: 'issue',
  modes: 'C, SC',
  expect: 'L2',
  named: '',
  rating: 'stopped',
  mutations: ['mask-off'],
  note: 'a note',
  ...overrides,
});

describe('docs/threat-model.md', () => {
  it('has a row for every replay id and a replay id for every row', () => {
    expect(tableProblems(rows, attackIds, mutationIds, flipsNothing, liveIds)).toEqual([]);
  });

  it('has one row per attack path', () => {
    expect(rows.length).toBe(attackIds.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe('tableProblems', () => {
  it('fails a row with no replay id', () => {
    const problems = tableProblems([row('')], [], ['mask-off']);
    expect(problems.join('\n')).toContain('has no replay id');
  });

  it('fails a replay id that has no row', () => {
    expect(tableProblems([row('a-one')], ['a-one', 'b-two'], ['mask-off'])).toEqual([
      'replay id b-two has no row in the threat model',
    ]);
  });

  it('fails a row whose id has no attack', () => {
    expect(tableProblems([row('a-one'), row('c-three')], ['a-one'], ['mask-off']).join('\n')).toContain(
      'c-three has no attack',
    );
  });

  it('fails a repeated id, a bad rating, a bad layer and a bad mode', () => {
    const problems = tableProblems(
      [row('a-one'), row('a-one'), row('b-two', { rating: 'safe', expect: 'L9', modes: 'X' })],
      ['a-one', 'b-two'],
      ['mask-off'],
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
      ['mask-off'],
    ).join('\n');
    expect(problems).toContain('a-one is rated open but names a layer');
    expect(problems).toContain('b-two is rated stopped but names no layer');
  });
});

describe('mutations', () => {
  const problems = (overrides: Record<string, unknown>, extra: string[] = []) =>
    tableProblems([row('a-one', overrides)], ['a-one'], ['mask-off', ...extra]).join('\n');

  it('fails a stopped row that declares no mutation', () => {
    expect(problems({ mutations: [] })).toContain('a-one is rated stopped but declares no mutation that turns');
  });

  it('fails a best-effort row that names a layer and declares no mutation', () => {
    expect(problems({ rating: 'best-effort', mutations: [] })).toContain('a-one is rated best-effort');
  });

  it('lets an open row, a not-run row and a best-effort row with no layer declare none', () => {
    expect(problems({ rating: 'open', expect: 'none', mutations: [] })).toBe(
      'mutation mask-off has no row that declares it',
    );
    expect(problems({ rating: 'not-run', expect: 'none', mutations: [] })).toBe(
      'mutation mask-off has no row that declares it',
    );
    expect(problems({ rating: 'best-effort', expect: 'none', mutations: [] })).toBe(
      'mutation mask-off has no row that declares it',
    );
  });

  it('fails a mutation id the replay does not know', () => {
    expect(problems({ mutations: ['mask-off', 'nope'] })).toContain('a-one names mutation nope');
  });

  it('lets a mutation that flips nothing go undeclared', () => {
    expect(tableProblems([row('a-one')], ['a-one'], ['mask-off', 'internal-off'], ['internal-off'])).toEqual([]);
  });

  it('fails a mutation no row declares', () => {
    expect(problems({}, ['unused-switch'])).toContain('mutation unused-switch has no row that declares it');
  });
});

describe('the mutation scopes', () => {
  it('replay every row that declares a mutation', () => {
    const missing = rows.flatMap((r) =>
      r.mutations
        .filter((id) => !SCOPES[MUTATIONS[id]?.scope as keyof typeof SCOPES]?.includes(r.id))
        .map((id) => `${r.id}:${id}`),
    );
    expect(missing).toEqual([]);
  });
});

describe('flipProblems', () => {
  const ran = (status: string, observed = 'L2', detail = 'the attack got through') => ({ status, observed, detail });

  it('asks for every declared row to fail and for no other row to', () => {
    expect(flipProblems('mask-off', ['a'], { a: ran('FAIL'), b: ran('PASS') })).toEqual([]);
    expect(flipProblems('mask-off', ['a'], { a: ran('PASS') })).toEqual([
      'mask-off did not turn a to FAIL (it was PASS)',
    ]);
    expect(flipProblems('mask-off', ['a'], { a: ran('FAIL'), b: ran('FAIL') })).toEqual([
      'mask-off turned b to FAIL and the table does not declare it',
    ]);
  });

  it('accepts a row named as collateral', () => {
    expect(flipProblems('allow-example', [], { 'fw-label-spoof': ran('FAIL') })).toEqual([]);
  });

  it.each([
    ['a row that threw', ran('FAIL', '-', 'error: Error: boom | at x')],
    ['a row with no observation', ran('FAIL', '-', '')],
    ['a stopped row the replay did not run', ran('FAIL', '-', 'rated stopped but replay did not run it: no docker')],
    ['a row whose error detail comes with an observation', ran('FAIL', 'x', 'error: Error: boom')],
  ])('does not count %s as a flip', (_name, result) => {
    expect(flipProblems('mask-off', ['a'], { a: result }).join('\n')).toContain('mask-off turned a to FAIL by a crash');
  });

  it('keeps a crash on an undeclared row a problem too', () => {
    expect(flipProblems('mask-off', ['a'], { a: ran('FAIL'), b: ran('FAIL', '-', 'error: x') })).toEqual([
      'mask-off turned b to FAIL and the table does not declare it',
    ]);
  });
});

describe('parseReplay', () => {
  const stdout = [
    'MUTATION noop: a switch',
    'FAIL a-one expected=L2 observed=- rating=stopped modes=C, SC (12 ms): error: Error: boom | at x | at y',
    'FAIL b-two expected=F2a observed=connect=undefined rating=stopped modes=C, SC (10235 ms): CONNECT: status undefined',
    'PASS c-three expected=L2 observed=L2 rating=stopped modes=C (3 ms): fine (really): yes',
    'NOT-RUN d-four expected=L3 observed=- rating=stopped-live modes=C (0 ms): needs --live',
    '4 rows, 1 PASS',
  ].join('\n');

  it('reads status, observation and detail per row', () => {
    expect(parseReplay(stdout)).toEqual({
      'a-one': { status: 'FAIL', observed: '-', detail: 'error: Error: boom | at x | at y' },
      'b-two': { status: 'FAIL', observed: 'connect=undefined', detail: 'CONNECT: status undefined' },
      'c-three': { status: 'PASS', observed: 'L2', detail: 'fine (really): yes' },
      'd-four': { status: 'NOT-RUN', observed: '-', detail: 'needs --live' },
    });
  });

  it('catches the crash of a mutated row end to end', () => {
    expect(flipProblems('noop', ['a-one'], parseReplay(stdout)).join('\n')).toContain('by a crash');
  });
});

describe('isMutation', () => {
  it('accepts a mutation id and rejects a name inherited from Object', () => {
    expect(isMutation('mask-off')).toBe(true);
    expect(isMutation('constructor')).toBe(false);
    expect(isMutation('__proto__')).toBe(false);
    expect(isMutation('toString')).toBe(false);
    expect(isMutation(undefined)).toBe(false);
  });
});

describe('stopped-live rows', () => {
  it('must be a row the live replay runs', () => {
    expect(
      tableProblems([row('a-one', { rating: 'stopped-live', mutations: [] })], ['a-one'], ['mask-off'], [], []).join(
        '\n',
      ),
    ).toContain('a-one is rated stopped-live but is not a row in rows-live.mjs');
  });

  it('pass when the row is a live row', () => {
    expect(
      tableProblems(
        [row('a-one', { rating: 'stopped-live', mutations: [] })],
        ['a-one'],
        ['mask-off'],
        ['mask-off'],
        ['a-one'],
      ),
    ).toEqual([]);
  });
});

describe('parseThreatModel', () => {
  const md =
    '## Attack paths\n\n| Replay id | Attack path | Vector | Modes | Stopped by | Named | Rating | Mutation | Note |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| `a-one` | x | issue | C | `L2` | - | `stopped` | `mask-off`, `preflight-off` | n |\n|  | y | issue | C | `L2` | - | `stopped` | - | n |\n';

  it('reads the mutation cell as a list, and a dash as none', () => {
    expect(parseThreatModel(md).map((r) => r.mutations)).toEqual([['mask-off', 'preflight-off'], []]);
  });

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
