import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRIVERS = ['docker', 'podman', 'krun', 'github-recorded', 'github-live', 'gitlab-recorded', 'gitlab-live'];
export const OSES = ['linux', 'macos', 'windows'];
const STATUSES = ['pass', 'fail', 'not-run', 'expected'];

/** @typedef {{ driver: string, os: string, case: string | null, status: 'pass' | 'fail' | 'not-run' | 'expected', reason: string | null }} Row */

/** A case that cannot apply to a driver, with the reason the plan gives. */
/** @type {Record<string, string[]>} */
const NOT_APPLICABLE = { 'gitlab-recorded': ['a-github-signature-is-checked'] };

/** @param {string} driver @param {string} os */
const mustPass = (driver, os) =>
  driver === 'github-recorded' ||
  driver === 'gitlab-recorded' ||
  ((driver === 'docker' || driver === 'podman') && os === 'linux') ||
  (driver === 'docker' && os === 'windows');

/** @param {Row[]} rows @param {{ drivers?: string[], oses?: string[] }} [want] */
export const tabulate = (rows, { drivers = DRIVERS, oses = OSES } = {}) => {
  /** @type {Map<string, Row[]>} */
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.driver}|${row.os}`;
    cells.set(key, [...(cells.get(key) ?? []), row]);
  }
  /** @type {string[]} */
  const problems = [];
  for (const row of rows) {
    const what = `${row.driver} on ${row.os}${row.case === null ? '' : ` case ${row.case}`}`;
    if (!DRIVERS.includes(row.driver)) problems.push(`${what} names a driver the table does not know`);
    else if (!OSES.includes(row.os)) problems.push(`${what} names an OS the table does not know`);
    if (!STATUSES.includes(row.status))
      problems.push(`${what} has status ${JSON.stringify(row.status)}, which is not pass, fail, not-run or expected`);
  }
  /** @param {string} driver @param {string} os */
  const text = (driver, os) => {
    const where = `${driver} on ${os}`;
    const all = cells.get(`${driver}|${os}`) ?? [];
    const found = all.filter((r) => r.status !== 'expected');
    const expected = all.filter((r) => r.status === 'expected').map((r) => r.case);
    const required = mustPass(driver, os);
    if (found.length === 0) {
      problems.push(`${where} has no result and no reason`);
      return 'MISSING';
    }
    const whole = found.filter((r) => r.case === null);
    if (whole.length > 0 && required) {
      const why = whole.map((r) => (r.reason ?? '').trim()).join('; ');
      problems.push(`${where} must pass every case and was not run: ${why}`);
      return `FAIL not run: ${why}`;
    }
    const seen = new Map();
    for (const r of found) if (r.case !== null) seen.set(r.case, (seen.get(r.case) ?? 0) + 1);
    const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    if (twice.length > 0) problems.push(`${where} recorded ${twice.join(', ')} more than once`);
    if (whole.length === 0) {
      if (expected.length === 0) problems.push(`${where} has results and no list of the cases it must run`);
      const lacking = expected.filter((id) => !seen.has(id));
      if (lacking.length > 0) problems.push(`${where} never ran ${lacking.join(', ')}`);
      const extra = [...seen.keys()].filter((id) => !expected.includes(id));
      if (expected.length > 0 && extra.length > 0)
        problems.push(`${where} ran ${extra.join(', ')}, which the contract does not list`);
    }
    const failed = found.filter((r) => r.status === 'fail');
    const ran = found.filter((r) => r.status === 'pass');
    const skipped = found.filter((r) => r.status === 'not-run');
    const nameless = skipped.filter((r) => (r.reason ?? '').trim() === '');
    if (nameless.length > 0) problems.push(`${where} skipped ${nameless.length} without a reason`);
    const unexcused = skipped.filter((r) => !(NOT_APPLICABLE[driver] ?? []).includes(r.case ?? ''));
    if (required && unexcused.length > 0)
      problems.push(`${where} must pass every case and skipped ${unexcused.length}`);
    if (failed.length > 0) {
      problems.push(`${where} failed ${failed.map((r) => r.case).join(', ')}`);
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
