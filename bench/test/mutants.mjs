// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = 'bench/test/task-setup.test.ts';
const REPORT = 'bench/test/report.test.ts';
const CAGE = 'bench/test/cage-mount.test.ts';
const ARMS = 'bench/test/arms.test.ts';
const CLI = 'bench/test/cli.test.ts';
const CLOSURE = 'bench/test/closure.test.ts';
const FACTORY = 'bench/test/factory.test.ts';
const ONCE = 'bench/test/once.test.ts';
const NOCI = 'bench/test/no-ci.test.ts';

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
    name: 'tag-refs-allowed',
    claim: 'a tag ref in the cage source is reported, since it can name the fix commit',
    edits: [
      [
        'bench/workspace.ts',
        "ref.startsWith('refs/remotes/') || ref.startsWith('refs/tags/')",
        "ref.startsWith('refs/remotes/')",
      ],
    ],
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
    name: 'base-pass-accepted',
    claim: 'hidden tests that pass at the reverted base make the task refused',
    edits: [['bench/grade.ts', "if (base.outcome !== 'fail')", 'if (false)']],
    tests: [SETUP],
  },
  {
    name: 'base-crash-accepted',
    claim: 'a crash at the base that is not a test failure does not count as the hidden tests failing',
    edits: [['bench/grade.ts', 'hiddenFailed === true', 'true']],
    tests: [SETUP],
  },
  {
    name: 'unverified-task-runs',
    claim: 'a task whose hidden tests were never checked at the base does not run',
    edits: [['bench/run.ts', 'if (!existsSync(verifiedFile))', 'if (false)']],
    tests: [SETUP],
  },
  {
    name: 'no-timeout-race',
    claim: 'a run past the time limit ends as a timeout row even when the arm ignores the abort signal',
    edits: [['bench/run.ts', 'Promise.race([settled, timeout])', 'Promise.race([settled])']],
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
    edits: [['bench/protected.ts', "rel === '..' || rel.startsWith('../') || ", '']],
    tests: [CLOSURE],
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
    name: 'factory-grades-wrong-head',
    claim: 'the factory arm grades the files of the PR head it reports',
    edits: [
      ['bench/arms-live.ts', 'handle.host.files(handle.repo, change.number, change.headSha)', 'Promise.resolve([])'],
    ],
    tests: [ARMS],
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
    name: 'bin-skips-login-gate',
    claim: '--bin does not skip the login gate',
    edits: [
      [
        'bench/run.ts',
        "if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1')",
        "if (values.bin === undefined && process.env.AW_BENCH_LOGIN_CONFIRMED !== '1')",
      ],
    ],
    tests: [CLI],
  },
  {
    name: 'bin-skips-task-gate',
    claim: '--bin does not skip the task confirmation gate',
    edits: [['bench/run.ts', 'if (!task.confirmed) throw', 'if (values.bin === undefined && !task.confirmed) throw']],
    tests: [CLI],
  },
  {
    name: 'cage-default-allowlist',
    claim: 'a bench cage gets the bench allowlist, not the default one with github and the npm registry',
    edits: [['bench/cage.ts', 'allowlist: BENCH_ALLOWLIST', 'allowlist: undefined']],
    tests: [CAGE],
  },
  {
    name: 'allowlist-widened',
    claim: 'the bench allowlist holds the model API and nothing else',
    edits: [['bench/cage.ts', "['api.anthropic.com']", "['api.anthropic.com', 'github.com']"]],
    tests: [CAGE],
  },
  {
    name: 'cage-without-deps',
    claim: 'a bench cage holds the pre-installed dependencies, so tests run without the registry',
    edits: [['bench/cage.ts', 'cpSync(modules,', 'void (modules,']],
    tests: [CAGE],
  },
  {
    name: 'cage-tracks-deps',
    claim: 'the pre-installed dependencies stay out of the cage repo index',
    edits: [
      [
        'bench/cage.ts',
        "appendFileSync(join(view.workdir, '.git', 'info', 'exclude'), 'node_modules/\\n');",
        'void 0;',
      ],
    ],
    tests: [CAGE],
  },
  {
    name: 'run-uses-bare-driver',
    claim: 'the live baseline builds its cage from BenchCage',
    edits: [['bench/run.ts', 'new BenchCage(', 'new SandboxDriver(']],
    tests: [CLI],
  },
  {
    name: 'own-copy-allowed',
    claim: 'an installed copy of the project newer than the base is refused',
    edits: [['bench/workspace.ts', 'newerThan(version, base)\n      ?', 'false\n      ?']],
    tests: [CLOSURE, SETUP],
  },
  {
    name: 'own-copy-comparison-reversed',
    claim: 'a newer copy is judged by its version, not an older one',
    edits: [['bench/workspace.ts', 'return (a[i] ?? 0) > (b[i] ?? 0);', 'return (a[i] ?? 0) < (b[i] ?? 0);']],
    tests: [CLOSURE],
  },
  {
    name: 'install-check-skipped',
    claim: 'prepare refuses an install that leaves a newer copy of the project',
    edits: [['bench/workspace.ts', 'if (stale.length > 0) throw', 'if (false) throw']],
    tests: [SETUP],
  },
  {
    name: 'package-links-kept',
    claim: 'the upstream repository, homepage and bugs links are stripped from package.json',
    edits: [['bench/workspace.ts', 'for (const key of UPSTREAM_FIELDS) delete meta[key];', 'void UPSTREAM_FIELDS;']],
    tests: [CLOSURE, SETUP],
  },
  {
    name: 'package-links-not-applied',
    claim: 'prepare strips the package links before the cage source is committed',
    edits: [['bench/workspace.ts', 'neutralisePackage(source);', 'void source;']],
    tests: [SETUP],
  },
  {
    name: 'ticket-keeps-url',
    claim: 'the ticket carries no link to the upstream issue',
    edits: [['bench/arms-live.ts', 'url: null,', 'url: `https://github.com/${task.repo}/issues/${task.issue}`,']],
    tests: [ARMS],
  },
  {
    name: 'ticket-keeps-links',
    claim: 'links to the host and the registry are cut from the ticket body',
    edits: [['bench/arms-live.ts', "task.body.replace(LINK, '[link removed]')", 'task.body']],
    tests: [ARMS],
  },
  {
    name: 'ticket-id-names-task',
    claim: 'the ticket id does not carry the task id, which holds the issue number',
    edits: [
      [
        'bench/arms-live.ts',
        "id: `bench/t-${createHash('sha256').update(task.id).digest('hex').slice(0, 8)}-r${run}`,",
        'id: `bench/${task.id}-r${run}`,',
      ],
    ],
    tests: [ARMS],
  },
  {
    name: 'protected-paths-off',
    claim: 'a PR path into node_modules, the runner config or package files is refused',
    edits: [['bench/protected.ts', 'return PROTECTED.some((pattern) => pattern.test(rel))', 'return false']],
    tests: [CLOSURE],
  },
  {
    name: 'node-modules-not-protected',
    claim: 'a PR cannot write under node_modules',
    edits: [['bench/protected.ts', '/(^|\\/)node_modules(\\/|$)/i,', '/(^|\\/)zz-node-modules(\\/|$)/i,']],
    tests: [CLOSURE],
  },
  {
    name: 'node-modules-case-sensitive',
    claim: 'node_modules is protected whatever the case',
    edits: [['bench/protected.ts', '/(^|\\/)node_modules(\\/|$)/i,', '/(^|\\/)node_modules(\\/|$)/,']],
    tests: [CLOSURE],
  },
  {
    name: 'package-json-not-protected',
    claim: 'a PR cannot rewrite package.json',
    edits: [['bench/protected.ts', '/(^|\\/)package\\.json$/i,', '/(^|\\/)zz-package\\.json$/i,']],
    tests: [CLOSURE],
  },
  {
    name: 'runner-config-not-protected',
    claim: 'a PR cannot add or change the runner config',
    edits: [['bench/protected.ts', '  RUNNER_CONFIG,\n', '']],
    tests: [CLOSURE],
  },
  {
    name: 'report-file-not-protected',
    claim: 'a PR cannot write the grader report directory',
    edits: [['bench/protected.ts', '/(^|\\/)\\.aw-bench(\\/|$)/i,', '/(^|\\/)zz-aw-bench(\\/|$)/i,']],
    tests: [CLOSURE],
  },
  {
    name: 'backslash-path-slips-through',
    claim: 'a PR path with backslashes is normalised before it is judged',
    edits: [['bench/protected.ts', "path.replace(/\\\\/g, '/')", 'path']],
    tests: [CLOSURE],
  },
  {
    name: 'symlink-write-allowed',
    claim: 'a PR path through a symbolic link in the tree is refused',
    edits: [['bench/grade.ts', 'if (throughLink(work, linkCheck))', 'if (false)']],
    tests: [CLOSURE],
  },
  {
    name: 'symlink-delete-allowed',
    claim: 'a PR deletion through a symbolic link in the tree is refused',
    edits: [['bench/grade.ts', 'act(rel, dirname(rel), ', "act(rel, '.', "]],
    tests: [CLOSURE],
  },
  {
    name: 'deletions-not-applied',
    claim: 'a PR deletion or the old side of a rename is applied before grading',
    edits: [['bench/grade.ts', 'for (const rel of change.deleted) {', 'for (const rel of [] as string[]) {']],
    tests: [CLOSURE],
  },
  {
    name: 'hidden-spec-optional',
    claim: 'every spec file must appear in the structured report with a nonzero pass count',
    edits: [['bench/grade.ts', '(specFor(specs, rel)?.passed ?? 0) === 0', 'false']],
    tests: [CLOSURE],
  },
  {
    name: 'failures-ignored',
    claim: 'one failed test in the report fails the grade',
    edits: [['bench/grade.ts', 'if (failed > 0 || ran.code !== 0)', 'if (ran.code !== 0)']],
    tests: [CLOSURE],
  },
  {
    name: 'exit-code-ignored',
    claim: 'a nonzero exit is recorded as fail even when the report reads green',
    edits: [['bench/grade.ts', 'if (failed > 0 || ran.code !== 0)', 'if (failed > 0)']],
    tests: [CLOSURE],
  },
  {
    name: 'unstructured-output-passes',
    claim: 'a run with no structured report is a fail whatever it printed',
    edits: [
      [
        'bench/grade.ts',
        'const specs = parseSpecs(task.reporter, readResult(work));',
        'const specs = parseSpecs(task.reporter, readResult(work)) ?? [];',
      ],
    ],
    tests: [SETUP, CLOSURE],
  },
  {
    name: 'load-failure-not-a-failure',
    claim: 'a spec file that failed to load counts as one failure',
    edits: [['bench/grade.ts', "failed === 0 && t.status === 'failed' ? 1 : failed", 'failed']],
    tests: [CLOSURE],
  },
  {
    name: 'skipped-counts-as-passed',
    claim: 'a skipped test is not a pass',
    edits: [
      [
        'bench/grade.ts',
        "statuses.filter((s) => s === 'passed').length",
        "statuses.filter((s) => s !== 'failed').length",
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'deleted-files-lost-in-baseline',
    claim: 'the baseline arm reads the files the session deleted',
    edits: [['bench/arms-live.ts', 'deleted: await deletedSince(shell, before.out.trim()),', 'deleted: [],']],
    tests: [ARMS],
  },
  {
    name: 'deleted-files-lost-in-factory',
    claim: 'the factory arm reads the paths the PR removed or renamed away',
    edits: [['bench/arms-live.ts', 'deleted: await handle.removed(change),', 'deleted: [],']],
    tests: [ARMS],
  },
  {
    name: 'rename-source-dropped',
    claim: 'the old name of a renamed file counts as deleted',
    edits: [['bench/arms-live.ts', "file.status === 'renamed'", "file.status === 'zz'"]],
    tests: [ARMS],
  },
  {
    name: 'fix-script-keeps-protected-paths',
    claim: 'the upstream fix replayed as a change leaves out the package and runner files the grader refuses',
    edits: [['bench/workspace.ts', ' && protectedReason(rel) === null &&', ' &&']],
    tests: [SETUP],
  },
  {
    name: 'fix-script-keeps-test-side-paths',
    claim: 'the upstream fix replayed as a change leaves out the test-side files the grader refuses',
    edits: [['bench/workspace.ts', ' && !isTestSide(rel),', ',']],
    tests: [SETUP],
  },
  {
    name: 'tokens-drop-cache-read',
    claim: 'the token total carries the cache-read column',
    edits: [['bench/arms-live.ts', 'cacheRead: seen.reduce((n, u) => n + u.cacheReadTokens, 0),', 'cacheRead: 0,']],
    tests: [ARMS],
  },
  {
    name: 'scripted-rows-count',
    claim: 'scripted rows never reach a verdict',
    edits: [
      ['bench/report.ts', 'rows.filter((r) => !r.scripted && r.flag === null)', 'rows.filter((r) => r.flag === null)'],
    ],
    tests: [REPORT],
  },
  {
    name: 'merge-rate-counts-set-a',
    claim: 'the merge rate reads Set B rows only',
    edits: [['bench/report.ts', "const setB = factory.filter((r) => r.set === 'B');", 'const setB = factory;']],
    tests: [REPORT],
  },
  {
    name: 'cost-reads-every-factory-row',
    claim: 'the cost check divides the windows of Set B rows by the Set B merges, not the windows of every factory row',
    edits: [
      [
        'bench/report.ts',
        'const windows = sum(setB, (r) => r.quotaWindows);',
        'const windows = sum(factory, (r) => r.quotaWindows);',
      ],
    ],
    tests: [REPORT],
  },
  {
    name: 'minutes-read-every-factory-row',
    claim: 'the human-minutes check reads Set B rows only',
    edits: [
      [
        'bench/report.ts',
        'const minutes = sum(setB, (r) => r.humanMinutes);',
        'const minutes = sum(factory, (r) => r.humanMinutes);',
      ],
    ],
    tests: [REPORT],
  },
  {
    name: 'flagged-rows-count',
    claim: 'a contaminated or suspect row reaches no verdict',
    edits: [['bench/report.ts', '!r.scripted && r.flag === null);', '!r.scripted);']],
    tests: [REPORT],
  },
  {
    name: 'flagged-rows-hidden',
    claim: 'the report lists the flagged rows in their own section',
    edits: [
      [
        'bench/report.ts',
        'const flagged = rows.filter((r) => !r.scripted && r.flag !== null);',
        'const flagged: Row[] = [];',
      ],
    ],
    tests: [REPORT],
  },
  {
    name: 'old-rows-without-flag-accepted',
    claim: 'rows written before the flag column are refused',
    edits: [['bench/report.ts', '|| parsed.flag === undefined', '']],
    tests: [REPORT],
  },
  {
    name: 'standin-pass-counted',
    claim: 'the stand-in pass node prints for a file that ended early is not a passing test',
    edits: [
      [
        'bench/reporters/node-json.mjs',
        "if (event.type === 'test:fail' || standIn)",
        "if (event.type === 'test:fail')",
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'standin-never-matches',
    claim: 'the stand-in test is recognised by its file-path name at the top level',
    edits: [['bench/reporters/node-json.mjs', 'const standIn = nesting === 0 &&', 'const standIn = false &&']],
    tests: [CLOSURE],
  },
  {
    name: 'test-side-edit-leaks',
    claim: 'a dropped test-side edit never reaches the graded tree, even when it is not a hidden file',
    edits: [
      ['bench/grade.ts', 'files: change.files.filter((f) => !isDropped(f.path)),', 'files: change.files,'],
      ['bench/grade.ts', 'deleted: change.deleted.filter((p) => !isDropped(p)),', 'deleted: change.deleted,'],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'test-side-drop-not-applied',
    claim: 'a PR that edits a test-side file is graded on the rest instead of being refused as a whole',
    edits: [
      [
        'bench/grade.ts',
        'const { kept, dropped } = dropTestSide(change, side);',
        "const { kept, dropped } = dropTestSide(change, side);\n  if (dropped.length > 0) return { outcome: 'fail', note: 'the PR is refused', specs: null, suspect: [], dropped: [] };",
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'dropped-paths-not-recorded',
    claim: 'the paths dropped from the graded diff are recorded on the grade and in the row note',
    edits: [['bench/run.ts', '? `dropped test-side edits ${dropped.join', '? `${dropped.length} ${[].join']],
    tests: [CLOSURE],
  },
  {
    name: 'dropped-set-empty',
    claim: 'the grade names every dropped path',
    edits: [['bench/grade.ts', 'minPassed)), suspect, dropped };', 'minPassed)), suspect, dropped: [] };']],
    tests: [CLOSURE],
  },
  {
    name: 'only-test-side-graded',
    claim: 'a PR that touches only test-side files grades fail with a nothing-to-grade note',
    edits: [['bench/grade.ts', 'if (dropped.length > 0 && kept.files.every', 'if (false && kept.files.every']],
    tests: [CLOSURE],
  },
  {
    name: 'shadow-stem-allowed',
    claim: 'a PR file with the stem of a test-side file, such as cases.spec.js over cases.spec.ts, is refused',
    edits: [['bench/testside.ts', 'side.files.has(key) || side.stems.has(stemOf(key))', 'side.files.has(key)']],
    tests: [CLOSURE],
  },
  {
    name: 'config-imports-unprotected',
    claim: 'the files a runner config imports or names are test-side, so a PR cannot plant code the runner loads',
    edits: [
      [
        'bench/testside.ts',
        'const queue = treeRels.filter((rel) => RUNNER_CONFIG.test(rel));',
        'const queue: string[] = [];',
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'test-dirs-unprotected',
    claim: 'files under test, tests, fixtures and snapshot directories are test-side',
    edits: [
      [
        'bench/protected.ts',
        '(__snapshots__|__tests__|__mocks__|__fixtures__|test|tests|fixtures|e2e)',
        '(__snapshots__|__tests__|__mocks__|__fixtures__)',
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'hidden-files-unprotected',
    claim: 'the hidden test files are test-side even when no pattern names them',
    edits: [
      [
        'bench/testside.ts',
        'new Set([...readTree(hidden).map(canonical), ...treeRels.filter(isTestSide)])',
        'new Set(treeRels.filter(isTestSide))',
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'new-test-file-applied',
    claim: 'a test file the PR adds is not applied to the graded tree',
    edits: [['bench/grade.ts', 'if (skipped.has(edit.path)) continue;', 'void skipped;']],
    tests: [CLOSURE],
  },
  {
    name: 'count-floor-off',
    claim: 'a suite that passes fewer tests than the upstream fix did cannot pass',
    edits: [['bench/grade.ts', 'if (passed < minPassed)', 'if (false)']],
    tests: [CLOSURE],
  },
  {
    name: 'floor-not-passed-to-grade',
    claim: 'a run grades against the count the upstream fix reached',
    edits: [['bench/run.ts', '    ctx.scratch,\n    fixPassed,\n', '    ctx.scratch,\n']],
    tests: [CLOSURE, SETUP],
  },
  {
    name: 'floor-recorded-as-zero',
    claim: 'verify records the real passing-test count of the upstream fix',
    edits: [['bench/run.ts', 'fixPassed: totalPassed(fixed.specs)', 'fixPassed: 0']],
    tests: [SETUP],
  },
  {
    name: 'verify-skips-upstream-fix',
    claim: 'a task whose own upstream fix does not grade pass is refused',
    edits: [['bench/run.ts', "if (fixed.outcome !== 'pass' || fixed.specs === null)", 'if (false)']],
    tests: [SETUP],
  },
  {
    name: 'suspect-scan-off',
    claim: 'a PR file that imports test machinery or exits the process is marked suspect',
    edits: [['bench/testside.ts', 'count(after, pattern) > count(before, pattern)', 'false']],
    tests: [CLOSURE],
  },
  {
    name: 'suspect-ignores-base-use',
    claim: 'the scan flags what the PR adds, not a use the base file had',
    edits: [['bench/testside.ts', 'count(after, pattern) > count(before, pattern)', 'count(after, pattern) > 0']],
    tests: [CLOSURE],
  },
  {
    name: 'suspect-flag-dropped',
    claim: 'a suspect scan result reaches the row as a suspect flag',
    edits: [['bench/run.ts', ": suspect.length > 0\n      ? ['suspect'", ": false\n      ? ['suspect'"]],
    tests: [CLOSURE],
  },
  {
    name: 'web-requests-not-flagged',
    claim: 'a run that made server-side web requests is flagged contaminated',
    edits: [['bench/run.ts', 'webRequests !== null && webRequests > 0', 'false']],
    tests: [CLOSURE],
  },
  {
    name: 'web-tools-allowed',
    claim: 'claude runs with WebSearch and WebFetch disallowed',
    edits: [['server/agents/claude-code.ts', "  '--disallowedTools',\n  WITHOUT_WEB,\n", '']],
    tests: ['server/test/agents.test.ts'],
  },
  {
    name: 'web-requests-uncounted',
    claim: 'the stream reader counts server-side web searches and fetches',
    edits: [['server/agents/claude-code.ts', 'webRequests: Math.max(reported, served)', 'webRequests: 0']],
    tests: ['server/test/agents.test.ts'],
  },
  {
    name: 'web-requests-not-carried',
    claim: 'the baseline arm carries the web request count into the row',
    edits: [
      ['bench/arms-live.ts', '      webRequests: webRequestsOf([result.usage]),\n', '      webRequests: null,\n'],
    ],
    tests: [ARMS],
  },
  {
    name: 'equal-copy-content-unjudged',
    claim: 'an installed copy at the base version is judged by its content against the base tree',
    edits: [['bench/workspace.ts', 'if (sameVersion && SOURCE_FILE.test(rel)', 'if (false && SOURCE_FILE.test(rel)']],
    tests: [CLOSURE],
  },
  {
    name: 'hidden-copy-in-package-unjudged',
    claim: 'an installed copy of the project that carries a hidden test is refused',
    edits: [['bench/workspace.ts', 'if (planted !== undefined) problems.push', 'if (false) problems.push']],
    tests: [CLOSURE],
  },
  {
    name: 'overhead-drops-prepare',
    claim: 'the overhead counts grading and prepare time',
    edits: [['bench/report.ts', 'prepare: Math.max(...mine.map((r) => r.prepareMs)) / 1000,', 'prepare: 0,']],
    tests: [REPORT],
  },
  {
    name: 'old-rows-accepted',
    claim: 'rows from an older harness are refused',
    edits: [['bench/report.ts', "typeof parsed.scripted !== 'boolean' ||", 'false ||']],
    tests: [REPORT],
  },
  {
    name: 'trailing-slash-kept',
    claim: 'one canonical path drops trailing slashes, so a path is matched and acted on in the same form',
    edits: [['bench/protected.ts', ".replace(/\\/+$/, '')", '']],
    tests: [CLOSURE],
  },
  {
    name: 'path-case-matched-exactly',
    claim: 'the test-side match folds case, so a case variant of a test-side path is dropped, not written',
    edits: [['bench/protected.ts', ".normalize('NFC').toLowerCase()", '']],
    tests: [CLOSURE],
  },
  {
    name: 'change-not-canonical-at-boundary',
    claim: 'the PR change is canonicalised once before it is matched, refused or applied',
    edits: [['bench/grade.ts', 'change = canonicalChange(asked);', 'change = asked;']],
    tests: [CLOSURE],
  },
  {
    name: 'workspace-path-uncanonical',
    claim: 'insideOf resolves the canonical path, the form the matcher sees',
    edits: [['bench/workspace.ts', 'const clean = canonical(rel);', 'const clean = rel;']],
    tests: [CLOSURE],
  },
  {
    name: 'git-dir-case-allowed',
    claim: 'a path inside .git is protected whatever its case',
    edits: [['bench/protected.ts', '  /(^|\\/)\\.git(\\/|$)/i,\n', '']],
    tests: [CLOSURE],
  },
  {
    name: 'directory-path-applied',
    claim: 'a PR path that names a directory is refused with a note, not thrown from the grader',
    edits: [['bench/grade.ts', 'lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true', 'false']],
    tests: [CLOSURE],
  },
  {
    name: 'apply-error-aborts-grade',
    claim: 'a filesystem error applying a PR path grades the PR fail instead of aborting the run',
    edits: [
      [
        'bench/grade.ts',
        'return `${rel} cannot be applied: ${error instanceof Error ? error.message : String(error)}`;',
        'throw error;',
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'base-text-throws-on-directory',
    claim: 'reading the base text of a PR path that is a directory or under a file does not abort grading',
    edits: [
      [
        'bench/grade.ts',
        "  } catch {\n    return '';\n  }\n};\n\nconst throughLink",
        '  } catch (error) {\n    throw error;\n  }\n};\n\nconst throughLink',
      ],
    ],
    tests: [CLOSURE],
  },
  {
    name: 'seed-keeps-actions',
    claim: 'the seeded tree has no .github, so a push cannot start Actions on the scratch repo',
    edits: [
      ['bench/scratch.ts', "rmSync(join(dir, '.github'), { recursive: true, force: true });", 'void 0;'],
      ['bench/scratch.ts', 'if (tracked.some(underGithub))', 'if (false)'],
    ],
    tests: [FACTORY],
  },
  {
    name: 'seed-strip-unchecked',
    claim: 'a .github left in the seeded tree is refused before the push',
    edits: [
      ['bench/scratch.ts', 'if (tracked.some(underGithub))', 'if (false)'],
      ['bench/scratch.ts', "rmSync(join(dir, '.github'), { recursive: true, force: true });", 'void 0;'],
    ],
    tests: [FACTORY],
  },
  {
    name: 'seed-no-force',
    claim: 'a branch a crashed run left behind is replaced by the new seed',
    edits: [['bench/scratch.ts', "'push', '--quiet', '--force', target.remote", "'push', '--quiet', target.remote"]],
    tests: [FACTORY],
  },
  {
    name: 'base-ref-any',
    claim: 'the bench writes and deletes only bench-base refs on the scratch host, never main',
    edits: [
      [
        'bench/scratch.ts',
        'const BASE_REF = /^bench-base\\/t-[0-9a-f]{8}-r[1-9]\\d{0,2}$/;',
        'const BASE_REF = /^.*$/;',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'work-ref-any',
    claim: 'the bench deletes only aw/bench work branches',
    edits: [
      [
        'bench/scratch.ts',
        'const WORK_REF = /^aw\\/bench\\/t-[0-9a-f]{8}-r[1-9]\\d{0,2}$/;',
        'const WORK_REF = /^.*$/;',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'cleanup-allows-merge',
    claim: 'the cleanup sender refuses a merge and every write that is not a close or a bench branch delete',
    edits: [
      ['bench/scratch.ts', "return 'it is not a GET, a PR close or a delete of a bench work branch';", 'return null;'],
    ],
    tests: [FACTORY],
  },
  {
    name: 'cleanup-any-patch',
    claim: 'the cleanup sender only ever closes a PR',
    edits: [['bench/scratch.ts', 'JSON.stringify(request.body) === \'{"state":"closed"}\' ? null', 'true ? null']],
    tests: [FACTORY],
  },
  {
    name: 'scratch-name-any',
    claim: 'the factory arm refuses a repo that is not named like a scratch repo',
    edits: [
      [
        'bench/scratch.ts',
        'const SCRATCH_NAME = /^[\\w-][\\w.-]*\\/[\\w.-]*-scratch$/;',
        'const SCRATCH_NAME = /^.*$/;',
      ],
    ],
    tests: [FACTORY, CLI],
  },
  {
    name: 'stale-pr-stays-open',
    claim: 'a PR a crashed run left open is closed before the crew starts',
    edits: [['bench/scratch.ts', '    change !== null;', '    false;']],
    tests: [FACTORY],
  },
  {
    name: 'cleanup-after-run-skipped',
    claim: 'the PR and both branches are removed after the run',
    edits: [['bench/scratch.ts', 'if (o.keep !== true) await clear();', 'void 0;']],
    tests: [FACTORY],
  },
  {
    name: 'cleanup-before-seed-skipped',
    claim: 'a leftover PR and branch are cleared before the seed',
    edits: [
      [
        'bench/scratch.ts',
        '      await clear();\n      await seedBase(prepared.source',
        '      await seedBase(prepared.source',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'failure-not-recorded',
    claim: 'the first failed session is remembered so the arm stops without retries',
    edits: [['bench/scratch.ts', 'failure ??= {', 'void {']],
    tests: [FACTORY],
  },
  {
    name: 'failure-ignored-by-arm',
    claim: 'the arm ends a run at the first failed session',
    edits: [['bench/arms-live.ts', 'if (failed !== null) return {', 'if (false) return {']],
    tests: [FACTORY],
  },
  {
    name: 'retry-after-failure',
    claim: 'no session starts after one failed, so no quota is spent on a retry',
    edits: [
      [
        'bench/scratch.ts',
        'if (failure !== null) throw new Error(`no session starts after a failure: ${failure.message}`);',
        'void 0;',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'settled-ignores-head',
    claim: 'a review of an older head does not settle the PR',
    edits: [['bench/arms-live.ts', 'r.commitId === snapshot.change.headSha && ', '']],
    tests: [FACTORY],
  },
  {
    name: 'settled-counts-changes',
    claim: 'a review that asks for changes does not settle the PR',
    edits: [['bench/arms-live.ts', "mark?.[1] === reviewer && mark[2] !== 'changes'", 'mark?.[1] === reviewer']],
    tests: [FACTORY],
  },
  {
    name: 'settled-any-worker',
    claim: 'only the reviewer worker settles the PR',
    edits: [['bench/arms-live.ts', 'mark?.[1] === reviewer && ', '']],
    tests: [FACTORY],
  },
  {
    name: 'arm-ignores-settled',
    claim:
      'the arm stops when the reviewer has seen the head and asked for no change, which is the only stop with one account',
    edits: [
      [
        'bench/arms-live.ts',
        "if (await reviewSettledOnHost(handle, branch)) return { kind: 'review_settled' };",
        'void 0;',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'removed-ignores-status',
    claim: 'a failed host listing of PR files is an error, not an empty list of deletions',
    edits: [['bench/arms-live.ts', 'if (response.status >= 400)', 'if (false)']],
    tests: [FACTORY],
  },
  {
    name: 'duplicate-session-allowed',
    claim: 'a session starts at most once per task, role and round, whatever fails after it and whoever retries',
    edits: [['bench/scratch.ts', 'if (started.has(turn)) {', 'if (false) {']],
    tests: [ONCE, FACTORY],
  },
  {
    name: 'host-failure-unseen-by-arm',
    claim:
      'a failure after the session (push refused, no file changed, review rejected) ends the row with its own cause',
    edits: [['bench/scratch.ts', 'onJobFailed: (_task, error) => crew.fail(error),', 'onJobFailed: () => {},']],
    tests: [ONCE],
  },
  {
    name: 'refusal-graded-as-error',
    claim: 'a change the host write guard refuses is a failed task, not a broken run',
    edits: [['bench/scratch.ts', 'refused: error instanceof WriteRefused,', 'refused: false,']],
    tests: [ONCE, FACTORY],
  },
  {
    name: 'cage-exec-ignores-abort',
    claim: 'the abort signal reaches the cage exec, so a timed-out session is killed',
    edits: [['server/agents/claude-code.ts', '      signal: job.signal,\n', '']],
    tests: [ONCE],
  },
  {
    name: 'session-starts-after-abort',
    claim: 'no session starts once the run was aborted',
    edits: [['server/agents/claude-code.ts', '    job.signal.throwIfAborted();\n    const shell', '    const shell']],
    tests: [ONCE],
  },
  {
    name: 'push-after-abort',
    claim: 'a session that ends after the mode was closed pushes nothing',
    edits: [
      [
        'server/modes/cages.ts',
        '      abort.signal.throwIfAborted();\n      return host.pushFiles(',
        '      return host.pushFiles(',
      ],
    ],
    tests: [ONCE],
  },
  {
    name: 'timeout-row-before-arm-settles',
    claim: 'a timed-out run returns only after the arm has stopped and cleaned up, so the next run starts clean',
    edits: [
      ['bench/run.ts', 'const stopped = await within(settled, ctx.settleMs ?? SETTLE_MS);', 'const stopped = true;'],
    ],
    tests: [ONCE],
  },
  {
    name: 'stuck-arm-waited-for-forever',
    claim:
      'an arm that never stops is abandoned after the grace, with a note on the row, so one stuck run cannot hang the batch',
    edits: [['bench/run.ts', 'timer = setTimeout(() => resolve(false), ms);', 'void ms;']],
    tests: [ONCE],
  },
  {
    name: 'cages-not-killed-on-abort',
    claim: 'aborting a run removes the cages of its driver',
    edits: [
      [
        'bench/run.ts',
        "signal.addEventListener('abort', () => void kill().catch(() => {}), { once: true });",
        'void 0;',
      ],
    ],
    tests: [ONCE],
  },
  {
    name: 'run-number-not-in-names',
    claim: 'the ticket, branch and PR of each run carry the run number, so a zombie of run 1 cannot touch run 2',
    edits: [['bench/arms-live.ts', '-r${run}`,', '`,']],
    tests: [ONCE, FACTORY],
  },
  {
    name: 'timeout-unchecked',
    claim: 'a timeout that is not a whole number a timer can hold is refused before the arm starts',
    edits: [['bench/run.ts', 'if (!Number.isInteger(value) || value < 1 || value > max)', 'if (false)']],
    tests: [ONCE, 'bench/test/cli.test.ts'],
  },
  {
    name: 'factory-timeout-not-scaled',
    claim: 'the factory arm gets a multiple of the single-session limit by default',
    edits: [['bench/run.ts', 'task.timeoutMs * factor', 'task.timeoutMs']],
    tests: [ONCE],
  },
  {
    name: 'remote-not-tied-to-repo',
    claim: 'the scratch remote must name the same -scratch repo as --scratch-repo',
    edits: [
      ['bench/scratch.ts', 'scratchRepoProblem(repo) ?? remoteProblem(repo, remote)', 'scratchRepoProblem(repo)'],
    ],
    tests: [FACTORY, 'bench/test/cli.test.ts'],
  },
  {
    name: 'local-remote-any-directory',
    claim: 'a local remote must be a bare repository',
    edits: [['bench/scratch.ts', 'return isBareRepo(remote) ? null :', 'return true ? null :']],
    tests: [FACTORY],
  },
  {
    name: 'cleanup-calls-unlogged',
    claim: 'the cleanup requests go through the API log',
    edits: [
      [
        'bench/scratch.ts',
        'await dropWork(plain, send, target, names.work);',
        'await dropWork(plain, o.send, target, names.work);',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'removed-listing-unlogged',
    claim: 'the listing of removed files goes through the API log',
    edits: [
      [
        'bench/scratch.ts',
        'removedVia(send, target.repo, change.number)',
        'removedVia(o.send, target.repo, change.number)',
      ],
    ],
    tests: [FACTORY],
  },
  {
    name: 'seed-reads-global-git-config',
    claim: 'the seed push reads no global git configuration of the operator',
    edits: [['bench/scratch.ts', "  GIT_CONFIG_GLOBAL: '/dev/null',\n", '']],
    tests: [FACTORY],
  },
  {
    name: 'seed-reads-system-git-config',
    claim: 'the seed push reads no system git configuration',
    edits: [['bench/scratch.ts', "  GIT_CONFIG_NOSYSTEM: '1',\n", '']],
    tests: [FACTORY],
  },
  {
    name: 'seed-drift-unchecked',
    claim: 'the seeded tree is compared with the sealed tree, so git archive attributes cannot change it unseen',
    edits: [['bench/scratch.ts', 'if (drift.length > 0)', 'if (false)']],
    tests: [FACTORY],
  },
  {
    name: 'home-worker-ignored',
    claim: 'every factory worker mounts the home its mapping names',
    edits: [['server/sandbox/container.ts', 'homeName(this.homeWorker(spec.worker))', 'homeName(spec.worker)']],
    tests: [CAGE],
  },
  {
    name: 'no-ci-status-never-posted',
    claim: 'a head the crew pushed gets the harness status, so a host with no checks still reaches qc and a review',
    edits: [['bench/no-ci.ts', 'await mark(head);\n      return inner.snapshot(repo, number);', 'return seen;']],
    tests: [NOCI, FACTORY],
  },
  {
    name: 'no-ci-status-on-any-head',
    claim: 'the status goes only on a head the guarded push produced',
    edits: [
      [
        'bench/no-ci.ts',
        'if (!produced.has(head) || marked.has(head)) return seen;',
        'if (marked.has(head)) return seen;',
      ],
    ],
    tests: [NOCI],
  },
  {
    name: 'no-ci-status-every-read',
    claim: 'the status is posted once per head, however often the PR is read',
    edits: [
      [
        'bench/no-ci.ts',
        'if (!produced.has(head) || marked.has(head)) return seen;',
        'if (!produced.has(head)) return seen;',
      ],
      ['bench/no-ci.ts', 'if (seen.checks.some(', 'if (false && seen.checks.some('],
    ],
    tests: [NOCI],
  },
  {
    name: 'no-ci-status-first-head-only',
    claim: 'a fix round head gets its own status',
    edits: [
      [
        'bench/no-ci.ts',
        'if (!produced.has(head) || marked.has(head)) return seen;',
        'if (!produced.has(head) || marked.size > 0) return seen;',
      ],
    ],
    tests: [NOCI, FACTORY],
  },
  {
    name: 'no-ci-status-failure-retried',
    claim: 'a status that failed is not posted again, so the row ends as an error without a retry',
    edits: [['bench/no-ci.ts', '      failed = error;\n', '']],
    tests: [NOCI, FACTORY],
  },
  {
    name: 'no-ci-status-failure-unreported',
    claim: 'a failed status is the failure of the crew at once, not only of the job that read the PR',
    edits: [['bench/no-ci.ts', '      o.onFailure(error);\n', '']],
    tests: [NOCI],
  },
  {
    name: 'no-ci-guard-any-state',
    claim: 'the status write rule allows only state success',
    edits: [['bench/no-ci.ts', "b.state === 'success' && b.context", 'b.context']],
    tests: [NOCI],
  },
  {
    name: 'no-ci-guard-any-context',
    claim: 'the status write rule allows only the harness context',
    edits: [['bench/no-ci.ts', 'b.context === NO_CI_CONTEXT && ', '']],
    tests: [NOCI],
  },
  {
    name: 'no-ci-guard-any-ref',
    claim: 'the status write rule names a full commit sha, not a branch',
    edits: [['bench/no-ci.ts', '/^\\/statuses\\/[0-9a-f]{40}$/', '/^\\/statuses\\/[^/]+$/']],
    tests: [NOCI],
  },
  {
    name: 'no-ci-guard-extra-key',
    claim: 'the status write rule allows no key besides state, context and description',
    edits: [
      [
        'bench/no-ci.ts',
        "keys: ['state', 'context', 'description']",
        "keys: ['state', 'context', 'description', 'target_url']",
      ],
    ],
    tests: [NOCI],
  },
  {
    name: 'no-ci-status-not-wired',
    claim: 'the factory arm wraps its host so every pushed head is marked',
    edits: [
      [
        'bench/scratch.ts',
        'const host = withNoCiStatus(plain, {',
        'const host = ((h: typeof plain, _o: object) => h)(plain, {',
      ],
    ],
    tests: [FACTORY],
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
const selected = MUTANTS.filter((mutant) => only.length === 0 || only.includes(mutant.name));
for (const name of only)
  if (!MUTANTS.some((mutant) => mutant.name === name)) throw new Error(`no mutant is named ${name}`);
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
const out = process.env.MUTANT_OUT ?? join(mkdtempSync(join(tmpdir(), 'bench-mutants-')), 'mutants.txt');
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${out}`);
process.exit(caught === selected.length ? 0 : 1);
