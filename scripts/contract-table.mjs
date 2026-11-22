import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRIVERS = ['docker', 'podman', 'krun', 'github-recorded', 'github-live', 'gitlab-recorded', 'gitlab-live'];
export const OSES = ['linux', 'macos', 'windows'];

/** @typedef {{ driver: string, os: string, case: string | null, status: 'pass' | 'fail' | 'not-run', reason: string | null }} Row */

/** @param {Row[]} rows @param {{ drivers?: string[], oses?: string[] }} [want] */
export const tabulate = (rows, { drivers = DRIVERS, oses = OSES } = {}) => {
  /** @type {Map<string, Map<string, Row>>} */
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.driver}|${row.os}`;
    const cell = cells.get(key) ?? new Map();
    cell.set(row.case ?? '', row);
    cells.set(key, cell);
  }
  /** @type {string[]} */
  const problems = [];
  /** @param {string} driver @param {string} os */
  const text = (driver, os) => {
    const found = [...(cells.get(`${driver}|${os}`)?.values() ?? [])];
    if (found.length === 0) {
      problems.push(`${driver} on ${os} has no result and no reason`);
      return 'MISSING';
    }
    const failed = found.filter((r) => r.status === 'fail');
    const ran = found.filter((r) => r.status === 'pass');
    const skipped = found.filter((r) => r.status === 'not-run');
    const nameless = skipped.filter((r) => (r.reason ?? '').trim() === '');
    if (nameless.length > 0) problems.push(`${driver} on ${os} skipped ${nameless.length} without a reason`);
    if (failed.length > 0) {
      problems.push(`${driver} on ${os} failed ${failed.map((r) => r.case).join(', ')}`);
      return `FAIL ${failed.length} of ${found.length}: ${failed.map((r) => r.case).join(', ')}`;
    }
    const reasons = [...new Set(skipped.map((r) => (r.reason ?? '').trim()))].filter(Boolean);
    if (ran.length === 0) return `not run: ${reasons.join('; ') || 'NO REASON'}`;
    return skipped.length === 0
      ? `pass ${ran.length}`
      : `pass ${ran.length}, not run ${skipped.length} (${reasons.join('; ') || 'NO REASON'})`;
  };
  const table = drivers.map(
    (driver) => `| ${driver} | ${oses.map((os) => text(driver, os).replaceAll('|', '/')).join(' | ')} |`,
  );
  const markdown = [
    `| driver | ${oses.join(' | ')} |`,
    `| --- | ${oses.map(() => '---').join(' | ')} |`,
    ...table,
  ].join('\n');
  return { markdown, problems };
};

/** @param {string} dir @returns {Row[]} */
export const readRows = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, oses] = process.argv.slice(2);
  if (!dir) throw new Error('usage: contract-table.mjs <dir of .jsonl results> [os,os]');
  const { markdown, problems } = tabulate(readRows(dir), oses ? { oses: oses.split(',') } : {});
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  for (const problem of problems) console.error(`problem: ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}
