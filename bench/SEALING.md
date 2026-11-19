# What keeps the answer from the agent

Premise 1: the cage and the grader keep the answer out of the agent's reach. The answer is the fix commit, the hidden tests, any later release that carries the fix, and the verdict itself.

Premise 2: the graded verdict is trustworthy when PR-authored code runs in the same tree and the same process as the grader and the tests. This is false in general. A PR can change what the tests load, exit before they report, or patch the assertion library in the process that counts them. The structural closures below remove every channel that does not need the PR's code to run inside the runner. The rest are recorded limits with a heuristic flag.

Each channel is tested directly. A channel with no closure is a recorded limit.

| Channel | Closure | Test |
| --- | --- | --- |
| Network from the cage (git fetch, ls-remote, registry install) | `BenchCage` runs the firewall with `api.anthropic.com` only. Tests run offline from dependencies installed before the run. | `cage-mount.test.ts`, real cage, denials seen for github.com and registry.npmjs.org |
| Package versions | No registry. `installedProblems` refuses an install that holds a copy of the project newer than the base. A copy at the base version, the `.pnpm` ones included, is judged by content: a source file that differs from the same file in the base tree, or a file equal to a hidden test, is refused. Documentation and the built `dist` are not compared. | `closure.test.ts`, `task-setup.test.ts` |
| Git objects | The cage repo is `git archive` of one base commit, re-initialised. Source checks refuse a second commit, a remote or tag ref, a reachable fix commit. | `task-setup.test.ts` |
| Hidden test files | Removed from the source, matched by content in the seal check, copied back only at grading. | `task-setup.test.ts`, `cage-mount.test.ts` |
| Ticket and package metadata | No issue url, github and npm links cut from the body, ticket id is a hash, `repository`, `homepage`, `bugs` removed from package.json. | `arms.test.ts`, `task-setup.test.ts` |
| PR path into the graded tree | Every path is canonicalised once, before it is matched, refused or applied (backslashes to slashes, `.` and `..` segments and trailing slashes resolved, case and Unicode form folded for matching), so the form matched is the form the filesystem acts on. A path that names the root, leaves the tree, is absolute or a drive path, is a directory, or sits under a file grades fail with a note. Refused as a whole PR: node_modules, package and lock files, runner and tsconfig files, `.aw-bench`, paths through a symbolic link. Edits of the spec files are dropped (next row). Deletions and rename sources are applied. | `closure.test.ts` |
| Test-side files the hidden specs load | Every test-side file of the base tree is the grader's, not the PR's: any `*.spec.*`, `*.test.*`, `*-test.*`, `test-*`, `*.snap`, anything under `test`, `tests`, `__tests__`, `__snapshots__`, `__mocks__`, `fixtures` or `e2e`, the hidden files, and every file a runner config imports or names (setup files, global setup). A PR hunk that writes or deletes one is dropped from the graded diff, not applied, so the tree keeps the base file and the hidden overlay goes on top. The rest of the PR is graded. The dropped paths are carried on the grade (`dropped`) and named in the row note (`dropped test-side edits a, b`). A PR that touches only test-side files grades fail with a `nothing to grade` note. A file with the same name before the extension (`cases.spec.js` over `cases.spec.ts`) is dropped too. A test file the PR adds that is not one of these is not applied and does not run. | `closure.test.ts` (path-to-regexp-433 replayed on the real harness, 367 tests and 4 dropped edits) |
| A gutted suite | Verification grades the upstream fix on the harness and refuses the task if it does not pass. It stores the passing-test count in `verified.json`, and a graded run needs at least that many passing tests. | `closure.test.ts`, `task-setup.test.ts` |
| Graded runner and verdict | Runner and config are the base ones. The verdict is the runner's JSON report: every spec file named by the task must appear with a nonzero pass count and no failure, and the exit code must be 0. The node:test reporter counts only real tests. The stand-in test node prints for a file that ended without reporting (`process.exit(0)` in the code under test) counts as a failure. | `closure.test.ts`, `task-setup.test.ts` |
| Live web search and fetch through `api.anthropic.com` | `claude` runs with `--disallowedTools WebSearch,WebFetch`. A row whose stream reports server-side web search or fetch requests (`usage.server_tool_use`, or `server_tool_use` blocks) is flagged `contaminated` and counts in no verdict. | `agents.test.ts`, `closure.test.ts`, `report.test.ts` |
| Forged assertions in the test process | Heuristic only. A static scan of the non-test files a PR adds or changes flags `suspect` when the PR adds an import of vitest, chai, node:test or node:assert, `expect.extend`, `Assertion.prototype`, `process.exit`, `process.reallyExit`, `process.abort`, a use of the test globals on `globalThis`, or a mention of `.aw-bench`. A suspect row counts in no verdict and is listed in the report. | `closure.test.ts`, `report.test.ts` |
| Operator gates | Every non-scripted arm needs a confirmed task and `AW_BENCH_LOGIN_CONFIRMED=1`, with or without `--bin`. | `cli.test.ts` |

