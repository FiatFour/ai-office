import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canSpawnTs, tempDir } from '../../server/test/helpers.ts';
import { readMergeState } from '../merge-state.ts';
import { type Row, TaskRefused } from '../model.ts';
import { checks, readRows, renderReport } from '../report.ts';

const row = (over: Partial<Row>): Row => ({
  task: 't1',
  set: 'A',
  arm: 'factory',
  scripted: false,
  run: 1,
  outcome: 'pass',
  reviewRounds: 1,
  wallMs: 60_000,
  agentMs: 50_000,
  prepareMs: 5_000,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
  quotaWindows: 0.1,
  humanMinutes: 5,
  note: '',
  flag: null,
  ...over,
});

const setB = (over: Partial<Row>, i = 0): Row => row({ set: 'B', task: `b${i}`, ...over });
const byName = (rows: Row[]) => Object.fromEntries(checks(rows).map((c) => [c.name, c.verdict]));
const cellOf = (rows: Row[], name: string) => checks(rows).find((c) => c.name === name)?.value;

describe('thresholds', () => {
  it('passes at exactly the thresholds and fails just past each', () => {
    const ten = (n: number, over: Partial<Row>) =>
      Array.from({ length: 10 }, (_, i) => setB({ outcome: i < n ? 'pass' : 'fail', ...over }, i));
    expect(byName(ten(5, { quotaWindows: 0.1, humanMinutes: 10 }))).toMatchObject({
      'Set B merge rate': 'PASS',
      Cost: 'PASS',
      'Human minutes': 'PASS',
    });
    expect(byName(ten(4, {}))['Set B merge rate']).toBe('FAIL');
    expect(byName(ten(5, { quotaWindows: 0.11 })).Cost).toBe('FAIL');
    expect(byName(ten(5, { humanMinutes: 10.5 }))['Human minutes']).toBe('FAIL');
  });

  it('says UNMEASURED, never PASS, when a column was not recorded', () => {
    const rows = [setB({ quotaWindows: null, humanMinutes: null }), setB({}, 2)];
    expect(byName(rows)).toMatchObject({
      'Set B merge rate': 'PASS',
      Cost: 'UNMEASURED',
      'Human minutes': 'UNMEASURED',
    });
  });

  it('fails cost when Set B has rows and nothing merged', () => {
    expect(byName([setB({ outcome: 'fail' })]).Cost).toBe('FAIL');
  });

  it('keeps the Set A hidden-test pass rate apart from the Set B merge rate', () => {
    const rows = [
      row({ outcome: 'pass' }),
      row({ task: 't2', outcome: 'fail' }),
      row({ task: 't3', arm: 'baseline', outcome: 'pass' }),
      setB({ outcome: 'fail' }),
    ];
    expect(cellOf(rows, 'Set A hidden-test pass rate')).toBe('factory 1 of 2 (50%); baseline 1 of 1 (100%)');
    expect(cellOf(rows, 'Set B merge rate')).toBe('0 of 1 (0%)');
    expect(byName(rows)).toMatchObject({ 'Set A hidden-test pass rate': 'INFO', 'Set B merge rate': 'FAIL' });
    expect(byName([row({ outcome: 'pass' })])['Set B merge rate']).toBe('UNMEASURED');
  });

  it('counts quota windows and human minutes from the Set B factory rows that produced the merges, no other set', () => {
    const merges = [1, 2, 3, 4, 5].map((i) => setB({ quotaWindows: 0.2, humanMinutes: 2 }, i));
    expect(cellOf(merges, 'Cost')).toBe('1 five-hour windows per 5 merged PRs');
    const noise = [
      row({ task: 'a1', quotaWindows: null, humanMinutes: null }),
      row({ task: 'a2', outcome: 'error', quotaWindows: 3, humanMinutes: 0 }),
      row({ task: 'a3', quotaWindows: 3, humanMinutes: 60 }),
    ];
    expect(checks([...merges, ...noise]).slice(1)).toEqual(checks(merges).slice(1));
    expect(byName([...merges, ...noise])).toMatchObject({ Cost: 'PASS', 'Human minutes': 'PASS' });
    expect(cellOf(merges, 'Human minutes')).toBe('2 per Set B PR (5 PRs)');
    expect(byName([...merges, setB({ humanMinutes: 60 }, 6)])['Human minutes']).toBe('FAIL');
  });

  it('keeps contaminated and suspect rows out of every verdict and lists them in their own section', () => {
    const merges = [1, 2, 3, 4, 5].map((i) => setB({}, i));
    const flagged = [
      row({ task: 'w', flag: 'contaminated', note: '2 server-side web requests' }),
      row({ task: 's', flag: 'suspect', outcome: 'pass', note: 'src/x.js calls process.exit' }),
      setB({ flag: 'suspect', outcome: 'pass', humanMinutes: 500, quotaWindows: 50 }, 9),
    ];
    expect(checks([...merges, ...flagged])).toEqual(checks(merges));
    const text = renderReport([...merges, ...flagged], 'd');
    const section = text.split('## Flagged rows, excluded from every verdict')[1]?.split('## Scripted')[0] ?? '';
    expect(section).toContain('| w | factory | 1 | contaminated | pass | 2 server-side web requests |');
    expect(section).toContain('| s | factory | 1 | suspect |');
    expect(text.split('## Per task, live rows')[1]?.split('## Flagged')[0]).not.toMatch(/\| (w|s) \|/);
    expect(renderReport(merges, 'd')).toContain('## Flagged rows, excluded from every verdict\n\nNone.');
  });

  it('leaves the baseline arm out of every threshold', () => {
    const rows = [setB({}), row({ set: 'B', task: 'bx', arm: 'baseline', humanMinutes: 500, quotaWindows: 50 })];
    expect(byName(rows)).toMatchObject({ Cost: 'PASS', 'Human minutes': 'PASS' });
  });

  it('shows UNMEASURED on every verdict line when only scripted rows exist, whatever they say', () => {
    const rows = [row({ scripted: true }), setB({ scripted: true }), row({ scripted: true, arm: 'baseline' })];
    expect(byName(rows)).toEqual({
      'Set A hidden-test pass rate': 'UNMEASURED',
      'Set B merge rate': 'UNMEASURED',
      'Set B baseline pass rate': 'UNMEASURED',
      Cost: 'UNMEASURED',
      'Human minutes': 'UNMEASURED',
    });
    expect(cellOf(rows, 'Set B merge rate')).toContain('only scripted or flagged rows');
  });

  it('does not let a scripted row change a live verdict', () => {
    const live = [setB({ outcome: 'fail' })];
    const mixed = [...live, setB({ scripted: true }, 2), setB({ scripted: true }, 3), row({ scripted: true })];
    expect(checks(mixed)).toEqual(checks(live));
  });
});

