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
