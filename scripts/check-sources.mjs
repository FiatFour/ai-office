import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_FILES = ['docs/sources.md', 'docs/prior-art.md'];
const SPIKES = ['P0-2', 'P0-3', 'P0-4', 'P0-5'];
const MIN_PRIOR_ART_PROJECTS = 3;

/** @param {string} cell */
const isLink = (cell) => /\]\(https?:\/\/[^)\s]+\)|^https?:\/\/\S+$/.test(cell);
/** @param {string} cell */
const isFilled = (cell) => !/^(|-|—|\?|n\/a|tbd|todo)$/i.test(cell);
/** @param {string} cell */
const isDate = (cell) => /^\d{4}-\d{2}-\d{2}$/.test(cell);
/** @param {string} cell */
const isPlanId = (cell) => /\bP[0-2]-\d+\b|\bP3\b/.test(cell);

/**
 * @typedef {{ file: string, line: number, id: string, cells: Record<string, string> }} Row
 * @typedef {{ column: string, test: (cell: string) => boolean, problem: string }} CellRule
 * @typedef {{ kind: string, columns: string[], cells: CellRule[], whole: (rows: Row[]) => string[] }} TableKind
 */

/** @type {TableKind[]} */
const TABLE_KINDS = [
  {
    kind: 'source',
    columns: ['Id', 'Fact', 'Link', 'Version checked', 'Date checked', 'Used by'],
    cells: [
      { column: 'Fact', test: isFilled, problem: 'no fact' },
      { column: 'Link', test: isLink, problem: 'no link' },
      { column: 'Version checked', test: isFilled, problem: 'no checked version' },
      { column: 'Date checked', test: isDate, problem: 'no check date (YYYY-MM-DD)' },
      { column: 'Used by', test: isPlanId, problem: 'no plan PR id' },
    ],
    whole: (rows) =>
      SPIKES.filter((spike) => !rows.some((row) => row.cells['Used by']?.includes(spike))).map(
        (spike) => `no source row is used by ${spike}`,
      ),
  },
  {
    kind: 'prior-art',
    columns: ['Id', 'Project', 'Failure mode', 'Issue', 'Handled by'],
    cells: [
      { column: 'Failure mode', test: isFilled, problem: 'no failure mode' },
      { column: 'Issue', test: isLink, problem: 'no issue link' },
      { column: 'Handled by', test: isPlanId, problem: 'no plan PR id' },
    ],
    whole: (rows) => {
      const projects = new Set(rows.map((row) => row.cells.Project));
      return projects.size >= MIN_PRIOR_ART_PROJECTS
        ? []
        : [`prior art covers ${projects.size} projects, needs ${MIN_PRIOR_ART_PROJECTS}`];
    },
  },
];

/** @param {string} line */
const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

/**
 * @param {string} text
 * @param {string} file
 * @returns {Map<TableKind, Row[]>}
 */
export function parseTables(text, file) {
  const lines = text.split(/\r?\n/);
  /** @type {Map<TableKind, Row[]>} */
  const found = new Map();
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i] ?? '';
    if (!header.trim().startsWith('|') || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue;
    const columns = splitRow(header);
    const kind = TABLE_KINDS.find((k) => k.columns.every((c) => columns.includes(c)));
    let end = i + 2;
    while (end < lines.length && (lines[end] ?? '').trim().startsWith('|')) end++;
    if (kind) {
      const rows = found.get(kind) ?? [];
      for (let j = i + 2; j < end; j++) {
        const values = splitRow(lines[j] ?? '');
        /** @type {Record<string, string>} */
        const cells = Object.fromEntries(columns.map((c, n) => [c, values[n] ?? '']));
        rows.push({ file, line: j + 1, id: cells.Id || `line ${j + 1}`, cells });
      }
      if (rows.length > 0) found.set(kind, rows);
    }
    i = end - 1;
  }
  return found;
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {string[]}
 */
export function checkMarkdown(text, file) {
  const tables = parseTables(text, file);
  if (tables.size === 0) return [`${file}: no source or prior-art table found`];
  const errors = [];
  for (const [kind, rows] of tables) {
    for (const row of rows) {
      for (const rule of kind.cells) {
        if (!rule.test(row.cells[rule.column] ?? '')) {
          errors.push(`${file}:${row.line} row ${row.id}: ${rule.problem}`);
        }
      }
    }
    errors.push(...kind.whole(rows).map((problem) => `${file}: ${problem}`));
  }
  return errors;
}

/** @param {string[]} files */
function main(files) {
  const errors = files.flatMap((file) => checkMarkdown(readFileSync(file, 'utf8'), file));
  for (const error of errors) console.error(error);
  if (errors.length > 0) {
    console.error(`check-sources: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check-sources: ${files.join(', ')} ok`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  main(args.length > 0 ? args : DEFAULT_FILES);
}