## Allowlist decision

A model run needs `api.anthropic.com`. The repo tests run with the dependencies installed into the cage before the run (`prepared.installed/node_modules`, copied by `BenchCage` and kept out of the cage repo index). The registry stays closed. Cost: the agent cannot add a dependency, and a fix that needs one is graded as a failure. Package files are protected in grading for the same reason.

## Recorded limits

- The model may remember the upstream fix from training. No harness closes that.
- README, CHANGELOG and source comments in the base tree can name the upstream project. With no network that only names the repo.
- Code under test runs in the same process as the assertions, the test files and the runner's report writer. Two lines in a source file forge a pass: `expect.extend({ toBe: () => ({ pass: true }) })`, `chai.Assertion.prototype.assert = () => {}`, or a patched `node:assert`. This is trivially forgeable in-process. The scan above is a heuristic backstop, not a seal. It misses a patch written through an indirection such as `globalThis['ex' + 'pect']` or a computed dynamic import, and it flags honest code that uses these names. Only a second runner in a separate container, with the verdict computed outside the PR's process, would close it, and it is not built.
- A test helper outside every test-side pattern that a hidden spec imports (for example `src/testing.ts`) looks like code under test and stays editable. The count floor and the scan are the only backstops.
- A runner config that imports code the fix needs to change makes the fix unfixable: the file is refused as test-side. No current task does.
- A new test file the PR adds is not applied, so a model that adds tests gets no credit and no penalty for them.
- Server-side web search and fetch also reach the model API through a nested `claude -p --allowedTools WebSearch` or a direct call to `/v1/messages` with the `web_search` or `web_fetch` tool, run by the agent from Bash with the login in the cage home. `--disallowedTools` covers only the outer session. The usage flag sees only the outer session. A nested or direct call is not seen and not closed. Rows carry no proof against it, so the first live run reads as "no contamination seen", never "none".
- The cage home (`--home`) persists across runs and tasks, because the login lives there. Files an agent leaves in it, such as memory, settings or a shell history, are readable by the next task. A fresh home per task would need a copy of the login, which this harness does not read or copy. The operator should clear everything but the login between tasks.
- A copy of the project nested deeper than `node_modules/<name>` and `node_modules/.pnpm/<name>@*` is not scanned.
- The login token in the cage home can reach `api.anthropic.com`. The model API is the one open channel, and it carries the server-side web tools described above.

## The factory arm

The factory arm runs the P1 pipeline for real on the private scratch repo `FiatFour/agent-works-scratch` and grades the PR head the crew leaves. HQ never merges. The cage is the same `BenchCage` as the baseline's: `api.anthropic.com` only, dependencies pre-installed, web tools disallowed, the same sealed ticket.

