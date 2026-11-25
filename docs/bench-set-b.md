# Set B pre-registration

Registered before any Set B run. Source: `docs/plans/agent-works-plan.md`, Phase 3 ticket P3-1. Code: `bench/setb/`. The G1 thresholds in `bench/report.ts` do not change.

## Why Set B changed

The old rule was "passes when the operator merges unchanged". Root now merges, so that is self-graded. Set B now uses real open issues of FiatFour/ai-office itself, real CI on the public repo, and a blind judge that is not the factory reviewer.

## Tasks

- N=10 single-item fixes drawn from issues #7 to #24, #29 and #30, frozen in `bench/setb/tasks.json`.
- Frozen sha256 (file bytes): `7845542621c5370f56513b0ac4183cb7ab10e48beca6a3cd4ffe15ff5a0c187f`, recorded in `bench/setb/tasks.sha256`. `node bench/setb/cli.ts check` refuses a list that no longer matches it. Frozen at main `395456229b9c84e70defdc9447acb48c85ff6a69`.
- The picker is not the runner. Picking ran by hand against the issues and the ticket file lists (`bench/setb/owned.ts`). The loader refuses a task whose source file, test file or test command names a path a wave 2 ticket owns, a task whose tests need a container engine, an issue outside the range, and a list that is not exactly 10.
- Every item was checked against main on 2026-11-24. `reproduced` means a probe showed the bug; `read` means the code read open and no probe ran. Issues #8, #9 and #7 F5 were dropped: already fixed on main.
- Round 2 replaced `contents-over-1mb` (#16 M5): its test, `server/test/githost.contract.test.ts`, belongs to P3-5. The replacement is `testside-bare-literals` (#20 item 1, `bench/testside.ts`, `read`: `LITERAL` still matches only `./` and `../` strings on main).
- The 10 tasks come from 6 issues (#7, #14, #16, #20, #21, #22), because the remaining open issues belong to wave 2 files. Two tasks share `bench/scratch.ts` (`scratch-owner-pin`, `scratch-run-refs`). "At most one PR per issue" is read as one merged PR per task. Root may overrule before P3-2 starts.

## Arms and PRs

- Tasks that edit the same file, all in the frozen list: `testside-bare-literals` and `suspect-global-symbols` both edit `bench/testside.ts`; `scratch-owner-pin` and `scratch-run-refs` both edit `bench/scratch.ts`. Four tasks add tests to `bench/test/closure.test.ts` (`testside-bare-literals`, `suspect-global-symbols`, `drive-like-names`, `typechange-order`), and two to `bench/test/factory.test.ts` (`scratch-owner-pin`, `scratch-run-refs`). P3-2 runs overlapping tasks in sequence, each on a fresh base, so their PRs cannot conflict.

- Factory and single-session baseline get the same tasks. Both open a PR against FiatFour/ai-office. P3-2 runs them.
- A PR that touches `.github/**` (or a root or `docs/` `CODEOWNERS`) fails at grading: `grade` reads the whole PR file list, every page, with both names of a rename, and `gradeSetB` fails on `touchesWorkflows`. Before push, the host's own allowlist already refuses a tree write into any hidden path (`filePathProblem` behind `treeProblem` in `server/githost/github.ts`), and `setb.test.ts` tests that choke point. `guardWorkflows` was deleted: no Set B push path exists in `bench/` (P3-2 writes the arms), and a second wrapper that nothing calls only looks like a guard. Neither arm may run Actions in FiatFour/agent-works-scratch.
- Each PR gets a random label `pr-<8 hex>` (`assignLabels`). The key (label to task, arm, PR, ready head sha) is sealed in a file the judge never reads. The list is ordered by label, not by arm.

## Judge

- A fresh verifier per PR: `claude -p --model opus --effort xhigh --tools "" --no-session-persistence`. Never the factory reviewer. It gets the issue item, the diff and the CI result. `renderPrompt` shows no label, head sha, branch, arm or PR number, and `buildPacket` refuses a diff or issue text that holds a co-author trailer, a `Claude-Session:` line, the agent mail address, a generated-by line, or one of the PR's own strings (its branch, the ticket id in the branch, its labels, read from the PR by `fetchPacket`). No generic branch pattern: a test file may honestly contain `aw/bench/t-0a1b2c3d-r1`. A refusal hits that packet only. The judge run records it as `unreadable` (reason `unreadable by leak`) and `grade` scores that PR a fail with the reason in the note.
- Fixed rubric (`bench/setb/rubric.ts`): MERGE AS IS, MERGE AFTER EDITS (the edit as a diff block), REJECT. Only the final non-empty line of the reply is the verdict (bold, backticks, a heading or quote mark, a trailing period, any case and CRLF are read). If that line carries several verdicts, the strictest wins. A reply with an earlier line that states a verdict is unreadable: the word `verdict` (any case, zero-width characters and fullwidth forms folded, or the Thai `คำตัดสิน`) followed by a colon, or a verdict name within 40 characters of that word (`Final verdict: REJECT`, `**VERDICT**: REJECT`, `VERDICT : REJECT`, `my verdict is to REJECT`). So is a final line that is not a verdict, or that sits inside an open code fence (a truncated diff line such as `-VERDICT: MERGE AS IS`; `-` is not a decoration character). The rubric text holds no parseable verdict line itself. A diff block that only quotes the original diff is not counted as edit lines. A reply with no verdict, or edits without a diff, is unreadable.
- One bad packet never kills the batch. Each packet gets at most 3 judge calls (the first and two reruns, `MAX_ATTEMPTS`), for an unreadable reply or a failed `claude` call. **Retry rule:** a packet that reached MERGE AS IS only after an earlier reply was unreadable (not a failed call, which has no reply) is graded a fail, recorded as `unreadable` with that reason, because a fresh draw after an unreadable first reply could otherwise only move toward a merge. The number of judge calls is kept as `attempts` and shown in the graded row note (`judge calls: N`), in `judgeAttempts` and in the report column `judge calls`. After that the packet is recorded as `unreadable` with the reason and the attempt count, and the verdicts already obtained are written. A `gh` failure while building a packet (a compare 404 on a force-pushed-away ready sha, more than 100 check runs) records that packet as `unreadable by fetch` the same way. `grade` scores an unreadable PR a fail with the reason in the note. On a seeded-bad PR, three failed attempts void the run.
- A void ends Set B at the third one (`MAX_VOIDS` = 3): each void is logged to one fixed file, `<dir>/voids/<sha256 of tasks.json>.log`, which does not depend on `--out`, and `judge` refuses to run once that log holds 3 lines. `judge` also refuses an `--out` that already exists, and never overwrites it, so each rerun names a new file. So at most 2 reruns after a void; a third void means Set B is reported as not run.
- Calibration: the same batch holds 2 seeded-bad PRs (`bench/setb/calibration/seeded.json`: a fix that deletes the drive-path guard, a fix that hard-codes the two example inputs; both CI green on the frozen base: seeded PR 0 also deletes the one `closure.test.ts` case it breaks, as a real bad PR would, and the seeded CI note shows 18 checks, the count of a green head of main, `0b20542`: 18 completed, 18 success. The frozen base itself was not green: 14 success, 1 failure, 3 cancelled). The seeded PRs are built to look real: the issue text comes from `tasks.json`, the CI note comes from `ciFrom`, and the diffs are `git diff` output that `git apply --check` accepts on the frozen base (a test checks it). If the judge returns anything but REJECT for either (MERGE AS IS or MERGE AFTER EDITS), or cannot be read on either, the whole run is void and rerun. This is stricter than the ticket, which would void only on MERGE AS IS: no machine can decide whether a judge's edit repairs the planted defect, so any non-REJECT is treated as a pass. It is cheaper than a loose calibration that lets a soft judge through.

## Pass rule

A PR passes iff all hold at the ready head sha:

1. CI is green (all check runs completed, none failed, at least one success).
2. The judge said MERGE AS IS.
3. The head did not move: the PR head, the judged head and the CI head all equal the ready head sha.
4. The PR touches nothing under `.github/`.

MERGE AFTER EDITS is a fail, with the edit lines recorded. A moved head is a fail. Root merges at most one PR per task, the judge's pick. A PR that is not merged still counts by this rule, so the pass rate does not depend on which twin root picks.

## Columns

Per row (`bench/model.ts`): `editLines`, `judgeMinutes`, `rootMinutes`, `inferredWindows`, next to the existing `humanMinutes` (operator, expected 0). `bench/report.ts` shows them per task and arm. The Human minutes verdict uses operator minutes against the threshold of 10; root and judge wall minutes are printed beside it, separately, never summed in. A Set B baseline pass rate line (INFO, no bar) sits next to the factory verdicts. The baseline line and the new columns appear only when live Set B rows exist: `node bench/report.ts` on the Set A rows is byte identical to `bench/results/report-set-a.md`, and `bench/setb/test/report.test.ts` diffs it against that file.

## Cost

Threshold unchanged: at most 1 five-hour window per 5 merged PRs. Windows are n/a today, so each row records tokens and `inferredWindows = tokens / tokensPerWindow`. `tokensPerWindow` comes from `bench/setb/window.json`, which holds one measured calibration window and is `null` until someone measures it; with `null` the cost verdict stays UNMEASURED. A verdict from inferred windows says "(inferred from tokens)". Estimate before any run: about 15M tokens, 4 to 8 windows over 1 to 2 days (inferred from Set A: 6.9M tokens for 20 runs, real issues 2 to 3 times bigger).

## Run it

```
node bench/setb/cli.ts check
node bench/setb/cli.ts label --entries entries.json --key key.json
AW_BENCH_LOGIN_CONFIRMED=1 node bench/setb/cli.ts judge --key key.json --out judged.json --home <login home>
node bench/setb/cli.ts grade --key key.json --judged judged.json --label pr-xxxxxxxx --out rows.jsonl --operator-minutes 0 --root-minutes N
node bench/report.ts rows.jsonl
```

`entries.json` lists `{task, arm, pr, readyHeadSha}` and is the record of the ready head. `label` and `judge` and `check` all load the frozen list. `judge` builds every packet itself: the issue text from `tasks.json`, the diff from GitHub's compare of the PR base to `readyHeadSha` (so the diff is that head's, even if the PR moved), and the CI from the check runs of `readyHeadSha`. The CI `sha` is the head the check runs report, and a mismatch fails at grading. There is no hand-written `packets.json`. `grade` reads the PR head, the check runs and every page of the PR file list from GitHub with `gh`.

## Limits

- The judge is a model, not a maintainer. An operator spot-check of 3 merged PRs is optional and never blocks.
- The judge run, the calibration run and the window calibration have not been run: they spend subscription quota and need the bench login. The code paths are covered by tests with a fake model.
- The `host-hidden-path-allowed` mutant is anchored on the signature of `filePathProblem` in `server/githost/host.ts`, not its body, so a P3-5 edit inside it does not break the mutant. A rename of that function would, and the mutant then fails with `pattern not found`.
- The `git apply --check` test needs the frozen commit. A clone that lacks it (CI checks out at depth 1) fetches that one commit with `git fetch --depth=1 origin <sha>` into a scratch repo; if the fetch fails the test fails loudly. It never falls back to the working tree, and no environment variable weakens it.
- `bench/test/mutants.mjs` is not extended: P3-4 owns it. The Set B mutants run with `node bench/setb/mutants.mjs` and need a CI job line in `ci.yml` (P3-4).
- #31 b: a failed arm's row note now keeps the tail of the message (about 300 characters, ending where the malformed verdict sits) and the whole message goes to `<out>.errors.log`. The 500-character head excerpt cut inside `server/agents/claude-code.ts` belongs to P3-5.
