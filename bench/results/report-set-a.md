# Benchmark both

Each cell with several runs reads `median (min to max)`. `n/a` means the run did not record the column. A cell that says `[k missing]` lacks k of its runs.

## Thresholds

Source: operator answer of 2026-11-19, recorded as the P2-1 thresholds in gates.md. Only live, unflagged rows (a real agent or the host) count. Scripted rows are harness checks and sit in their own section. A row flagged contaminated (server-side web search or fetch) or suspect (the PR touches test machinery) is listed in its own section and counts in no verdict. The cost and human-minute checks read Set B factory rows only, the same set that produced the merges.

| check | value | threshold | verdict |
| --- | --- | --- | --- |
| Set A hidden-test pass rate | factory 6 of 10 (60%); baseline 5 of 10 (50%) | no bar set, read next to the baseline | INFO |
| Set B merge rate | no live Set B rows | at least 50% | UNMEASURED |
| Cost | no live Set B rows | at most 1 five-hour window per 5 merged PRs | UNMEASURED |
| Human minutes | no live Set B rows | at most 10 per Set B PR | UNMEASURED |

## Total, live rows

| arm | runs | pass | wall s | tokens | windows | human min |
| --- | --- | --- | --- | --- | --- | --- |
| factory | 10 | 6 | 1267.84 | 4107051 | n/a | n/a |
| baseline | 10 | 5 | 480.07 | 2830362 | n/a | n/a |

## Per task, live rows

| task | set | factory outcome | factory rounds | factory wall s | factory agent s | factory tokens | factory windows | factory human min | baseline outcome | baseline rounds | baseline wall s | baseline agent s | baseline tokens | baseline windows | baseline human min |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| path-to-regexp-336 | A | fail | 0 | 122.49 | 121.41 | 583848 | n/a | n/a | fail | n/a | 55.98 | 54.94 | 265109 | n/a | n/a |
| path-to-regexp-430 | A | fail | 1 | 231.59 | 227.38 | 831746 | n/a | n/a | fail | n/a | 94.53 | 90.44 | 467543 | n/a | n/a |
| path-to-regexp-433 | A | fail | 0 | 107.55 | 105.99 | 334695 | n/a | n/a | fail | n/a | 42.03 | 40.82 | 300624 | n/a | n/a |
| path-to-regexp-441 | A | pass | 0 | 151.43 | 150.15 | 642147 | n/a | n/a | pass | n/a | 70.02 | 68.83 | 497816 | n/a | n/a |
| ufo-174 | A | fail | 0 | 125.50 | 121.99 | 243975 | n/a | n/a | fail | n/a | 39.07 | 36.65 | 237654 | n/a | n/a |
| ufo-214 | A | pass | 0 | 125.46 | 121.20 | 385331 | n/a | n/a | pass | n/a | 44.28 | 42.00 | 260634 | n/a | n/a |
| ufo-221 | A | pass | 0 | 125.70 | 122.51 | 323784 | n/a | n/a | fail | n/a | 38.74 | 36.47 | 235018 | n/a | n/a |
| ufo-241 | A | pass | 0 | 93.43 | 91.20 | 239462 | n/a | n/a | pass | n/a | 30.49 | 28.61 | 198088 | n/a | n/a |
| ufo-282 | A | pass | 0 | 92.85 | 90.99 | 260816 | n/a | n/a | pass | n/a | 30.62 | 28.81 | 171424 | n/a | n/a |
| ufo-283 | A | pass | 0 | 91.84 | 89.80 | 261247 | n/a | n/a | pass | n/a | 34.31 | 32.69 | 196452 | n/a | n/a |

## Flagged rows, excluded from every verdict

None.

## Scripted rows, excluded from every verdict

None.

## Harness overhead

Per task, median over tasks: grading 1.95 s (wall minus agent), prepare 12.83 s (clone, archive, install, base check). The plan metric counts both, 15.94 s against 60 s: PASS.

