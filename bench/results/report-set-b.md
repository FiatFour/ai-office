# Set B report and G2 verdict (2026-11-28)

**G2 verdict: FAIL.** The factory arm passed 3 of 10 tasks (30%) against a bar of at least 50%. The baseline (one Claude Code session, no review) passed 4 of 10 (40%). By the plan's rule, wave 3 does not open and one factory-fix ticket is opened.

The verdict follows the rules registered before the run. The merge-rate result is not robust: the sensitivity table below shows the factory reaching the bar under another reading. Even then G2 would not pass, because it also needs the cost threshold and cost is UNMEASURED.

## Why each arm failed

| task | factory | baseline |
| --- | --- | --- |
| check-sources-all-links | pass (#53) | judge rejects (#54) |
| repo-id-edges | pass (#59) | pass (#58) |
| garbage-hq-db | pass (#60) | pass (#61) |
| testside-bare-literals | judge wants 18 edit lines (#64) | CI red, probably flaky; judge also rejects (#62) |
| entity-encoded-mentions | judge wants 3 edit lines (#65) | CI red, its own mutant anchors; judge wants 2 edit lines (#66) |
| suspect-global-symbols | judge could not read it (#69) | judge could not read it (#67) |
| drive-like-names | 180 min limit, CI red, probably flaky (#70) | judge wants 7 edit lines (#72) |
| typechange-order | 180 min limit, CI red, probably flaky (#74) | pass (#73) |
| scratch-owner-pin | 180 min limit, CI red: its own mutant anchor, plus a probable flake (#75) | CI red, same mutant anchor; judge rejects (#76) |
| scratch-run-refs | 180 min limit, CI red, probably flaky (#78) | pass (#77) |

- "Probably flaky" is an inference: a test timeout in a file or area the diff does not explain. No CI job was rerun, so none is proven. Tracked in #71.
- The factory is never told that CI failed. It waits for green until the 180 min limit. All four factory time-outs are this.
- #67 and #69 are a harness limit. The judge's leak guard refuses a packet that holds one of the PR's own labels, and every bench PR of both arms is labelled `aw-bench`. The text is also in this repository's `bench/testside.ts` (`.aw-bench`), on unchanged context lines that any change to that list carries, so this task could not be judged for either arm. Both are scored fail. Both had green CI.

## Sensitivity

| reading | factory | baseline |
| --- | --- | --- |
| Registered rules (the verdict) | 3 of 10 (30%) | 4 of 10 (40%) |
| Drop the four probably flaky arms (#62, #70, #74, #78) | 3 of 7 (43%) | 4 of 9 (44%) |
| Drop all four tasks that hold such an arm | 3 of 6 (50%) | 2 of 6 (33%) |
| Upper bound: the unread or flaky arms all pass (factory #69, #70, #74, #78; baseline #67) | 7 of 10 (70%) | 5 of 10 (50%) |

Only the first row was registered. The others were chosen after seeing results. The upper bound is not an estimate: the judge never saw #70, #74, #78, #69 or #67. #62 stays a fail there because the judge rejected it. #75 stays a fail because its CI failure is real.

## Cost and effort

- Cost is UNMEASURED: `bench/setb/window.json` has no calibration window.
- On the six tasks where the factory recorded tokens, it used 2.65M against the baseline's 1.86M (1.43 times). Timed-out arms recorded no tokens, so the real factory total is higher.
- Wall time is not comparable between arms (see below).
- `root min` in the tables is **not measured**. The 0 is a placeholder.
- `human min` is **not measured** either: `grade-all` writes 0 for operator minutes. The PASS rests on no operator having worked on a bench PR. It does not count the operator logging the bench account in again after expired tokens.

## Deviations and disclosures

- **Root was not blind.** `docs/bench-set-b.md` says root must not read PR pages, commit lists or reviews before judging. Root read #53's review bodies and commit list, the review counts or file lists of #63, #68, #70 and #74, and the changed file list of #75. Root also read CI results and logs during the run. The judge is a separate `claude -p` session and received none of this.
- Two factory attempts were discarded as `aborted` after GitHub returned HTTP 500 on a check-runs read (#63, testside-bare-literals; #68, suspect-global-symbols). Neither had a review posted. Each was rerun once, with the reason in `runs.jsonl`. The head of the discarded #68 attempt later went red on the probably flaky Windows hooks; the rerun was approved before that job finished, and its replacement (#69) was green.
- Two arms stopped as `auth` on an expired token (check-sources-all-links factory, scratch-owner-pin factory) and ran again after a new login.
- The stop rule was amended after stage 1 and before stage 2 (#56). No stage 1 result changed.
- The factory reviewer cage cannot fetch the PR head (#55), so `vega` reviewed a stale checkout and could not run tests at the head. This weakens the factory's review rounds.
- The judge run was not void with its two seeded calibration packets. 14 results were judged and 2 were unreadable.
- No bench PR has been merged. The P3-2 ticket says to merge winners; root left them all open as benchmark output. The ticket's check that HQ made no merge call was not re-verified from the API log; GitHub shows no merged bench PR.
- The tables show factory review rounds as `n/a`; `runs.jsonl` records them (0 or 1). A timed-out arm's row note says `no PR to grade` although its PR exists.
- The raw host API logs (13 MB) are kept outside the repository.

## Data

`bench/results/setb/` holds `runs.jsonl`, `rows.jsonl`, `entries.json` and `key.json`. `bench/setb/judged/judged.json` holds the judge output. Everything below is the output of `node bench/report.ts bench/results/setb/rows.jsonl`.

---

# Benchmark rows

Each cell with several runs reads `median (min to max)`. `n/a` means the run did not record the column. A cell that says `[k missing]` lacks k of its runs.

## Thresholds

Source: operator answer of 2026-11-19, recorded as the P2-1 thresholds in gates.md. Only live, unflagged rows (a real agent or the host) count. Scripted rows are harness checks and sit in their own section. A row flagged contaminated (server-side web search or fetch) or suspect (the PR touches test machinery) is listed in its own section and counts in no verdict. The cost and human-minute checks read Set B factory rows only, the same set that produced the merges.

| check | value | threshold | verdict |
| --- | --- | --- | --- |
| Set A hidden-test pass rate | no live rows | no bar set, read next to the baseline | UNMEASURED |
| Set B merge rate | 3 of 10 (30%) | at least 50% | FAIL |
| Cost | quota windows not recorded | at most 1 five-hour window per 5 merged PRs | UNMEASURED |
| Human minutes | 0 per Set B PR (10 PRs) | at most 10 per Set B PR | PASS |
| Set B baseline pass rate | 4 of 10 (40%) | no bar set, read next to the factory | INFO |

## Total, live rows

| arm | runs | pass | wall s | CI wait s | tokens | windows | human min |
| --- | --- | --- | --- | --- | --- | --- | --- |
| factory | 10 | 3 | 51855.81 | 11095 | n/a | n/a | 0 |
| baseline | 10 | 4 | 708.63 | 0.28 | 3599693 | n/a | 0 |

`wall s` is not agent time, and the two arms cannot be compared on it: the factory waits for GitHub CI inside it, while the baseline ends when its PR is opened and waits for none. `CI wait s` is the part of `wall s` during which a check run of the arm's PR was running, from the check-run timestamps on GitHub. Where it reads `n/a`, `wall s` may still hold a CI wait of unknown length.

## Per task, live rows

| task | set | factory outcome | factory rounds | factory wall s | factory CI wait s | factory agent s | factory tokens | factory windows | factory windows (inferred) | factory human min | factory edit lines | factory judge min | factory judge calls | factory root min | baseline outcome | baseline rounds | baseline wall s | baseline CI wait s | baseline agent s | baseline tokens | baseline windows | baseline windows (inferred) | baseline human min | baseline edit lines | baseline judge min | baseline judge calls | baseline root min |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| check-sources-all-links | B | pass | n/a | 1907.08 | 1733 | 0 | 627377 | n/a | n/a | 0 | 0 | 0.42 | 1 | 0 | fail | n/a | 50.28 | 0 | 0 | 310287 | n/a | n/a | 0 | 0 | 0.73 | 1 | 0 |
| drive-like-names | B | fail | n/a | 10800.87 | 849 | 0 | n/a | n/a | n/a | 0 | 0 | n/a | n/a | n/a | fail | n/a | 51.17 | 0 | 0 | 336401 | n/a | n/a | 0 | 7 | 0.48 | 1 | 0 |
| entity-encoded-mentions | B | fail | n/a | 940.29 | 840 | 0 | 290186 | n/a | n/a | 0 | 3 | 1.18 | 1 | 0 | fail | n/a | 47.87 | 0 | 0 | 288644 | n/a | n/a | 0 | 2 | 1.98 | 1 | 0 |
| garbage-hq-db | B | pass | n/a | 942.22 | 839 | 0 | 367831 | n/a | n/a | 0 | 0 | 0.84 | 1 | 0 | pass | n/a | 165.78 | 0 | 0 | 330462 | n/a | n/a | 0 | 0 | 0.62 | 1 | 0 |
| repo-id-edges | B | pass | n/a | 1408.20 | 1261 | 0 | 299514 | n/a | n/a | 0 | 0 | 0.64 | 1 | 0 | pass | n/a | 81.18 | 0.28 | 0 | 313656 | n/a | n/a | 0 | 0 | 0.65 | 1 | 0 |
| scratch-owner-pin | B | fail | n/a | 10803.88 | 853 | 0 | n/a | n/a | n/a | 0 | 0 | n/a | n/a | n/a | fail | n/a | 101.56 | 0 | 0 | 430453 | n/a | n/a | 0 | 0 | 0.52 | 1 | 0 |
| scratch-run-refs | B | fail | n/a | 10801.14 | 861 | 0 | n/a | n/a | n/a | 0 | 0 | n/a | n/a | n/a | pass | n/a | 61.30 | 0 | 0 | 539408 | n/a | n/a | 0 | 0 | 0.48 | 1 | 0 |
| suspect-global-symbols | B | fail | n/a | 1222.10 | 1104 | 0 | 330800 | n/a | n/a | 0 | 0 | n/a | n/a | 0 | fail | n/a | 49.74 | 0 | 0 | 354581 | n/a | n/a | 0 | 0 | n/a | n/a | 0 |
| testside-bare-literals | B | fail | n/a | 2228.55 | 1913 | 0 | 731185 | n/a | n/a | 0 | 18 | 1.52 | 1 | 0 | fail | n/a | 43.07 | 0 | 0 | 258207 | n/a | n/a | 0 | 0 | 0.84 | 1 | 0 |
| typechange-order | B | fail | n/a | 10801.50 | 842 | 0 | n/a | n/a | n/a | 0 | 0 | n/a | n/a | n/a | pass | n/a | 56.68 | 0 | 0 | 437594 | n/a | n/a | 0 | 0 | 0.89 | 1 | 0 |

## Flagged rows, excluded from every verdict

None.

## Scripted rows, excluded from every verdict

None.

## Harness overhead

No Set A rows.

