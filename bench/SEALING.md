# What keeps the answer from the agent

Premise: the cage and the grader keep the answer out of the agent's reach. The answer is the fix commit, the hidden tests, any later release that carries the fix, and the verdict itself. Each channel is tested directly. A channel with no closure is a recorded limit.

| Channel | Closure | Test |
| --- | --- | --- |
| Network from the cage (git fetch, ls-remote, registry install) | `BenchCage` runs the firewall with `api.anthropic.com` only. Tests run offline from dependencies installed before the run. | `cage-mount.test.ts`, real cage, denials seen for github.com and registry.npmjs.org |
| Package versions | No registry. `installedProblems` refuses an install that holds a copy of the project newer than the base. | `closure.test.ts`, `task-setup.test.ts` |
| Git objects | The cage repo is `git archive` of one base commit, re-initialised. Source checks refuse a second commit, a remote or tag ref, a reachable fix commit. | `task-setup.test.ts` |
| Hidden test files | Removed from the source, matched by content in the seal check, copied back only at grading. | `task-setup.test.ts`, `cage-mount.test.ts` |
| Ticket and package metadata | No issue url, github and npm links cut from the body, ticket id is a hash, `repository`, `homepage`, `bugs` removed from package.json. | `arms.test.ts`, `task-setup.test.ts` |
| PR path into the graded tree | Refused: node_modules, package and lock files, runner and tsconfig files, `.aw-bench`, the spec files, paths through a symbolic link. Deletions and rename sources are applied. | `closure.test.ts` |
| Graded runner and verdict | Runner and config are the base ones. The verdict is the runner's JSON report: every spec file named by the task must appear with a nonzero pass count and no failure, and the exit code must be 0. | `closure.test.ts`, `task-setup.test.ts` |
| Operator gates | Every non-scripted arm needs a confirmed task and `AW_BENCH_LOGIN_CONFIRMED=1`, with or without `--bin`. | `cli.test.ts` |

## Allowlist decision

A model run needs `api.anthropic.com`. The repo tests run with the dependencies installed into the cage before the run (`prepared.installed/node_modules`, copied by `BenchCage` and kept out of the cage repo index). The registry stays closed. Cost: the agent cannot add a dependency, and a fix that needs one is graded as a failure. Package files are protected in grading for the same reason.

## Recorded limits

- The model may remember the upstream fix from training. No harness closes that.
- README, CHANGELOG and source comments in the base tree can name the upstream project. With no network that only names the repo.
- Code under test runs in the same process as the runner's report writer, so a PR that patches the runner at run time can forge the report. Only a second runner in a separate container would close it.
- A copy of the project nested deeper than `node_modules/<name>` and `node_modules/.pnpm/<name>@*` is not scanned.
- The login token in the cage home can reach `api.anthropic.com`; the model API itself is the one open channel.
- The factory arm learns removed paths from the host API through `gh`, which the operator wires when the live arm is seeded.