describe('report', () => {
  it('prints factory and baseline per task and in total, each threshold with its value', () => {
    const rows = [
      row({}),
      row({ arm: 'baseline', reviewRounds: null, outcome: 'fail', quotaWindows: null, humanMinutes: null }),
      row({ task: 't2', outcome: 'timeout' }),
      setB({}),
    ];
    const text = renderReport(rows, '2026-11-19');
    expect(text).toContain('| Set B merge rate | 1 of 1 (100%) | at least 50% | PASS |');
    expect(text).toContain(
      '| Cost | 0.50 five-hour windows per 5 merged PRs | at most 1 five-hour window per 5 merged PRs | PASS |',
    );
    expect(text).toMatch(/\| factory \| 3 \| 2 \|/);
    expect(text).toMatch(/\| baseline \| 1 \| 0 \|/);
    expect(text).toMatch(/\| t1 \| A \| pass \|/);
    expect(text).toMatch(/\| t2 \| A \| timeout \|/);
  });

  it('puts scripted rows in their own labelled section, apart from the live tables', () => {
    const text = renderReport([row({ task: 'live-1' }), row({ task: 'script-1', scripted: true })], 'd');
    const [live, scripted] = text.split('## Scripted rows, excluded from every verdict');
    expect(live).toContain('live-1');
    expect(live).not.toContain('script-1');
    expect(scripted).toContain('script-1');
    expect(renderReport([row({})], 'd')).toContain('## Scripted rows, excluded from every verdict\n\nNone.');
  });

  it('shows the spread of every column across runs of the same task', () => {
    const rows = [1, 2, 3].map((run) =>
      row({
        run,
        wallMs: run * 10_000,
        reviewRounds: run,
        tokens: { input: run, output: 0, cacheRead: 0, cacheCreation: 0 },
      }),
    );
    const text = renderReport(rows, 'd');
    expect(text).toContain('| pass, pass, pass | 2 (1 to 3) | 20 (10 to 30) |');
    expect(text).toContain('2 (1 to 3) |');
  });

  it('flags a column that some runs did not record', () => {
    const text = renderReport([row({ run: 1 }), row({ run: 2, humanMinutes: null })], 'd');
    expect(text).toContain('5 [1 missing]');
  });

  it('reports grading and prepare overhead as two numbers and applies the 60 s rule to their sum', () => {
    const rows = (prepareMs: number) => [
      row({ task: 'a', wallMs: 3_000, agentMs: 1_000, prepareMs }),
      row({ task: 'b', wallMs: 5_000, agentMs: 1_000, prepareMs }),
      row({ task: 'c', wallMs: 7_000, agentMs: 1_000, prepareMs, scripted: true }),
    ];
    expect(renderReport(rows(50_000), 'd')).toContain(
      'grading 4 s (wall minus agent), prepare 50 s (clone, archive, install, base check). The plan metric counts both, 54 s against 60 s: PASS.',
    );
    expect(renderReport(rows(58_000), 'd')).toContain('62 s against 60 s: FAIL.');
  });

  it('refuses rows written before rows carried scripted, prepareMs and flag, whichever is missing', () => {
    const dir = tempDir('bench-rows');
    for (const missing of ['scripted', 'prepareMs', 'flag'] as const) {
      const old: Partial<Row> = row({});
      delete old[missing];
      const file = join(dir, `no-${missing}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify(old)}\n`);
      expect(() => readRows(file)).toThrow(/rows from an older harness/);
    }
  });

  it.skipIf(!canSpawnTs)('runs from the command line and writes the markdown beside the rows', () => {
    const dir = tempDir('bench-report');
    const file = join(dir, '2026-11-19.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(row({}))}\n`);
    const ran = spawnSync('node', [fileURLToPath(new URL('../report.ts', import.meta.url)), file], {
      encoding: 'utf8',
    });
    expect(ran.status).toBe(0);
    expect(readFileSync(join(dir, '2026-11-19.md'), 'utf8')).toContain('# Benchmark 2026-11-19');
  });
});

describe('Set B merge state', () => {
  const task = { set: 'B', id: 'b1', repo: 'a/b', pr: 7, readyHeadSha: 'a'.repeat(40), confirmed: true } as const;
  const pull = (over = {}) => ({
    state: 'closed',
    merged: true,
    head: { sha: 'a'.repeat(40) },
    created_at: '2026-11-19T00:00:00Z',
    merged_at: '2026-11-19T00:10:00Z',
    ...over,
  });

  it('passes a PR merged at the head the factory reported', async () => {
    expect(await readMergeState(task, 4, async () => pull())).toMatchObject({
      outcome: 'pass',
      humanMinutes: 4,
      wallMs: 600_000,
      note: 'merged unchanged',
    });
  });

  it('fails a PR merged after the head moved, and one closed without a merge', async () => {
    expect((await readMergeState(task, null, async () => pull({ head: { sha: 'b'.repeat(40) } }))).outcome).toBe(
      'fail',
    );
    expect((await readMergeState(task, null, async () => pull({ merged: false, merged_at: null }))).note).toBe(
      'closed without a merge',
    );
  });

  it('refuses a PR that is still open', async () => {
    await expect(
      readMergeState(task, null, async () => pull({ state: 'open', merged: false, merged_at: null })),
    ).rejects.toBeInstanceOf(TaskRefused);
  });
});
