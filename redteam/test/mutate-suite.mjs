import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThreatModel } from '../../spikes/P0-6/threat-table.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TABLE = join(ROOT, 'docs/threat-model.md');
const MUTATIONS = ['mask-off', 'sni-off', 'network-open', 'allowlist-off', 'public-check-off'];

const requested = process.argv.slice(2);
const ids = requested.length === 0 ? MUTATIONS : requested;
const out = process.env.MUTANT_OUT ?? join(tmpdir(), 'redteam-mutate-suite');
mkdirSync(out, { recursive: true });
const rows = parseThreatModel(readFileSync(TABLE, 'utf8'));

const problems = [];
const lines = [];
for (const id of ids) {
  const declared = rows.filter((row) => row.mutations.includes(id)).map((row) => row.id);
  if (declared.length === 0) {
    problems.push(`${id} is declared by no threat-model row`);
    continue;
  }
  const result = spawnSync(
    'node',
    [
      join(ROOT, 'redteam/run.ts'),
      '--mutate',
      id,
      '--mode',
      'cages',
      '--only',
      declared.join(','),
      '--out',
      join(out, id),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  writeFileSync(join(out, `${id}.txt`), result.stdout + result.stderr);
  const failed = new Set(
    result.stdout
      .split('\n')
      .map((line) => /^FAIL cages (\S+) /.exec(line)?.[1])
      .filter(Boolean),
  );
  const missed = declared.filter((row) => !failed.has(row));
  const line = `${missed.length === 0 && result.status === 1 ? 'OK ' : 'BAD'} ${id}: the suite exited ${result.status} and turned ${[...failed].join(', ') || 'nothing'} to FAIL (declared ${declared.join(', ')})`;
  lines.push(line);
  console.log(line);
  if (result.status !== 1) problems.push(`${id}: the suite did not exit 1 with the guard off`);
  for (const row of missed) problems.push(`${id}: ${row} did not turn to FAIL with the guard off`);
}
writeFileSync(join(out, 'mutate-suite.txt'), `${lines.join('\n')}\n`);
for (const problem of problems) console.log(problem);
console.log(`${ids.length} mutations, ${problems.length} problems`);
process.exit(problems.length === 0 ? 0 : 1);
