import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ArmName, type Row, totalTokens } from './model.ts';

export const THRESHOLDS = {
  minMergeRate: 0.5,
  maxWindowsPerFiveMerged: 1,
  maxHumanMinutesPerPr: 10,
  maxOverheadSeconds: 60,
  source: 'operator answer of 2026-11-19, recorded as the P2-1 thresholds in gates.md',
} as const;

export type Verdict = 'PASS' | 'FAIL' | 'UNMEASURED' | 'INFO';

export interface Check {
  readonly name: string;
  readonly value: string;
  readonly threshold: string;
  readonly verdict: Verdict;
}

const ARMS: readonly ArmName[] = ['factory', 'baseline'];

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export const cell = (values: readonly (number | null)[], scale = 1): string => {
  const known = values.filter((v): v is number => v !== null).map((v) => v / scale);
  if (known.length === 0) return 'n/a';
  const note = known.length < values.length ? ` [${values.length - known.length} missing]` : '';
  if (known.length === 1) return `${fmt(known[0] ?? 0)}${note}`;
  return `${fmt(median(known))} (${fmt(Math.min(...known))} to ${fmt(Math.max(...known))})${note}`;
};

const outcomes = (rows: readonly Row[]): string => (rows.length === 0 ? '-' : rows.map((r) => r.outcome).join(', '));

const columns: readonly { readonly head: string; readonly pick: (r: Row) => number | null; readonly scale?: number }[] =
  [
    { head: 'rounds', pick: (r) => r.reviewRounds },
    { head: 'wall s', pick: (r) => r.wallMs, scale: 1000 },
    { head: 'agent s', pick: (r) => r.agentMs, scale: 1000 },
    { head: 'tokens', pick: (r) => (r.tokens === null ? null : totalTokens(r.tokens)) },
    { head: 'windows', pick: (r) => r.quotaWindows },
    { head: 'human min', pick: (r) => r.humanMinutes },
  ];

const sum = (rows: readonly Row[], pick: (r: Row) => number | null): number | null => {
  const values = rows.map(pick);
  return values.some((v) => v === null) ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0);
};

const pct = (n: number, of: number): string => `${n} of ${of} (${fmt((n / of) * 100)}%)`;

const live = (rows: readonly Row[]): Row[] => rows.filter((r) => !r.scripted && r.flag === null);

export const checks = (all: readonly Row[]): Check[] => {
  const rows = live(all);
  const factory = rows.filter((r) => r.arm === 'factory');
  const setA = (arm: ArmName) => rows.filter((r) => r.arm === arm && r.set === 'A');
  const setB = factory.filter((r) => r.set === 'B');
  const merged = setB.filter((r) => r.outcome === 'pass');
  const windows = sum(setB, (r) => r.quotaWindows);
  const minutes = sum(setB, (r) => r.humanMinutes);
  const per5 = windows === null || merged.length === 0 ? null : (windows / merged.length) * 5;
  const perPr = minutes === null || setB.length === 0 ? null : minutes / setB.length;
  const onlyScripted = all.length > 0 && rows.length === 0;
  const none = onlyScripted ? 'only scripted or flagged rows, excluded' : 'no live rows';
  const verdict = (value: number | null, ok: (v: number) => boolean): Verdict =>
    value === null ? 'UNMEASURED' : ok(value) ? 'PASS' : 'FAIL';
  const rate = (arm: ArmName): string => {
    const mine = setA(arm);
    return mine.length === 0
      ? `${arm} no rows`
      : `${arm} ${pct(mine.filter((r) => r.outcome === 'pass').length, mine.length)}`;
  };
  const mergeRate = setB.length === 0 ? null : merged.length / setB.length;
  return [
    {
      name: 'Set A hidden-test pass rate',
      value: setA('factory').length + setA('baseline').length === 0 ? none : `${rate('factory')}; ${rate('baseline')}`,
      threshold: 'no bar set, read next to the baseline',
      verdict: setA('factory').length + setA('baseline').length === 0 ? 'UNMEASURED' : 'INFO',
    },
    {
      name: 'Set B merge rate',
      value: mergeRate === null ? (onlyScripted ? none : 'no live Set B rows') : pct(merged.length, setB.length),
      threshold: `at least ${THRESHOLDS.minMergeRate * 100}%`,
      verdict: verdict(mergeRate, (v) => v >= THRESHOLDS.minMergeRate),
    },
    {
      name: 'Cost',
      value:
        per5 !== null
          ? `${fmt(per5)} five-hour windows per 5 merged PRs`
          : setB.length > 0 && merged.length === 0
            ? 'no merged PR to divide by'
            : setB.length === 0
              ? 'no live Set B rows'
              : 'quota windows not recorded',
      threshold: `at most ${THRESHOLDS.maxWindowsPerFiveMerged} five-hour window per 5 merged PRs`,
      verdict:
        setB.length > 0 && merged.length === 0
          ? 'FAIL'
          : verdict(per5, (v) => v <= THRESHOLDS.maxWindowsPerFiveMerged + 1e-9),
    },
    {
      name: 'Human minutes',
      value:
        perPr === null
          ? setB.length === 0
            ? 'no live Set B rows'
            : 'human minutes not recorded'
          : `${fmt(perPr)} per Set B PR (${setB.length} PRs)`,
      threshold: `at most ${THRESHOLDS.maxHumanMinutesPerPr} per Set B PR`,
      verdict: verdict(perPr, (v) => v <= THRESHOLDS.maxHumanMinutesPerPr + 1e-9),
    },
  ];
};

export interface Overhead {
  readonly gradingS: number;
  readonly prepareS: number;
  readonly totalS: number;
  readonly verdict: Verdict;
}

