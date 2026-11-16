import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newRunId } from '../P0-3/cage.mjs';
import { ATTACKS } from './attacks.mjs';
import { startCages } from './cages.mjs';
import { startLive } from './live.mjs';
import { leftOver, removeOwn, startFirewall } from './rig.mjs';
import { matches, parseThreatModel } from './threat-table.mjs';

const TABLE = fileURLToPath(new URL('../../docs/threat-model.md', import.meta.url));
const LANE_FILES = {
  2: 'issue-injection',
  3: 'doc-injection',
  4: 'postinstall',
  5: 'dns',
  6: 'push-base',
  7: 'ci-edit',
  8: 'settings-edit',
  9: 'mcp-injection',
  10: 'local-best-effort',
};

/** @param {string[]} observed */
const label = (observed) => (observed.length === 0 ? 'none' : observed.join('+'));

/** @param {() => Promise<T>} make @template T */
const once = (make) => {
  /** @type {Promise<T> | null} */
  let cached = null;
  return () => {
    cached ??= make();
    return cached;
  };
};

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(tmpdir(), 'swarm-P0-6', 'replay') },
    only: { type: 'string' },
    live: { type: 'boolean', default: false },
    'creds-volume': { type: 'string', default: 'aw-p0-3-home' },
    table: { type: 'string', default: TABLE },
    cleanup: { type: 'boolean', default: false },
  },
});
const out = String(args.out);
mkdirSync(out, { recursive: true });

if (args.cleanup) {
  const removed = removeOwn();
  console.log(
    `removed ${removed.containers} container(s) and ${removed.networks} network(s) labeled agent-works.project=p0-6-spike`,
  );
  process.exit(0);
}

if (spawnSync('docker', ['version'], { encoding: 'utf8' }).status !== 0) {
  console.error('docker is not available, and the replay rows run local docker only');
  process.exit(2);
}

const rows = parseThreatModel(readFileSync(String(args.table), 'utf8'));
const only = args.only ? new Set(String(args.only).split(',')) : null;
const runId = newRunId();
removeOwn();
let cagesStarted = false;
let liveStarted = false;
const startedCages = once(() => startCages(runId));
const startedLive = once(() => startLive({ credsVolume: String(args['creds-volume']), out }));
const ctx = {
  cages: () => {
    cagesStarted = true;
    return startedCages();
  },
  firewall: once(startFirewall),
  live: args.live
    ? () => {
        liveStarted = true;
        return startedLive();
      }
    : null,
};

/** @type {{ id: string, status: string, line: string, lane: number | null }[]} */
const results = [];
const started = performance.now();
for (const row of rows) {
  if (only && !only.has(row.id)) continue;
  const attack = ATTACKS[row.id];
  const begin = performance.now();
  let status = 'FAIL';
  let detail = '';
  let observed = '-';
  if (!attack) {
    detail = 'the table names a replay id that has no attack in attacks.mjs';
  } else {
    try {
      const outcome = /** @type {{ observed?: string[], detail?: string, notRun?: string }} */ (await attack.run(ctx));
      if (outcome.notRun !== undefined) {
        status = 'NOT-RUN';
        detail = outcome.notRun;
        if (row.rating === 'stopped') {
          status = 'FAIL';
          detail = `rated stopped but replay did not run it: ${outcome.notRun}`;
        }
      } else {
        const seen = outcome.observed ?? [];
        observed = label(seen);
        status = matches(row.expect, seen) ? 'PASS' : 'FAIL';
        detail = outcome.detail ?? '';
        if (row.rating === 'not-run') {
          status = 'FAIL';
          detail = `rated not-run but replay ran it and observed ${observed}`;
        }
      }
    } catch (error) {
      detail = `error: ${String(/** @type {Error} */ (error).stack ?? error)
        .split('\n')
        .slice(0, 3)
        .join(' | ')}`;
    }
  }
  const ms = Math.round(performance.now() - begin);
  const line = `${status} ${row.id} expected=${row.expect} observed=${observed} rating=${row.rating} modes=${row.modes} (${ms} ms): ${detail}`;
  console.log(line);
  results.push({ id: row.id, status, line, lane: attack?.lane ?? null });
}

const tableIds = new Set(rows.map((row) => row.id));
for (const id of Object.keys(ATTACKS)) {
  if (!tableIds.has(id) && !only) {
    const line = `FAIL ${id} has an attack in attacks.mjs and no row in the threat model`;
    console.log(line);
    results.push({ id, status: 'FAIL', line, lane: null });
  }
}

const liveCalls = liveStarted ? (await startedLive()).calls() : 0;
if (liveStarted) await (await startedLive()).close();

const failed = results.filter((r) => r.status === 'FAIL').length;
const notRun = results.filter((r) => r.status === 'NOT-RUN').length;
const wallSeconds = ((performance.now() - started) / 1000).toFixed(1);
if (cagesStarted) (await startedCages()).hook.close();
const removed = removeOwn();
const left = leftOver();
const clean = left.containers === '' && left.networks === '';
const summary = `${results.length} rows, ${results.length - failed - notRun} PASS, ${notRun} NOT-RUN, ${failed} FAIL, wall ${wallSeconds} s, model calls ${liveCalls}, cleanup removed ${removed.containers} container(s) ${removed.networks} network(s), left over ${clean ? 'nothing' : JSON.stringify(left)}`;
console.log(summary);

writeFileSync(join(out, 'replay-all.txt'), `${results.map((r) => r.line).join('\n')}\n${summary}\n`);
for (const [lane, file] of Object.entries(LANE_FILES)) {
  const lines = results.filter((r) => r.lane === Number(lane)).map((r) => r.line);
  if (lines.length > 0) writeFileSync(join(out, `${file}.txt`), `${lines.join('\n')}\n`);
}
writeFileSync(
  join(out, 'model-calls.txt'),
  `${liveCalls} headless claude -p calls on haiku, claude.ai subscription login, no API key\n`,
);
process.exit(failed > 0 || !clean ? 1 : 0);
