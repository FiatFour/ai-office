// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = 'bench/test/task-setup.test.ts';
const REPORT = 'bench/test/report.test.ts';
const CAGE = 'bench/test/cage-mount.test.ts';
const ARMS = 'bench/test/arms.test.ts';
const CLI = 'bench/test/cli.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]>, tests: string[] }>} */
const MUTANTS = [
  {
    name: 'hidden-test-stays-in-source',
    claim:
      'a hidden test file the fix adds is removed from the cage source, and setup refuses a source that still holds one',
    edits: [
      ['bench/workspace.ts', 'if (!atBase) rmSync(insideOf(source, rel), { force: true });', 'if (!atBase) void 0;'],
      ['bench/workspace.ts', 'if (twin !== undefined) problems.push(', 'if (false) problems.push('],
    ],
    tests: [SETUP, CAGE],
  },
  {
    name: 'seal-check-ignores-renamed-copy',
    claim: 'the seal check finds a hidden test by content, so a renamed copy in the cage tree is reported',
    edits: [['bench/workspace.ts', 'const twin = seen.get(digest(copy));', 'const twin = seen.get(rel);']],
    tests: [SETUP],
  },
  {
    name: 'seal-check-off',
    claim: 'setup refuses a cage source that is not sealed',
    edits: [
      ['bench/workspace.ts', 'if (problems.length > 0) throw new TaskRefused', 'if (false) throw new TaskRefused'],
    ],
    tests: [SETUP],
  },
  {
    name: 'history-allowed',
    claim: 'the cage source has one commit, so the fix commit and its history are unreachable',
    edits: [['bench/workspace.ts', "if (count !== '1') problems.push", 'if (false) problems.push']],
    tests: [SETUP],
  },
  {
    name: 'overlay-skips-hidden-tests',
    claim: 'grading puts the hidden tests back over the PR files, so a PR cannot replace them',
    edits: [
      ['bench/grade.ts', 'for (const rel of readTree(prepared.hidden)) {', 'for (const rel of [] as string[]) {'],
    ],
    tests: [SETUP],
  },
  {
    name: 'exit-code-ignored',
    claim: 'a failing hidden test run is recorded as fail, never pass (false-pass detection)',
    edits: [['bench/grade.ts', 'if (ran.code !== 0) return', 'if (false) return']],
    tests: [SETUP],
  },
  {
    name: 'no-test-evidence-needed',
    claim: 'an exit 0 with no test summary is a fail (false-pass detection)',
    edits: [['bench/grade.ts', 'if (!new RegExp(task.expect).test(output))', 'if (false)']],
    tests: [SETUP],
  },
  {
    name: 'base-pass-accepted',
    claim: 'hidden tests that pass at the reverted base make the task refused',
    edits: [['bench/grade.ts', "return base.outcome === 'fail'", "return true || base.outcome === 'fail'"]],
    tests: [SETUP],
  },
  {
    name: 'base-crash-accepted',
    claim: 'a crash at the base that is not a test failure does not count as the hidden tests failing',
    edits: [
      ['bench/grade.ts', "if (base.outcome === 'fail' && !new RegExp(task.baseFail).test(base.output))", 'if (false)'],
    ],
    tests: [SETUP],
  },
  {
    name: 'unverified-task-runs',
    claim: 'a task whose hidden tests were never checked at the base does not run',
    edits: [['bench/run.ts', "if (!existsSync(join(prepared.dir, 'verified.json')))", 'if (false)']],
    tests: [SETUP],
  },
  {
    name: 'no-timeout-race',
    claim: 'a run past the time limit ends as a timeout row even when the arm ignores the abort signal',
    edits: [['bench/run.ts', '    timeout,\n  ]);', '  ]);']],
    tests: [SETUP],
  },
  {
    name: 'timeout-recorded-as-fail',
    claim: 'the timeout row says timeout, not fail or pass',
    edits: [['bench/run.ts', "outcome: 'timeout',", "outcome: 'fail',"]],
    tests: [SETUP],
  },
  {
    name: 'grading-timeout-ignored',
    claim: 'hidden tests that run past the limit are recorded as timeout',
    edits: [['bench/grade.ts', 'if (ran.timedOut) return', 'if (false) return']],
    tests: [SETUP],
  },
  {
    name: 'timed-out-container-kept',
    claim: 'a timed-out docker grading run is removed, so no container outlives its row',
    edits: [['bench/runner.ts', 'if (ran.timedOut) await runBinary', 'if (false) await runBinary']],
    tests: [CAGE],
  },
  {
    name: 'pr-file-escapes-workspace',
    claim: 'a PR file that leaves the workspace is refused',
    edits: [
      ['bench/workspace.ts', 'if (full !== resolve(root) && !full.startsWith(resolve(root) + sep))', 'if (false)'],
    ],
    tests: [SETUP],
  },
  {
    name: 'no-hidden-commit-accepted',
    claim: 'a task with no hidden-test commit is refused with a clear message',
    edits: [['bench/model.ts', 'o.hiddenPaths.length === 0', 'false']],
    tests: [SETUP],
  },
  {
    name: 'unconfirmed-hidden-path',
    claim: 'a hidden path that the fix commit does not touch is refused',
    edits: [['bench/workspace.ts', 'if (!changed.has(rel)) throw', 'if (false) throw']],
    tests: [SETUP],
  },
  {
    name: 'unmeasured-counts-as-pass',
    claim: 'a threshold whose column was not recorded reads UNMEASURED, never PASS',
    edits: [['bench/report.ts', "value === null ? 'UNMEASURED' : ok(value)", "value === null ? 'PASS' : ok(value)"]],
    tests: [REPORT],
  },
  {
    name: 'merge-rate-boundary',
    claim: 'a merge rate of exactly 50% passes and 49% fails',
    edits: [['bench/report.ts', 'v >= THRESHOLDS.minMergeRate', 'v > THRESHOLDS.minMergeRate']],
    tests: [REPORT],
  },
  {
    name: 'baseline-rows-in-thresholds',
    claim: 'the thresholds judge the factory arm only',
    edits: [['bench/report.ts', "const factory = rows.filter((r) => r.arm === 'factory');", 'const factory = rows;']],
    tests: [REPORT],
  },
  {
    name: 'merged-after-head-moved-counts',
    claim: 'a Set B PR merged after its head moved is not "merged unchanged"',
    edits: [['bench/merge-state.ts', 'pull.merged && pull.head.sha === task.readyHeadSha', 'pull.merged']],
    tests: [REPORT],
  },
  {
    name: 'login-gate-off',
    claim: 'the real Claude baseline does not start until the operator confirms the login',
    edits: [['bench/run.ts', "if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1')", 'if (false)']],
    tests: [CLI],
  },
  {
    name: 'task-confirmation-gate-off',
    claim: 'the real Claude baseline does not start on a task the operator has not confirmed',
    edits: [
      [
        'bench/run.ts',
        'if (!task.confirmed) throw new TaskRefused(`task ${task.id} is not confirmed',
        'if (false) throw new TaskRefused(`task ${task.id} is not confirmed',
      ],
    ],
    tests: [CLI],
  },
  {
    name: 'factory-grades-wrong-head',
    claim: 'the factory arm grades the files of the PR head it reports',
    edits: [
      ['bench/arms-live.ts', 'handle.host.files(handle.repo, change.number, change.headSha)', 'Promise.resolve([])'],
    ],
    tests: [ARMS],
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
const lines = [];
let bad = 0;
for (const mutant of MUTANTS) {
  if (only.length > 0 && !only.includes(mutant.name)) continue;
  const originals = new Map();
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
      if (!current.includes(find)) throw new Error(`${mutant.name}: pattern not found in ${file}`);
      writeFileSync(path, current.replace(find, replace));
    }
    const caught = vitest(mutant.tests).status !== 0;
    if (!caught) bad += 1;
    lines.push(`${caught ? 'OK  ' : 'BAD '} ${mutant.name}: ${caught ? 'caught' : 'survived'}. Claim: ${mutant.claim}`);
    console.log(lines.at(-1));
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/swarm-P2-1/owner/mutants.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
