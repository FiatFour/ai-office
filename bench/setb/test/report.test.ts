import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../server/test/helpers.ts';
import type { Row } from '../../model.ts';
import { checks, readRows, renderReport } from '../../report.ts';

const row = (over: Partial<Row>): Row => ({
  task: 'b1',
  set: 'B',
  arm: 'factory',
  scripted: false,
  run: 1,
  outcome: 'pass',
  reviewRounds: null,
  wallMs: 1000,
  agentMs: 0,
  prepareMs: 0,
  tokens: null,
  flag: null,
  quotaWindows: null,
  humanMinutes: 0,
  note: '',
  ...over,
});

const cell = (rows: Row[], name: string) => checks(rows).find((c) => c.name === name);

describe('Set B report', () => {
  it('uses inferred windows when none was measured, and says so', () => {
    const rows = [row({ inferredWindows: 0.5 }), row({ task: 'b2', inferredWindows: 0.5 })];
    expect(cell(rows, 'Cost')).toMatchObject({
      value: '2.50 five-hour windows per 5 merged PRs (inferred from tokens)',
      verdict: 'FAIL',
    });
  });

  it('prefers measured windows and does not call them inferred', () => {
    const c = cell([row({ quotaWindows: 0.1, inferredWindows: 9 })], 'Cost');
    expect(c?.value).not.toMatch(/inferred/);
    expect(c?.verdict).toBe('PASS');
  });

  it('leaves cost unmeasured when neither is recorded', () => {
    expect(cell([row({})], 'Cost')?.verdict).toBe('UNMEASURED');
  });

  it('reports operator, root and judge minutes separately and holds the threshold to the operator', () => {
    const c = cell([row({ humanMinutes: 0, rootMinutes: 30, judgeMinutes: 12 })], 'Human minutes');
    expect(c?.verdict).toBe('PASS');
    expect(c?.value).toContain('0 per Set B PR');
    expect(c?.value).toContain('root 30 min, judge 12 min');
    expect(cell([row({ humanMinutes: 11, rootMinutes: 1, judgeMinutes: 1 })], 'Human minutes')?.verdict).toBe('FAIL');
  });

  it('shows the baseline pass rate next to the factory without a bar, and never in the factory verdict', () => {
    const rows = [row({}), row({ arm: 'baseline', outcome: 'fail' }), row({ arm: 'baseline', task: 'b2' })];
    expect(cell(rows, 'Set B baseline pass rate')).toMatchObject({ verdict: 'INFO', value: '1 of 2 (50%)' });
    expect(cell(rows, 'Set B merge rate')?.value).toBe('1 of 1 (100%)');
  });

  it('emits the baseline line and the new columns only when Set B rows exist', () => {
    const a = [row({ set: 'A', task: 'a1' })];
    expect(cell(a, 'Set B baseline pass rate')).toBeUndefined();
    expect(renderReport(a, 'd')).not.toContain('edit lines');
    expect(cell([row({})], 'Set B baseline pass rate')).toMatchObject({ verdict: 'UNMEASURED' });
    expect(renderReport([row({})], 'd')).toContain('edit lines');
  });

  it('adds the edit, judge, root and inferred columns to the per-task table', () => {
    const md = renderReport([row({ editLines: 4, judgeMinutes: 2, rootMinutes: 3, inferredWindows: 0.25 })], 'd');
    for (const head of ['edit lines', 'judge min', 'root min', 'windows (inferred)'])
      expect(md).toContain(`factory ${head}`);
    expect(md).toMatch(/\| b1 \| B \| pass \|.* 4 \| 2 \| 3 \|/);
  });
});

describe('Set A output', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROWS = join(HERE, 'fixtures', 'both.jsonl');
  const GOLDEN = join(HERE, '..', '..', 'results', 'report-set-a.md');

  it('is byte for byte the recorded Set A report, with no Set B row, column or baseline line', () => {
    expect(`${renderReport(readRows(ROWS), 'both')}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
    const md = renderReport(readRows(ROWS), 'both');
    expect(md).not.toContain('baseline pass rate');
    expect(md).not.toContain('edit lines');
  });

  it('is what node bench/report.ts prints for those rows', () => {
    const out = join(tempDir('setb-report'), 'o.md');
    const printed = execFileSync(process.execPath, [join(HERE, '..', '..', 'report.ts'), ROWS, '--out', out], {
      encoding: 'utf8',
    });
    expect(printed).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