How the base reaches the host. `seedBase` exports the sealed cage tree (one commit, hidden tests removed, upstream links removed from `package.json`), deletes `.github`, makes a new one-commit repository and pushes it as `bench-base/t-<8 hex of the ticket id>`. The branch has no parent, so no fix commit, no history and no hidden test is in the scratch repo, and a check after the push reads the branch back. `.github` goes because a push to a branch that holds workflows starts Actions, which cost minutes on a private repo. The seed refuses to push if any path under `.github` is left.

What stays visible on the host: the base tree itself (README, CHANGELOG, `package.json` name and the source can name the upstream project, as in the cage), the ticket text with links replaced, the PR title `bench/t-<hash>: <issue title>`, the account FiatFour, and every branch of the scratch repo from other runs (`main`, the P0 to P1 spike branches, `bench-base/*` and `aw/bench/*` while a run is in flight or after `--keep-scratch`). The repo is private. The PR title and branch names are hashed, so they carry no task id or issue number.

What the harness writes on the host. Seeding force-pushes and deletes only `bench-base/t-<hash>`. Cleanup closes PRs headed by `aw/bench/t-<hash>` and deletes that branch through a sender that refuses any other write, a merge included. Stale PRs and branches from a crashed run are cleared before the next seed. After a run the PR is closed and both branches are deleted, when the arm returns, not when grading ends. The graded bytes are the ones the arm already read from the PR head, so nothing changes in the verdict. `--keep-scratch` leaves them for inspection. Every API call goes to `<out>.api.jsonl`.

| Channel | Closure | Test |
| --- | --- | --- |
| Fix commit or hidden test in the scratch repo | One-commit orphan seed from the sealed tree, read back after the push | `factory.test.ts` on a local bare repo, and one real push and delete on the scratch repo |
| Actions on a private repo | `.github` removed from the seed and refused if present, no workflow added by this harness | `factory.test.ts` |
| Writes outside the bench namespace | Seed and cleanup refs match `bench-base/t-<hash>` and `aw/bench/t-<hash>`, repo name must end in `-scratch` | `factory.test.ts`, `cli.test.ts` |
| A run that crashed before cleanup | Leftover PR and branches cleared before the next seed | `factory.test.ts` |
| Retry spend after a failed session | The first failed session ends the row as `error`, no later session starts | `factory.test.ts` |

Limits of the factory arm:

- One GitHub account. GitHub refuses an approval or a request for changes on a PR the same account opened, so the reviewer's verdict is posted as a COMMENT with its intended verdict in a marker. HQ never reaches `ready_to_merge`. The arm stops when the reviewer has reviewed the current head and asked for no change (`review_settled`), and records `head reviewed with no change requested`. That is the reviewer's intent, not a GitHub approval, and the box would wait in `qc` on a real host. With a second account the same arm stops at `ready_to_merge` (parked gate in `gates.md`).
- Author and reviewer both run on Claude, and by default both cages mount the one cage home that holds the login (`--home`, worker `baseline`). A reviewer can read what the author left in that home. `--no-session-persistence` keeps session transcripts out of it, other files are not checked. `--review-home-worker <name>` mounts a second home for the reviewer, which needs a second interactive login by the operator.
- The same home is shared with the baseline arm, which already ran there. What a baseline session left in that home is readable by the factory cages. This is the existing "home persists" limit and it now also crosses arms.
- The crew pushes through the host's REST API. A path with a dot segment (`.eslintrc`, `.github`), a binary file or a tree too large to list is refused or dropped, so a fix that needs one is graded as a failure.
- A round that fails is not retried. A reviewer that still asks for changes after three rounds ends the row as `error`, not `fail`.
- The reviewer's cage holds the base repo, not the PR. It reads the PR files from its prompt, as P1-2 designed it.
- Timing includes `gh` polling (10 s HQ poll, 15 s review check) and the seed and cleanup pushes. A factory row costs more wall time than a baseline row by design, and the task timeout is the same unless `--timeout-ms` is given.
- Reviewer and author tokens are summed into one `tokens` cell. `quotaWindows` and `humanMinutes` stay null until the operator annotates them.
- Removed paths come from the PR file listing of the host API through `gh`.
