export const RATINGS = ['stopped', 'stopped-live', 'best-effort', 'open', 'not-run'];

/**
 * @typedef {{
 *   id: string, attack: string, vector: string, modes: string, expect: string, named: string, rating: string, mutations: string[], note: string,
 * }} ThreatRow
 */

const HEADER = 'Replay id';
const SECTION = /^## Attack paths\s*$/m;

/** @param {string} line */
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(' | ')
    .map((cell) => cell.trim());

/** @param {string} cell */
const mutationList = (cell) =>
  cell
    .split(',')
    .map((id) => unquote(id.trim()))
    .filter((id) => id !== '' && id !== '-');

/** @param {string} cell */
const unquote = (cell) => cell.replace(/^`|`$/g, '').trim();

/**
 * Reads the attack path table out of docs/threat-model.md. Every row is returned as written, including a missing id.
 * @param {string} markdown
 * @returns {ThreatRow[]}
 */
export const parseThreatModel = (markdown) => {
  const start = markdown.search(SECTION);
  if (start < 0) throw new Error('docs/threat-model.md has no "## Attack paths" section');
  const lines = markdown
    .slice(start)
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().startsWith('|'));
  const header = lines.findIndex((line) => line.includes(HEADER));
  if (header < 0) throw new Error(`the Attack paths table has no "${HEADER}" column`);
  const names = cells(lines[header] ?? '');
  const column = (/** @type {string} */ name) => {
    const index = names.findIndex((cell) => cell.toLowerCase().startsWith(name));
    if (index < 0) throw new Error(`the Attack paths table has no "${name}" column`);
    return index;
  };
  const at = {
    id: column('replay id'),
    attack: column('attack path'),
    vector: column('vector'),
    modes: column('modes'),
    expect: column('stopped by'),
    named: column('named'),
    rating: column('rating'),
    mutation: column('mutation'),
    note: column('note'),
  };
  return lines.slice(header + 2).map((line) => {
    const row = cells(line);
    const get = (/** @type {number} */ index) => row[index] ?? '';
    return {
      id: unquote(get(at.id)),
      attack: get(at.attack),
      vector: get(at.vector),
      modes: get(at.modes),
      expect: unquote(get(at.expect)),
      named: get(at.named),
      rating: unquote(get(at.rating)),
      mutations: mutationList(get(at.mutation)),
      note: get(at.note),
    };
  });
};

/**
 * `none` means no layer stops it, `A+B` needs exactly those layers, `A/B` accepts any non-empty subset of them.
 * @param {string} expect
 * @param {string[]} observed
 */
export const matches = (expect, observed) => {
  const seen = new Set(observed);
  if (expect === 'none') return seen.size === 0;
  if (expect.includes('/')) {
    const allowed = new Set(expect.split('/'));
    return seen.size > 0 && [...seen].every((layer) => allowed.has(layer));
  }
  const wanted = new Set(expect.split('+'));
  return wanted.size === seen.size && [...wanted].every((layer) => seen.has(layer));
};

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MODES = new Set(['C', 'SC', 'SL']);
const LAYER = /^(L[1-5]|PF|MS|GS|HG|WH|CG|F[1-5][a-z]?|W[1-3])$/;

/**
 * What is wrong with the table, as one sentence per problem. An empty list means every row has one replay id, every id
 * has a row, every `stopped` row (and every `best-effort` row that names a layer) declares the mutation that turns its
 * mechanism off, every mutation is declared by a row, and every cell the replay reads is well formed.
 * @param {ThreatRow[]} rows
 * @param {string[]} attackIds the ids `attacks.mjs` can replay
 * @param {string[]} mutationIds the ids `mutations.mjs` can apply
 * @param {string[]} [undeclared] ids that no row needs to declare
 */
export const tableProblems = (rows, attackIds, mutationIds, undeclared = []) => {
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  const declared = new Set();
  rows.forEach((row, index) => {
    const name = row.id === '' ? `row ${index + 1} (${row.attack.slice(0, 40)})` : row.id;
    if (row.id === '') problems.push(`${name} has no replay id`);
    else if (!ID.test(row.id)) problems.push(`${name} has a replay id that is not kebab-case`);
    if (seen.has(row.id) && row.id !== '') problems.push(`${name} repeats a replay id`);
    seen.add(row.id);
    if (row.id !== '' && !attackIds.includes(row.id)) problems.push(`${name} has no attack in attacks.mjs`);
    if (!RATINGS.includes(row.rating))
      problems.push(`${name} has rating "${row.rating}", expected one of ${RATINGS.join(', ')}`);
    const layers = row.expect === 'none' ? [] : row.expect.split(/[+/]/);
    if (row.expect === '' || layers.some((layer) => !LAYER.test(layer))) {
      problems.push(`${name} has stopped-by "${row.expect}", expected none or layer codes joined by + or /`);
    }
    const modes = row.modes.split(',').map((mode) => mode.trim());
    if (modes.length === 0 || modes.some((mode) => !MODES.has(mode))) problems.push(`${name} has modes "${row.modes}"`);
    if (row.rating === 'open' && row.expect !== 'none') problems.push(`${name} is rated open but names a layer`);
    if (row.rating === 'stopped' && row.expect === 'none') problems.push(`${name} is rated stopped but names no layer`);
    const needsMutation = row.rating === 'stopped' || (row.rating === 'best-effort' && row.expect !== 'none');
    if (needsMutation && row.mutations.length === 0)
      problems.push(`${name} is rated ${row.rating} but declares no mutation that turns its mechanism off`);
    for (const id of row.mutations) {
      if (!mutationIds.includes(id)) problems.push(`${name} names mutation ${id}, which mutations.mjs does not define`);
      declared.add(id);
    }
    if (row.note === '') problems.push(`${name} has no note`);
  });
  for (const id of mutationIds) {
    if (!declared.has(id) && !undeclared.includes(id)) problems.push(`mutation ${id} has no row that declares it`);
  }
  for (const id of attackIds) {
    if (!seen.has(id)) problems.push(`replay id ${id} has no row in the threat model`);
  }
  return problems;
};
