import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const DEFAULT_FILES = ['docs/sources.md', 'docs/prior-art.md'].map((file) => join(REPO_ROOT, file));
const PLAN = readFileSync(join(REPO_ROOT, 'docs/plans/agent-works-plan.md'), 'utf8');
const PLAN_IDS = new Set(Array.from(PLAN.matchAll(/^## .*\((P\d-\d+)\)\s*$/gm), (match) => match[1]));
const SPIKES = ['P0-2', 'P0-3', 'P0-4', 'P0-5'];
const MIN_PRIOR_ART_PROJECTS = 3;

/** @param {string} cell */
const isLink = (cell) => /\]\(https?:\/\/[^)\s]+\)|^https?:\/\/\S+$/.test(cell);
/** @param {string} cell */
const isFilled = (cell) => !/^(|-|—|\?|n\/a|tbd|todo|unknown)$/i.test(cell);
/** @param {string} cell */
const isDate = (cell) => {
  const date = new Date(`${cell}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(cell) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(cell);
};
/** @param {string} cell */
const planIds = (cell) =>
  cell
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

/**
 * @param {(cell: string) => boolean} test
 * @param {string} problem
 * @returns {(cell: string) => string | undefined}
 */
const must = (test, problem) => (cell) => (test(cell) ? undefined : problem);

/** @param {string} cell */
const checkPlanIds = (cell) => {
  const ids = planIds(cell);
  if (ids.length === 0) return 'no plan PR id';
  const unknown = ids.filter((id) => !PLAN_IDS.has(id));
  return unknown.length > 0 ? `${unknown.join(', ')} is not a plan PR id` : undefined;
};

/**
 * @typedef {Record<string, string>} Cells
 * @typedef {{ name: string, columns: string[], cells: Record<string, (cell: string) => string | undefined>, whole: (rows: Cells[]) => string[] }} TableKind
 */

/** @type {Record<string, TableKind>} */
const TABLE_BY_FILE = {
  'sources.md': {
    name: 'source',
    columns: ['Id', 'Area', 'Fact', 'Link', 'Version checked', 'Date checked', 'Used by'],
    cells: {
      Fact: must(isFilled, 'no fact'),
      Link: must(isLink, 'no link'),
      'Version checked': must(isFilled, 'no checked version'),
      'Date checked': must(isDate, 'no check date (YYYY-MM-DD)'),
      'Used by': checkPlanIds,
    },
    whole: (rows) =>
      SPIKES.filter((spike) => !rows.some((row) => planIds(row['Used by'] ?? '').includes(spike))).map(
        (spike) => `no source row is used by ${spike}`,
      ),
  },
  'prior-art.md': {
    name: 'prior-art',
    columns: ['Id', 'Project', 'Failure mode', 'Issue', 'Handled by', 'How this design handles it'],
    cells: {
      'Failure mode': must(isFilled, 'no failure mode'),
      Issue: must(isLink, 'no issue link'),
      'Handled by': checkPlanIds,
    },
    whole: (rows) => {
      const projects = new Set(rows.map((row) => row.Project));
      return projects.size >= MIN_PRIOR_ART_PROJECTS
        ? []
        : [`prior art covers ${projects.size} projects, needs ${MIN_PRIOR_ART_PROJECTS}`];
    },
  },
};

/** @param {string | undefined} line */
const isTableLine = (line) => line?.trim().startsWith('|') ?? false;
/** @param {string | undefined} line */
const isSeparator = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line ?? '');

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
 * @returns {string[]}
 */
function checkMarkdown(text, file) {
  const kind = TABLE_BY_FILE[basename(file)];
  if (!kind) return [`${file}:1: expected a file named ${Object.keys(TABLE_BY_FILE).join(' or ')}`];
  const header = kind.columns.join(' | ');
  const lines = text.split(/\r?\n/);
  const errors = [];
  /** @type {Cells[]} */
  const rows = [];
  const ids = new Set();
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isTableLine(lines[i])) continue;
    if (!isSeparator(lines[i + 1])) {
      errors.push(`${file}:${i + 1}: table row outside a table`);
      continue;
    }
    const known = splitRow(lines[i] ?? '').join(' | ') === header;
    if (known) tables++;
    else errors.push(`${file}:${i + 1}: unknown table header, expected | ${header} |`);
    for (i += 2; isTableLine(lines[i]); i++) {
      if (!known) continue;
      const values = splitRow(lines[i] ?? '');
      const where = `${file}:${i + 1} row ${values[0] || `line ${i + 1}`}`;
      if (values.length !== kind.columns.length) {
        errors.push(`${where}: has ${values.length} cells, header has ${kind.columns.length}`);
        continue;
      }
      /** @type {Cells} */
      const cells = Object.fromEntries(kind.columns.map((column, n) => [column, values[n] ?? '']));
      if (ids.has(cells.Id)) errors.push(`${where}: duplicate id`);
      ids.add(cells.Id);
      for (const [column, check] of Object.entries(kind.cells)) {
        const problem = check(cells[column] ?? '');
        if (problem) errors.push(`${where}: ${problem}`);
      }
      rows.push(cells);
    }
  }
  if (tables === 0) return [...errors, `${file}:1: no ${kind.name} table`];
  return [...errors, ...kind.whole(rows).map((problem) => `${file}: ${problem}`)];
}

const args = process.argv.slice(2);
const files = args.length > 0 ? args : DEFAULT_FILES;
const errors = files.flatMap((file) => checkMarkdown(readFileSync(file, 'utf8'), file));
for (const error of errors) console.error(error);
if (errors.length > 0) {
  console.error(`check-sources: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`check-sources: ${files.join(', ')} ok`);
