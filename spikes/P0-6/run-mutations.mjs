import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SCOPES } from './attacks.mjs';
import { flipProblems, MUTATIONS } from './mutations.mjs';
import { parseThreatModel } from './threat-table.mjs';

const REPLAY = fileURLToPath(new URL('./replay.mjs', import.meta.url));
const TABLE = fileURLToPath(new URL('../../docs/threat-model.md', import.meta.url));

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(tmpdir(), 'swarm-P0-6', 'mutations') },
    only: { type: 'string' },
  },
});
const out = String(args.out);
mkdirSync(out, { recursive: true });
const rows = parseThreatModel(readFileSync(TABLE, 'utf8'));
const ids = args.only ? String(args.only).split(',') : Object.keys(MUTATIONS);

const started = performance.now();
/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const table = ['| mutation | declared rows | flipped to FAIL | wall seconds |', '| --- | --- | --- | --- |'];
for (const id of ids) {
  const mutation = MUTATIONS[id];
  if (mutation === undefined) {
    failures.push(`${id} is not a mutation`);
    continue;
  }
  const declared = rows.filter((row) => row.mutations.includes(id)).map((row) => row.id);
  const begin = performance.now();
  const result = spawnSync(
    'node',
    [REPLAY, '--mutate', id, '--only', SCOPES[mutation.scope].join(','), '--out', join(out, id)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(join(out, `${id}.txt`), result.stdout + result.stderr);
  /** @type {Record<string, string>} */
  const statuses = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^(PASS|FAIL|NOT-RUN) (\S+) expected=/.exec(line);
    if (match) statuses[match[2] ?? ''] = match[1] ?? '';
  }
  const seconds = ((performance.now() - begin) / 1000).toFixed(1);
  const flipped = Object.entries(statuses)
    .filter(([, status]) => status === 'FAIL')
    .map(([row]) => row);
  const problems = flipProblems(id, declared, statuses);
  if (Object.keys(statuses).length === 0)
    problems.push(`${id} produced no replay rows: ${result.stderr.slice(0, 200)}`);
  console.log(
    `${problems.length === 0 ? 'OK' : 'BAD'} ${id}: flipped ${flipped.join(', ') || 'nothing'} in ${seconds} s`,
  );
  for (const problem of problems) console.log(`  ${problem}`);
  failures.push(...problems);
  table.push(`| \`${id}\` | ${declared.join(', ')} | ${flipped.join(', ')} | ${seconds} |`);
}
const wall = ((performance.now() - started) / 1000).toFixed(1);
console.log(`${ids.length} mutations, ${failures.length} problems, wall ${wall} s`);
writeFileSync(join(out, 'mutations.md'), `${table.join('\n')}\n\nwall ${wall} s\n`);
process.exit(failures.length === 0 ? 0 : 1);
