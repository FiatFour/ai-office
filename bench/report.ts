import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ArmName, type Row, totalTokens } from './model.ts';

export const THRESHOLDS = {
  minMergeRate: 0.5,
  maxWindowsPerFiveMerged: 1,
  maxHumanMinutesPerPr: 10,
  source: 'operator answer of 2026-11-19, recorded as the P2-1 thresholds in gates.md',
} as const;

export type Verdict = 'PASS' | 'FAIL' | 'UNMEASURED';

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

export const checks = (rows: readonly Row[]): Check[] => {
  const factory = rows.filter((r) => r.arm === 'factory');
  const merged = factory.filter((r) => r.outcome === 'pass');
  const rate = factory.length === 0 ? null : merged.length / factory.length;
  const windows = sum(factory, (r) => r.quotaWindows);
  const minutes = sum(factory, (r) => r.humanMinutes);
  const per5 = windows === null || merged.length === 0 ? null : (windows / merged.length) * 5;
  const perPr = minutes === null || factory.length === 0 ? null : minutes / factory.length;
  const verdict = (value: number | null, ok: (v: number) => boolean): Verdict =>
    value === null ? 'UNMEASURED' : ok(value) ? 'PASS' : 'FAIL';
  return [
    {
      name: 'Merge rate',
      value: rate === null ? 'no factory rows' : `${merged.length} of ${factory.length} (${fmt(rate * 100)}%)`,
      threshold: `at least ${THRESHOLDS.minMergeRate * 100}%`,
      verdict: verdict(rate, (v) => v >= THRESHOLDS.minMergeRate),
    },
    {
      name: 'Cost',
      value:
        per5 !== null
          ? `${fmt(per5)} five-hour windows per 5 merged PRs`
          : merged.length === 0 && factory.length > 0
            ? 'no merged PR to divide by'
            : 'quota windows not recorded',
      threshold: `at most ${THRESHOLDS.maxWindowsPerFiveMerged} five-hour window per 5 merged PRs`,
      verdict:
        merged.length === 0 && factory.length > 0
          ? 'FAIL'
          : verdict(per5, (v) => v <= THRESHOLDS.maxWindowsPerFiveMerged + 1e-9),
    },
    {
      name: 'Human minutes',
      value: perPr === null ? 'human minutes not recorded' : `${fmt(perPr)} per PR`,
      threshold: `at most ${THRESHOLDS.maxHumanMinutesPerPr} per PR`,
      verdict: verdict(perPr, (v) => v <= THRESHOLDS.maxHumanMinutesPerPr + 1e-9),
    },
  ];
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

export const renderReport = (rows: readonly Row[], date: string): string => {
  const ids = [...new Set(rows.map((r) => r.task))].sort();
  const head = [
    'task',
    'set',
    ...ARMS.flatMap((arm) => ['outcome', ...columns.map((c) => c.head)].map((h) => `${arm} ${h}`)),
  ];
  const lines = [
    `# Benchmark ${date}`,
    '',
    'Each cell with several runs reads `median (min to max)`. `n/a` means the run did not record the column. A cell that says `[k missing]` lacks k of its runs.',
    '',
    '## Thresholds',
    '',
    `Source: ${THRESHOLDS.source}.`,
    '',
    '| check | value | threshold | verdict |',
    '| --- | --- | --- | --- |',
    ...checks(rows).map((c) => `| ${c.name} | ${c.value} | ${c.threshold} | ${c.verdict} |`),
    '',
    '## Total',
    '',
    '| arm | runs | pass | wall s | tokens | windows | human min |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...ARMS.map((arm) => totalLine(arm, rows)),
    '',
    '## Per task',
    '',
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
    '',
  ];
  return lines.join('\n');
};

export const readRows = (file: string): Row[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

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
