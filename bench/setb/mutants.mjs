import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETB = 'bench/setb/test/setb.test.ts';
const REPORT = 'bench/setb/test/report.test.ts';
const SETUP = 'bench/test/task-setup.test.ts';
const T = 'bench/setb/task.ts';
const G = 'bench/setb/guard.ts';
const L = 'bench/setb/labels.ts';
const R = 'bench/setb/rubric.ts';
const P = 'bench/setb/packet.ts';
const J = 'bench/setb/judge.ts';
const O = 'bench/setb/outcome.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[string, string, string]>, tests: string[] }>} */
const MUTANTS = [
  {
    name: 'frozen-sha-unchecked',
    claim: 'a task list edited after the freeze is refused',
    edits: [[T, 'if (shaOf(bytes) !== frozen)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'frozen-size-unchecked',
    claim: 'Set B has exactly ten tasks',
    edits: [[T, 'if (tasks.length !== SET_B_SIZE)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'task-owned-file-allowed',
    claim: 'a task on a file a wave 2 ticket owns is refused',
    edits: [[T, 'if (owner !== null) throw', 'if (false) throw']],
    tests: [SETB],
  },
  {
    name: 'task-docker-allowed',
    claim: 'a task whose tests need a container engine is refused',
    edits: [[T, "if (DOCKER.test(testCommand.join(' ')))", 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'task-any-issue',
    claim: 'a task must come from issues 7 to 24, 29 or 30',
    edits: [[T, "typeof issue !== 'number' || !ISSUES.has(issue)", 'false']],
    tests: [SETB],
  },
  {
    name: 'task-repeat-allowed',
    claim: 'one issue item is one task',
    edits: [[T, 'if (seen.has(t.id) || seen.has(key))', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'guard-case-sensitive',
    claim: 'the .github check folds case',
    edits: [[G, '.toLowerCase()', '']],
    tests: [SETB],
  },
  {
    name: 'guard-no-normalize',
    claim: 'the .github check resolves dot segments',
    edits: [[G, "posix.normalize(path.replace(/\\\\/g, '/'))", "path.replace(/\\\\/g, '/')"]],
    tests: [SETB],
  },
  {
    name: 'guard-backslash',
    claim: 'the .github check reads a backslash path',
    edits: [[G, "posix.normalize(path.replace(/\\\\/g, '/'))", 'posix.normalize(path)']],
    tests: [SETB],
  },
  {
    name: 'guard-prefix-only',
    claim: 'only the .github directory counts, not a name that starts with it',
    edits: [[G, "rel.startsWith('.github/')", "rel.startsWith('.github')"]],
    tests: [SETB],
  },
  {
    name: 'labels-in-arm-order',
    claim: 'the label list is ordered by label, so its order does not show the arm',
    edits: [[L, 'return sealed.sort((a, b) => (a.label < b.label ? -1 : 1));', 'return sealed;']],
    tests: [SETB],
  },
  {
    name: 'labels-collide',
    claim: 'a label that repeats is drawn again',
    edits: [[L, 'while (used.has(label));', 'while (false);']],
    tests: [SETB],
  },
  {
    name: 'rubric-first-verdict-wins',
    claim: 'the strictest verdict wins when a reply disagrees with itself',
    edits: [[R, '(STRICTNESS[b] > STRICTNESS[a] ? b : a)', 'a']],
    tests: [SETB],
  },
  {
    name: 'rubric-edits-without-diff',
    claim: 'MERGE AFTER EDITS needs the edit as a diff',
    edits: [[R, 'if (editLines === 0) throw', 'if (false) throw']],
    tests: [SETB],
  },
  {
    name: 'rubric-quoted-verdict',
    claim: 'a verdict inside prose is not a verdict line',
    edits: [[R, '/^[ \\t]*\\*{0,2}[ \\t]*VERDICT:', '/[ \\t]*\\*{0,2}[ \\t]*VERDICT:']],
    tests: [SETB],
  },
  {
    name: 'rubric-header-lines-count',
    claim: 'file headers of an edit diff are not edit lines',
    edits: [[R, '&& !/^(\\+\\+\\+|---)/.test(l)', '']],
    tests: [SETB],
  },
  {
    name: 'packet-leak-allowed',
    claim: 'a diff that names the branch or an arm label never reaches the judge',
    edits: [[P, 'if (seen.length > 0) throw', 'if (false) throw']],
    tests: [SETB],
  },
  {
    name: 'prompt-shows-head',
    claim: 'the prompt carries no head sha',
    edits: [[P, '    p.ci.note,', '    p.ci.note, p.headSha,']],
    tests: [SETB],
  },
  {
    name: 'prompt-shows-label',
    claim: 'the prompt carries no label',
    edits: [[P, "'## Diff',", "'## Diff', p.label,"]],
    tests: [SETB],
  },
  {
    name: 'calibration-off',
    claim: 'a judge that passes a seeded-bad PR voids the run',
    edits: [[J, 'if (passed.length > 0)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'calibration-edits-passes',
    claim: 'MERGE AFTER EDITS on a seeded-bad PR voids the run, since no machine decides whether the edit repairs it',
    edits: [[J, "j.verdict !== 'REJECT'", "j.verdict === 'MERGE AS IS'"]],
    tests: [SETB],
  },
  {
    name: 'calibration-unreadable-ignored',
    claim: 'an unreadable reply on a seeded-bad PR voids the run',
    edits: [[J, 'if (bad.has(packet.label))', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'calibration-seeded-in-results',
    claim: 'seeded-bad PRs never reach the results',
    edits: [[J, 'judged: all.filter((j) => !bad.has(j.label))', 'judged: all']],
    tests: [SETB],
  },
  {
    name: 'calibration-size-unchecked',
    claim: 'the judge is calibrated on exactly two seeded-bad PRs',
    edits: [[J, 'if (seeded.length !== CALIBRATION_SIZE)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'judge-has-tools',
    claim: 'the judge runs with no tools',
    edits: [[J, "'--tools',\n  '',", "'--tools',\n  'default',"]],
    tests: [SETB],
  },
  {
    name: 'outcome-head-moved-ignored',
    claim: 'a head that moved before grading is a fail',
    edits: [[O, 'if (g.pull.head.sha !== ready)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'outcome-judged-other-head',
    claim: 'the judgement must be of the ready head',
    edits: [[O, 'else if (read.headSha !== ready)', 'else if (false)']],
    tests: [SETB],
  },
  {
    name: 'outcome-ci-other-head',
    claim: 'the CI result must be of the ready head',
    edits: [[O, 'if (g.ci.sha !== ready)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'outcome-ci-not-green-passes',
    claim: 'CI that is not green is a fail',
    edits: [[O, "if (g.ci.state !== 'green')", 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'outcome-edits-pass',
    claim: 'MERGE AFTER EDITS is a fail with its edit lines recorded',
    edits: [[O, "if (read?.verdict === 'MERGE AFTER EDITS') out.push", 'if (false) out.push']],
    tests: [SETB],
  },
  {
    name: 'outcome-reject-passes',
    claim: 'a REJECT is a fail',
    edits: [[O, "if (read?.verdict === 'REJECT')", 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'outcome-workflow-passes',
    claim: 'a PR that touches .github is a fail',
    edits: [[O, 'if (flows.length > 0)', 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'ci-skipped-is-green',
    claim: 'checks that were all skipped are not green',
    edits: [[O, "if (!runs.some((r) => r.conclusion === 'success'))", 'if (false)']],
    tests: [SETB],
  },
  {
    name: 'ci-pending-is-green',
    claim: 'unfinished checks are not green',
    edits: [[O, "runs.some((r) => r.status !== 'completed')", 'false']],
    tests: [SETB],
  },
  {
    name: 'ci-failure-is-green',
    claim: 'a failed check makes CI red',
    edits: [[O, "'failure', 'cancelled'", "'cancelled'"]],
    tests: [SETB],
  },
  {
    name: 'windows-guessed',
    claim: 'windows are inferred only from a measured calibration window',
    edits: [[O, 'tokens === null || calibration.tokensPerWindow === null ? null', 'tokens === null ? null']],
    tests: [SETB],
  },
  {
    name: 'note-keeps-the-head',
    claim: 'a long failure note keeps its tail',
    edits: [['bench/run.ts', 'flat.slice(-(NOTE_MAX - 1))', 'flat.slice(0, NOTE_MAX - 1)']],
    tests: [SETUP],
  },
  {
    name: 'failure-not-logged',
    claim: 'the whole failure message goes to the run log',
    edits: [['bench/run.ts', 'ctx.log?.(', 'void (']],
    tests: [SETUP],
  },
  {
    name: 'report-inferred-unlabelled',
    claim: 'windows inferred from tokens say so',
    edits: [['bench/report.ts', "' (inferred from tokens)'", "''"]],
    tests: [REPORT],
  },
  {
    name: 'report-baseline-in-factory',
    claim: 'the baseline Set B rows stay out of the factory verdict',
    edits: [
      [
        'bench/report.ts',
        "const setB = factory.filter((r) => r.set === 'B');",
        "const setB = rows.filter((r) => r.set === 'B');",
      ],
    ],
    tests: [REPORT],
  },
  {
    name: 'report-root-minutes-are-judge-minutes',
    claim: 'root minutes and judge minutes are reported as two numbers',
    edits: [
      [
        'bench/report.ts',
        'const root = meanOf(rows, (r) => r.rootMinutes ?? null);',
        'const root = meanOf(rows, (r) => r.judgeMinutes ?? null);',
      ],
    ],
    tests: [REPORT],
  },
  {
    name: 'packet-generic-branch-refused',
    claim: 'an honest diff that holds a branch-like string is judged; only the PR own branch is refused',
    edits: [
      [
        'bench/setb/packet.ts',
        'const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [',
        "const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [\n  ['a branch name', /\\baw\\/[\\w.-]+\\/[\\w.-]+/],",
      ],
    ],
    tests: [SETB],
  },
  {
    name: 'packet-session-trailer-dropped',
    claim: 'a Claude-Session trailer never reaches the judge',
    edits: [['bench/setb/packet.ts', '/Claude-Session:/i', '/Claude-Sessionx:/i']],
    tests: [SETB],
  },
  {
    name: 'packet-agent-mail-dropped',
    claim: 'the agent mail address never reaches the judge',
    edits: [['bench/setb/packet.ts', 'noreply@anthropic', 'noreply@anthropicx']],
    tests: [SETB],
  },
  {
    name: 'packet-leak-aborts-batch',
    claim: 'a leak makes one packet unreadable and does not abort the batch',
    edits: [['bench/setb/packet.ts', 'if (!(error instanceof TaskRefused)) throw error;', 'throw error;']],
    tests: [SETB],
  },
  {
    name: 'judge-unreadable-dropped',
    claim: 'an unreadable real packet is surfaced in the judge run',
    edits: [['bench/setb/judge.ts', '!bad.has(j.label)), unreadable };', '!bad.has(j.label)), unreadable: [] };']],
    tests: [SETB],
  },
  {
    name: 'judge-unreadable-label-unchecked',
    claim: 'an unreadable packet cannot share a label with another',
    edits: [['bench/setb/judge.ts', '...seeded, ...unreadable].map', '...seeded].map']],
    tests: [SETB],
  },
  {
    name: 'judge-diff-not-passed',
    claim: 'the verdict reader sees the packet diff, so a quoted diff is not an edit',
    edits: [['bench/setb/judge.ts', 'parseVerdict(reply, packet.diff)', 'parseVerdict(reply)']],
    tests: [SETB],
  },
  {
    name: 'outcome-ci-sha-asked',
    claim: 'the CI sha is the one the runs report, not the one that was asked for',
    edits: [['bench/setb/outcome.ts', 'const sha = shaOfRuns(asked, runs);', 'const sha = asked;']],
    tests: [SETB],
  },
  {
    name: 'outcome-ci-mixed-heads',
    claim: 'check runs of two heads are not one CI result',
    edits: [['bench/setb/outcome.ts', ": 'mixed';", ': asked;']],
    tests: [SETB],
  },
  {
    name: 'outcome-unreadable-passes',
    claim: 'a PR the judge could not read is a fail',
    edits: [['bench/setb/outcome.ts', 'if (read === null) out.push(', 'if (false) out.push(']],
    tests: [SETB],
  },
  {
    name: 'outcome-first-page-only',
    claim: 'the whole PR file list is read, past file 100',
    edits: [['bench/setb/outcome.ts', 'if (files.length < PAGE) return paths;', 'return paths;']],
    tests: [SETB],
  },
  {
    name: 'outcome-rename-source-dropped',
    claim: 'the previous name of a renamed file is checked too',
    edits: [['bench/setb/outcome.ts', '...(f.previous_filename === undefined ? [] : [f.previous_filename])', '...[]']],
    tests: [SETB],
  },
  {
    name: 'guard-dot-dot-escape',
    claim: 'a path that climbs above the root and into .github is refused',
    edits: [['bench/setb/guard.ts', ".replace(/^(\\.\\.\\/)+/, '')", '']],
    tests: [SETB],
  },
  {
    name: 'guard-codeowners',
    claim: 'a root or docs CODEOWNERS is refused',
    edits: [['bench/setb/guard.ts', '|| PROTECTED.has(rel)', '']],
    tests: [SETB],
  },
  {
    name: 'host-hidden-path-allowed',
    claim: 'the host refuses a tree write into .github before it is sent',
    edits: [['server/githost/host.ts', "!segment.startsWith('.') &&", '']],
    tests: [SETB],
  },
  {
    name: 'rubric-bold-verdict',
    claim: 'a bold verdict line is read',
    edits: [['bench/setb/rubric.ts', '\\*{0,2}[ \\t]*VERDICT:', '[ \\t]*VERDICT:']],
    tests: [SETB],
  },
  {
    name: 'rubric-crlf-block',
    claim: 'a diff block with CRLF line ends is read',
    edits: [['bench/setb/rubric.ts', '```diff[ \\t]*\\r?\\n', '```diff\\n']],
    tests: [SETB],
  },
  {
    name: 'rubric-quote-counted',
    claim: 'a block that quotes the original diff is not an edit',
    edits: [['bench/setb/rubric.ts', 'quotesOriginal(body, original) ? n : n +', 'false ? n : n +']],
    tests: [SETB],
  },
  {
    name: 'rubric-quote-crlf',
    claim: 'a CRLF quote of the original diff is not an edit',
    edits: [['bench/setb/rubric.ts', 'const LINES = /\\r?\\n/;', 'const LINES = /\\n/;']],
    tests: [SETB],
  },
  {
    name: 'task-test-file-owned-allowed',
    claim: 'a task whose test file a wave 2 ticket owns is refused',
    edits: [['bench/setb/task.ts', '[...files, ...testCommand]', 'files']],
    tests: [SETB],
  },
  {
    name: 'fetch-diff-at-pr-head',
    claim: 'the diff is read at the ready head, not at the PR head now',
    edits: [
      ['bench/setb/fetch.ts', 'hub.diff(repo, pull.base.sha, ready)', 'hub.diff(repo, pull.base.sha, pull.head.sha)'],
    ],
    tests: [SETB],
  },
  {
    name: 'fetch-pr-labels-not-secret',
    claim: 'the PR own labels are checked for a leak',
    edits: [['bench/setb/fetch.ts', '...pull.labels.map((l) => l.name),', '']],
    tests: [SETB],
  },
  {
    name: 'fetch-ticket-id-not-secret',
    claim: 'the PR own ticket id is checked for a leak',
    edits: [['bench/setb/fetch.ts', '...(pull.head.ref.match(/t-[0-9a-f]{8}/g) ?? []),', '']],
    tests: [SETB],
  },
  {
    name: 'seeded-title-prefixed',
    claim: 'a seeded PR carries the task issue title as tasks.json has it',
    edits: [
      [
        'bench/setb/cli.ts',
        'issue: { title: task.title, body: task.body },',
        "issue: { title: '#7 ' + task.title, body: task.body },",
      ],
    ],
    tests: [SETB],
  },
  {
    name: 'seeded-ci-note-invented',
    claim: 'a seeded PR carries a CI note in the format ciFrom writes',
    edits: [['bench/setb/cli.ts', 'ci: ciFrom(sha, runs),', "ci: { sha, state: 'green', note: 'all checks passed' },"]],
    tests: [SETB],
  },
  {
    name: 'cli-label-unfrozen',
    claim: 'label reads the frozen task list',
    edits: [
      [
        'bench/setb/cli.ts',
        'const list = loadFrozen(values.dir);\n    const entries',
        'const list = { tasks: [] };\n    const entries',
      ],
    ],
    tests: [SETB],
  },
  {
    name: 'cli-judge-unfrozen',
    claim: 'judge reads the frozen task list',
    edits: [
      [
        'bench/setb/cli.ts',
        'const list = loadFrozen(values.dir);\n    const key',
        'const list = { tasks: [] };\n    const key',
      ],
    ],
    tests: [SETB],
  },
  {
    name: 'report-setb-columns-always',
    claim: 'Set A output carries no Set B column',
    edits: [['bench/report.ts', 'hasSetB(rows) ? columns : columns.filter((c) => c.setB !== true)', 'columns']],
    tests: [REPORT],
  },
  {
    name: 'report-baseline-line-always',
    claim: 'Set A output carries no Set B baseline line',
    edits: [['bench/report.ts', '...(hasSetB(live(all))', '...(true']],
    tests: [REPORT],
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
for (const name of only) if (!MUTANTS.some((m) => m.name === name)) throw new Error(`no mutant is named ${name}`);
const selected = MUTANTS.filter((m) => only.length === 0 || only.includes(m.name));
const originals = new Map();
const restore = () => {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
const lines = [];
let caught = 0;
for (const mutant of selected) {
  let line;
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
      if (!current.includes(find)) throw new Error(`pattern not found in ${file}: ${find}`);
      writeFileSync(path, current.replace(find, replace));
    }
    const ran = vitest(mutant.tests);
    const survived = ran.status === 0;
    const broken = ran.status === null || ran.error !== undefined;
    if (!survived && !broken) caught += 1;
    line = `${survived ? 'BAD ' : broken ? 'ERR  ' : 'OK  '} ${mutant.name}: ${survived ? 'survived' : broken ? 'the test run did not finish' : 'caught'}. Claim: ${mutant.claim}`;
  } catch (error) {
    line = `ERR  ${mutant.name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    restore();
  }
  lines.push(line);
  console.log(line);
}
lines.push(`caught ${caught}/${selected.length}`);
console.log(lines.at(-1));
const out = process.env.MUTANT_OUT ?? join(mkdtempSync(join(tmpdir(), 'setb-mutants-')), 'mutants.txt');
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${out}`);
process.exit(caught === selected.length ? 0 : 1);
