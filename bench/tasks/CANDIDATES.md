# Benchmark Set A candidates

Status: **not confirmed by the operator.** Every task has `"confirmed": false` in `bench/tasks/set-a.json`, and the harness refuses a model run on an unconfirmed task. No model has run on any of these.

Both repos are small, public and TypeScript. Both use vitest, merge by squash (so the fix is one commit with one parent), and run their tests with no secrets and no network after install.

Checked on this machine with `node bench/run.ts prepare --task <id>` and `check-fix`. For every task the hidden tests fail at the base (as a test failure, not a crash), and the upstream fix passes them. Output is in the PR body.

| id | repo | issue | fix commit | hidden tests | test command | why chosen |
| --- | --- | --- | --- | --- | --- | --- |
| ufo-214 | unjs/ufo | [#214](https://github.com/unjs/ufo/issues/214) | [`6cd1fcd39`](https://github.com/unjs/ufo/commit/6cd1fcd39d53f89e27b487f80f01c12fbee4ab88) | `test/trailing-slash.test.ts` | `node_modules/.bin/vitest run test/trailing-slash.test.ts` | One-function bug in src/utils.ts, one new case in test/trailing-slash.test.ts. Behavior is stated in the issue. |
| ufo-221 | unjs/ufo | [#221](https://github.com/unjs/ufo/issues/221) | [`3910926c2`](https://github.com/unjs/ufo/commit/3910926c2666c8dafd193d6dd485cc7527d8ecbf) | `test/join.test.ts` | `node_modules/.bin/vitest run test/join.test.ts` | Small URL-join bug with an explicit expected result in the issue. 8 new test lines. |
| ufo-241 | unjs/ufo | [#241](https://github.com/unjs/ufo/issues/241) | [`62199a0cc`](https://github.com/unjs/ufo/commit/62199a0cc84727b7b4666aaca8ff04cca2f68f3a) | `test/utilities.test.ts` | `node_modules/.bin/vitest run test/utilities.test.ts` | Protocol-relative URL case, fix is 5 lines. The hidden test adds 15 lines of cases. |
| ufo-282 | unjs/ufo | [#282](https://github.com/unjs/ufo/issues/282) | [`4d024df01`](https://github.com/unjs/ufo/commit/4d024df0134e2484b1e22ba17a08fea31e90de92) | `test/query.test.ts` | `node_modules/.bin/vitest run test/query.test.ts` | Needs a null-prototype object in parseQuery. One test line, so the task is small but the fix is easy to get wrong. |
| ufo-283 | unjs/ufo | [#283](https://github.com/unjs/ufo/issues/283) | [`7959de5b4`](https://github.com/unjs/ufo/commit/7959de5b49f52e7eb2919a33a9bfe30911e05712) | `test/parse.test.ts` | `node_modules/.bin/vitest run test/parse.test.ts` | Wrong option access in parseFilename. A reader can find it from the issue title. |
| ufo-174 | unjs/ufo | [#174](https://github.com/unjs/ufo/issues/174) | [`f4c0400d0`](https://github.com/unjs/ufo/commit/f4c0400d0956fe8e124066a5d7fbf8a88b381962) | `test/trailing-slash.test.ts` | `node_modules/.bin/vitest run test/trailing-slash.test.ts` | Older and larger (49 changed lines in src/utils.ts). Tests the harness on a harder fix, fragment handling in trailing-slash helpers. |
| path-to-regexp-433 | pillarjs/path-to-regexp | [#433](https://github.com/pillarjs/path-to-regexp/issues/433) | [`9a788793e`](https://github.com/pillarjs/path-to-regexp/commit/9a788793e7eeb0ccf9c53c1cb54d297b5badfcc3) | `src/index.spec.ts` | `node_modules/.bin/vitest run src/index.spec.ts` | Parser bug that writes the string "undefined" into a token. Fix in src/index.ts, 32 new test lines. |
| path-to-regexp-441 | pillarjs/path-to-regexp | [#441](https://github.com/pillarjs/path-to-regexp/issues/441) | [`95734b9da`](https://github.com/pillarjs/path-to-regexp/commit/95734b9dab4e9299a7f13dda38f890b6ba9453a4) | `src/cases.spec.ts` | `node_modules/.bin/vitest run src/index.spec.ts` | Duplicate trailing delimiter. The hidden test is a case table in src/cases.spec.ts that src/index.spec.ts runs. |
| path-to-regexp-430 | pillarjs/path-to-regexp | [#430](https://github.com/pillarjs/path-to-regexp/issues/430) | [`6bc8e8467`](https://github.com/pillarjs/path-to-regexp/commit/6bc8e84677caa52de6db7b2b17a6729ec155b070) | `src/cases.spec.ts`, `src/redos.spec.ts` | `node_modules/.bin/vitest run src/index.spec.ts src/redos.spec.ts` | Express regression. Needs a larger rewrite in src/index.ts and also changes the ReDoS spec, so it is the hardest of the set. |
| path-to-regexp-336 | pillarjs/path-to-regexp | [#336](https://github.com/pillarjs/path-to-regexp/issues/336) | [`a6bdf4045`](https://github.com/pillarjs/path-to-regexp/commit/a6bdf4045f369474e4e580bc6fcadb6bd806e62e) | `src/cases.spec.ts`, `src/index.spec.ts` | `node_modules/.bin/vitest run src/index.spec.ts` | Error-message change that touches parse errors across the library. Large (258 changed lines) and a stress test for review rounds. |

## How each task runs

- The cage gets the repo at the commit before the fix, as one fresh commit with no history. Files the fix adds under the hidden paths are removed. Hidden files that already exist keep their old content.
- Hidden tests live outside the cage. Grading copies the PR head onto the base, puts the hidden files back last, and runs the test command in a container with no network.
- Install runs once per task, with network, in a container: `pnpm install --frozen-lockfile --ignore-scripts` for ufo, and `npm install --ignore-scripts --before <fix date>` for path-to-regexp (the repo has no lockfile, so the date pins the dependency versions).

## Known weak spots

- `ufo-174` and `path-to-regexp-336` are large fixes. They are the likeliest failures (a guess, not measured), kept so the pass rate is not trivially high.
- The cage must be able to run the tests, so the operator must allow the npm registry (or accept that the agent cannot run them). The harness does not decide that.
- The issue text is the public issue body only. Later comments, which may contain the fix, are not given to the agent.
