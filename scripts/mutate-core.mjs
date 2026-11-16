import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MUTANTS } from './core-mutants.mjs';

const ROOT = join(import.meta.dirname, '..');
const SOURCE = readFileSync(join(ROOT, 'packages/core/src/lifecycle.ts'), 'utf8');
const ORACLE = readFileSync(join(ROOT, 'packages/core/test/oracle.ts'), 'utf8');
const SUITE = ['packages/core/test/lifecycle.invariants.test.ts', 'packages/core/test/lifecycle.convergence.test.ts'];
const DEFAULT_SEEDS = ['20261117', '1', '424242', '987654321'];

/** @param {string} source @param {import('./core-mutants.mjs').Edit[]} edits */
function apply(source, edits) {
  let text = source;
  for (const [rawFrom, rawTo] of edits) {
    const from = rawFrom.replaceAll('%{', '$' + '{');
    const to = rawTo.replaceAll('%{', '$' + '{');
    if (!text.includes(from)) throw new Error(`pattern not found: ${from.slice(0, 80)}`);
    text = text.replace(from, () => to);
  }
  return text;
}

/** @param {string} file @param {string} oracle @param {string} seed @param {string} outFile */
function runSuite(file, oracle, seed, outFile) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`, ...SUITE], {
      cwd: ROOT,
      env: { ...process.env, LIFECYCLE_MODULE: file, LIFECYCLE_ORACLE: oracle, LIFECYCLE_SEED: seed },
      stdio: 'ignore',
    });
    child.on('exit', resolve);
  });
}

/** @param {string} outFile */
function failures(outFile) {
  const report = JSON.parse(readFileSync(outFile, 'utf8'));
  /** @type {{ lane: string, message: string }[]} */
  const failed = [];
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status === 'failed')
        failed.push({
          lane: test.title.slice(0, 40),
          message: (String(test.failureMessages?.[0] ?? '').split('\n')[0] ?? '').slice(0, 110),
        });
    }
  }
  return failed;
}

const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const seeds = process.argv[3] ? process.argv[3].split(',') : DEFAULT_SEEDS;
const parallel = Number(process.argv[4] ?? 6);
const dir = mkdtempSync(join(tmpdir(), 'mutants-'));
mkdirSync(join(dir, 'out'), { recursive: true });
const jobs = MUTANTS.filter((mutant) => only === null || only.includes(mutant.name));
if (process.argv.includes('--check')) {
  for (const mutant of MUTANTS) {
    apply(
      SOURCE,
      mutant.edits.filter((edit) => edit[2] !== 'O'),
    );
    apply(
      ORACLE,
      mutant.edits.filter((edit) => edit[2] === 'O'),
    );
  }
  process.stdout.write(`${MUTANTS.length} mutants, every edit applies\n`);
  process.exit(0);
}
/** @type {string[]} */
const lines = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const mutant = /** @type {(typeof jobs)[number]} */ (jobs[next++]);
    const file = join(dir, `${mutant.name}.ts`);
    const oracle = join(dir, `${mutant.name}.oracle.ts`);
    writeFileSync(
      file,
      apply(
        SOURCE,
        mutant.edits.filter((edit) => edit[2] !== 'O'),
      ),
    );
    writeFileSync(
      oracle,
      apply(
        ORACLE,
        mutant.edits.filter((edit) => edit[2] === 'O'),
      ),
    );
    /** @type {string[]} */
    const cells = [];
    for (const seed of seeds) {
      const outFile = join(dir, 'out', `${mutant.name}-${seed}.json`);
      await runSuite(file, oracle, seed, outFile);
      const failed = failures(outFile);
      cells.push(
        failed.length === 0
          ? `seed ${seed}: MISSED`
          : `seed ${seed}: CAUGHT by ${failed.map((one) => one.lane).join(' | ')} :: ${failed[0]?.message}`,
      );
    }
    lines.push(`${mutant.name}\n  ${cells.join('\n  ')}`);
    process.stdout.write(`${lines.at(-1)}\n`);
  }
}
await Promise.all(Array.from({ length: parallel }, worker));
const missed = lines.filter((line) => line.includes('MISSED')).length;
process.stdout.write(`\nmutants: ${jobs.length}, with a missed seed: ${missed}\n`);