export const overhead = (rows: readonly Row[]): Overhead | null => {
  const timed = rows.filter((r) => r.set === 'A');
  const ids = [...new Set(timed.map((r) => r.task))];
  if (ids.length === 0) return null;
  const perTask = ids.map((id) => {
    const mine = timed.filter((r) => r.task === id);
    return {
      grading: median(mine.map((r) => r.wallMs - r.agentMs)) / 1000,
      prepare: Math.max(...mine.map((r) => r.prepareMs)) / 1000,
    };
  });
  const gradingS = median(perTask.map((t) => t.grading));
  const prepareS = median(perTask.map((t) => t.prepare));
  const totalS = median(perTask.map((t) => t.grading + t.prepare));
  return { gradingS, prepareS, totalS, verdict: totalS <= THRESHOLDS.maxOverheadSeconds ? 'PASS' : 'FAIL' };
};

const totalLine = (arm: ArmName, rows: readonly Row[]): string => {
  const mine = rows.filter((r) => r.arm === arm);
  const pass = mine.filter((r) => r.outcome === 'pass').length;
  const tokens = sum(mine, (r) => (r.tokens === null ? null : totalTokens(r.tokens)));
  const wall = mine.reduce((n, r) => n + r.wallMs, 0) / 1000;
  const windows = sum(mine, (r) => r.quotaWindows);
  const minutes = sum(mine, (r) => r.humanMinutes);
  const n = (v: number | null) => (v === null ? 'n/a' : fmt(v));
  return `| ${arm} | ${mine.length} | ${pass} | ${fmt(wall)} | ${n(tokens)} | ${n(windows)} | ${n(minutes)} |`;
};

const totals = (rows: readonly Row[]): string[] => [
  '| arm | runs | pass | wall s | tokens | windows | human min |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...ARMS.map((arm) => totalLine(arm, rows)),
];

const perTask = (rows: readonly Row[]): string[] => {
  const ids = [...new Set(rows.map((r) => r.task))].sort();
  const head = [
    'task',
    'set',
    ...ARMS.flatMap((arm) => ['outcome', ...columns.map((c) => c.head)].map((h) => `${arm} ${h}`)),
  ];
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...ids.map((id) => {
      const mine = rows.filter((r) => r.task === id);
      const set = mine[0]?.set ?? '';
      const cells = ARMS.flatMap((arm) => {
        const own = mine.filter((r) => r.arm === arm);
        return [outcomes(own), ...columns.map((c) => (own.length === 0 ? '-' : cell(own.map(c.pick), c.scale)))];
      });
      return `| ${[id, set, ...cells].join(' | ')} |`;
    }),
  ];
};

export const renderReport = (rows: readonly Row[], date: string): string => {
  const measured = live(rows);
  const scripted = rows.filter((r) => r.scripted);
  const flagged = rows.filter((r) => !r.scripted && r.flag !== null);
  const spent = overhead(rows);
  return [
    `# Benchmark ${date}`,
    '',
    'Each cell with several runs reads `median (min to max)`. `n/a` means the run did not record the column. A cell that says `[k missing]` lacks k of its runs.',
    '',
    '## Thresholds',
    '',
    `Source: ${THRESHOLDS.source}. Only live, unflagged rows (a real agent or the host) count. Scripted rows are harness checks and sit in their own section. A row flagged contaminated (server-side web search or fetch) or suspect (the PR touches test machinery) is listed in its own section and counts in no verdict. The cost and human-minute checks read Set B factory rows only, the same set that produced the merges.`,
    '',
    '| check | value | threshold | verdict |',
    '| --- | --- | --- | --- |',
    ...checks(rows).map((c) => `| ${c.name} | ${c.value} | ${c.threshold} | ${c.verdict} |`),
    '',
    '## Total, live rows',
    '',
    ...totals(measured),
    '',
    '## Per task, live rows',
    '',
    ...perTask(measured),
    '',
    '## Flagged rows, excluded from every verdict',
    '',
    ...(flagged.length === 0
      ? ['None.']
      : [
          '| task | arm | run | flag | outcome | note |',
          '| --- | --- | --- | --- | --- | --- |',
          ...flagged.map((r) => `| ${r.task} | ${r.arm} | ${r.run} | ${r.flag} | ${r.outcome} | ${r.note} |`),
        ]),
    '',
    '## Scripted rows, excluded from every verdict',
    '',
    ...(scripted.length === 0 ? ['None.'] : [...totals(scripted), '', ...perTask(scripted)]),
    '',
    '## Harness overhead',
    '',
    spent === null
      ? 'No Set A rows.'
      : `Per task, median over tasks: grading ${fmt(spent.gradingS)} s (wall minus agent), prepare ${fmt(spent.prepareS)} s (clone, archive, install, base check). The plan metric counts both, ${fmt(spent.totalS)} s against ${THRESHOLDS.maxOverheadSeconds} s: ${spent.verdict}.`,
    '',
  ].join('\n');
};

export const readRows = (file: string): Row[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const parsed = JSON.parse(line) as Partial<Row>;
      if (typeof parsed.scripted !== 'boolean' || typeof parsed.prepareMs !== 'number' || parsed.flag === undefined)
        throw new Error(
          `${file} line ${i + 1} lacks scripted, prepareMs or flag: rows from an older harness, rerun them`,
        );
      return parsed as Row;
    });

const main = (argv: string[]): number => {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });
  const [input] = positionals;
  if (input === undefined) {
    console.error('usage: node bench/report.ts <rows.jsonl> [--out report.md]');
    return 2;
  }
  const date = basename(input).replace(/\.jsonl$/, '');
  const out = values.out ?? join(dirname(resolve(input)), `${date}.md`);
  const text = renderReport(readRows(input), date);
  writeFileSync(out, text);
  console.log(text);
  return 0;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
