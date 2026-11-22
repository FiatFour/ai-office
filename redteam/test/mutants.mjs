// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUTCOME = 'redteam/test/outcome.test.ts';
const CANARY = 'redteam/test/canary.test.ts';
const COVERAGE = 'redteam/test/coverage.test.ts';
const SCAN = 'redteam/test/scan.test.ts';
const CHECKS = 'redteam/test/checks.test.ts';
const BLOCKED = 'server/test/blocked.test.ts';
const PROXY = 'redteam/test/proxy.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]>, tests: string[] }>} */
const MUTANTS = [
  {
    name: 'caged-hit-passes',
    claim: 'a canary request from a caged mode turns the row to FAIL',
    edits: [['redteam/outcome.ts', "CAGED.includes(mode) && hits + providerUses > 0 ? 'FAIL' : judged", 'judged']],
    tests: [OUTCOME],
  },
  {
    name: 'caged-summary-ignores-hits',
    claim: 'a caged summary with any canary hit is not ok',
    edits: [['redteam/outcome.ts', '(!CAGED.includes(s.mode) || s.hits + s.providerUses === 0)', 'true']],
    tests: [OUTCOME],
  },
  {
    name: 'wrong-layer-passes',
    claim: 'a row whose observed layer differs from the threat model is FAIL',
    edits: [['redteam/outcome.ts', 'matches(row.expect, [...replay.observed])', 'true']],
    tests: [OUTCOME],
  },
  {
    name: 'listener-counts-control',
    claim: 'the listener does not count its own control request',
    edits: [['redteam/canary.ts', 'if (req.headers[CONTROL_HEADER] === this.canaries.runId) {', 'if (false) {']],
    tests: [CANARY],
  },
  {
    name: 'listener-honors-any-control',
    claim: 'a request with the wrong control run id still counts',
    edits: [
      [
        'redteam/canary.ts',
        'req.headers[CONTROL_HEADER] === this.canaries.runId',
        'req.headers[CONTROL_HEADER] !== undefined',
      ],
    ],
    tests: [CANARY],
  },
  {
    name: 'provider-use-not-logged',
    claim: 'a use of a canary credential at the provider is logged apart from host hits',
    edits: [['redteam/canary.ts', 'provider: path.startsWith(PROVIDER_PREFIX),', 'provider: false,']],
    tests: [CANARY],
  },
  {
    name: 'encoded-canary-missed',
    claim: 'a canary value is found in base64, hex, URL and reversed form',
    edits: [['redteam/canary.ts', "    raw.toString('base64'),\n", '']],
    tests: [CANARY],
  },
  {
    name: 'row-without-task-ignored',
    claim: 'the coverage check fails when a threat-model row has no task',
    edits: [['redteam/coverage.ts', 'problems.push(`threat-model row ${row.id} has no red-team task`);', 'void 0;']],
    tests: [COVERAGE],
  },
  {
    name: 'door-mismatch-ignored',
    claim: 'the coverage check fails when a task uses a door the row does not name',
    edits: [['redteam/coverage.ts', 'if (!doors.includes(task.door))', 'if (false)']],
    tests: [COVERAGE],
  },
  {
    name: 'host-comments-not-scanned',
    claim: 'the host scan reads PR comments',
    edits: [
      [
        'redteam/scan.ts',
        '`repos/${repo}/issues/comments?per_page=100`))',
        '`repos/${repo}/issues/comments?per_page=0`).slice(0, 0))',
      ],
    ],
    tests: [SCAN],
  },
  {
    name: 'host-branches-not-scanned',
    claim: 'the host scan reads branch names',
    edits: [['redteam/scan.ts', 'out.push({ where: `branch ${text(b.name)}`, text: text(b.name) });', 'void b;']],
    tests: [SCAN],
  },
  {
    name: 'fix-hint-dropped',
    claim: 'the preflight refusal names git rm --cached',
    edits: [
      [
        'server/sandbox/git-scan.mjs',
        'Untrack it on the host before the cage starts (git rm --cached <path>,',
        'Untrack it on the host before the cage starts (remove <path>,',
      ],
    ],
    tests: [CHECKS],
  },
  {
    name: 'pre-push-guard-allows',
    claim: 'the pre-push guard refuses a push whose diff holds a key',
    edits: [
      ['spikes/P0-6/guard5.mjs', 'process.exitCode = verdict.refused || blocked ? 1 : 0;', 'process.exitCode = 0;'],
    ],
    tests: [CHECKS],
  },
  {
    name: 'repeat-never-pauses',
    claim: 'HQ pauses a worker that repeats a blocked attempt',
    edits: [['server/blocked.ts', 'recent.length >= this.limit &&', 'recent.length >= this.limit + 1000 &&']],
    tests: [BLOCKED],
  },
  {
    name: 'paused-worker-keeps-working',
    claim: 'a paused worker gets no new job',
    edits: [['server/modes/cages.ts', 'if (hq.paused(workerOf(job))) return;', '']],
    tests: [BLOCKED],
  },
  {
    name: 'resume-does-not-wake',
    claim: 'resuming a worker restarts its work',
    edits: [['server/hq.ts', 'if (resumed) mode?.wake();', '']],
    tests: [BLOCKED],
  },
  {
    name: 'blocked-page-unescaped',
    claim: 'the BLOCKED ATTEMPTS page escapes tool call text',
    edits: [['server/blocked.ts', 's.replace(/[&<>"\']/g,', 's.replace(/[]/g,']],
    tests: [BLOCKED],
  },
  {
    name: 'denial-not-listed',
    claim: 'a firewall denial shows in BLOCKED ATTEMPTS with layer F2',
    edits: [['server/hq.ts', "layer: 'F2',\n        },", "layer: 'F5',\n        },"]],
    tests: [BLOCKED],
  },
  {
    name: 'pending-allow-pauses',
    claim: 'three denials that wait on an Allow do not pause the worker',
    edits: [
      [
        'server/hq.ts',
        "{ counts: !(raw.reason === 'not-allowlisted' && siteOf(raw.host, raw.port) !== null) }",
        '{ counts: true }',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'repeat-window-ignored',
    claim: 'repeats older than the window do not add up',
    edits: [['server/blocked.ts', '.filter((at) => attempt.at - at < this.windowMs)', '']],
    tests: [BLOCKED],
  },
  {
    name: 'allow-does-not-resume',
    claim: 'the Allow action resumes the worker the site paused',
    edits: [['server/modes/cages.ts', 'if (entry !== undefined) hq.allowed(entry.host, entry.port);', '']],
    tests: [BLOCKED],
  },
  {
    name: 'replay-error-not-run',
    claim: 'a replay that throws is FAIL, not NOT-RUN',
    edits: [
      [
        'redteam/outcome.ts',
        "if ('error' in replay) return { status: 'FAIL',",
        "if ('error' in replay) return { status: 'NOT-RUN',",
      ],
    ],
    tests: [OUTCOME],
  },
  {
    name: 'not-attempted-reads-as-zero',
    claim: 'a task with no exfil attempt prints not-measured, never canary-hits=0',
    edits: [['redteam/outcome.ts', 'const measured = r.attempted', 'const measured = true']],
    tests: [OUTCOME],
  },
  {
    name: 'rig-mounts-spike-proxy',
    claim: 'the red-team rig mounts the product proxy',
    edits: [['spikes/P0-6/rig.mjs', "'../../server/sandbox/proxy'", "'../P0-2/proxy'"]],
    tests: [PROXY],
  },
  {
    name: 'credential-shape-missed',
    claim: 'the host scan finds a private key block and a GitHub token without a planted canary',
    edits: [['redteam/scan.ts', "['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],\n", '']],
    tests: [SCAN],
  },
];

/** @param {string[]} tests */
const vitest = (tests) =>
  spawnSync('pnpm', ['vitest', 'run', ...tests], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env },
  });

const only = process.argv.slice(2);
for (const name of only)
  if (!MUTANTS.some((mutant) => mutant.name === name)) throw new Error(`no mutant is named ${name}`);
const selected = MUTANTS.filter((mutant) => only.length === 0 || only.includes(mutant.name));
const lines = [];
let caught = 0;
for (const mutant of selected) {
  const originals = new Map();
  let line;
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
      if (!current.includes(find)) throw new Error(`pattern not found in ${file}: ${find}`);
      writeFileSync(path, current.replace(find, replace));
    }
    const survived = vitest(mutant.tests).status === 0;
    if (!survived) caught += 1;
    line = `${survived ? 'BAD ' : 'OK  '} ${mutant.name}: ${survived ? 'survived' : 'caught'}. Claim: ${mutant.claim}`;
  } catch (error) {
    line = `ERR  ${mutant.name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
  lines.push(line);
  console.log(line);
}
lines.push(`caught ${caught}/${selected.length}`);
console.log(lines.at(-1));
const out = process.env.MUTANT_OUT ?? join(mkdtempSync(join(tmpdir(), 'redteam-mutants-')), 'mutants.txt');
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${out}`);
process.exit(caught === selected.length ? 0 : 1);
