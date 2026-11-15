# P0-4 findings: the GitHub and GitLab round trip

This spike checks that HQ can open, review, watch and route pull requests on a real git host without ever merging one. It ran against the private scratch repo `FiatFour/agent-works-scratch` on 2026-11-16 with the `FiatFour` account. GitLab did not run, because gate G0 deferred the GitLab account.

## Rerun it

The script uses only Node built-ins. It takes its token from `GITHUB_TOKEN`, else from `gh auth token`. Webhooks need the free `cli/gh-webhook` extension (`gh extension install cli/gh-webhook`). Each command appends every API call it makes to `<out>/api-calls.jsonl`.

```sh
node spikes/P0-4/githost.mjs lifecycle --repo FiatFour/agent-works-scratch --factory alpha --task t1 --out <dir>
node spikes/P0-4/githost.mjs listen --repo FiatFour/agent-works-scratch --seconds 150 --out <dir>
node spikes/P0-4/githost.mjs poll --repo FiatFour/agent-works-scratch --pr 1 --interval 35 --until merged --out <dir>
node spikes/P0-4/githost.mjs route --repo FiatFour/agent-works-scratch
node spikes/P0-4/githost.mjs checks --repo FiatFour/ai-office --ref <sha>
node spikes/P0-4/githost.mjs perf --repo FiatFour/agent-works-scratch --pr 2 --changes 20 --interval 35 --out <dir>
pnpm test spikes/P0-4
```

`lifecycle` creates the branch `aw/<factory>/<task>`, commits a six-line file through the contents API, opens the PR, posts a commit status, posts a `COMMENT` review with comments on lines 2 and 5, reads check runs and the combined status, and polls the PR once. It prints the PR URL and the final state. It prints `not run, no account` for the GitLab MR.

## What the script models

- One `GitHostEvent` union covers what the lifecycle uses: `push`, `change` (PR or MR opened, updated, closed, merged), `review`, `review_comment` and `check`. A registry keyed by host and event name holds one parser per event. An event the lifecycle does not use, such as `ping`, parses to `null`. A used event that lacks a field throws `PayloadError` with the missing path.
- A branch named `aw/<factory>/<task>` routes its PR to that factory. Any other branch routes to no factory.
- The API client refuses any non-GET call to a `pulls/<n>/merge` or `merge_requests/<n>/merge` path before it sends it. The merge lane therefore depends on code, not on care.
- The webhook listener rejects a delivery whose `X-Hub-Signature-256` does not match the secret it gave the forwarder (S-31). Every recorded delivery passed.

## Fixtures

`spikes/P0-4/fixtures/github/` holds payloads recorded live by the listener: `push`, `status`, `pull_request` (opened and closed), `pull_request_review` and `pull_request_review_comment` from the scratch repo, and `check_run` from the CI of the public PR #4. Each file names its source.

`spikes/P0-4/fixtures/gitlab/` holds the GitLab docs examples for `Push Hook`, `Merge Request Hook`, `Note Hook` and `Pipeline Hook`. They are not recordings. Replace them with recordings on the first live GitLab run.

The docs example for a merge request comment has no `position` field. A general comment is therefore a `review_comment` with `line: null`, and only a line comment carries a position (S-35).

## Lanes

| Lane | Result | Evidence |
| --- | --- | --- |
| 1. Open a PR with the prefixed branch | PASS | `gh pr view 1` shows `headRefName` `aw/alpha/t1` |
| 2. Open a GitLab MR | not run, no account | gate G0 |
| 3. Review with two line comments | PASS on API evidence. No screenshot. | `pulls/1/comments` returns lines 2 and 5 on `RIGHT`, and each `diff_hunk` ends on the commented line. The page needs a logged-in browser, and this machine has none. |
| 4. Same review on GitLab | not run, no account | gate G0 |
| 5. Read check status | PASS | The script's check runs for public PR #4 match `gh pr checks 4` job by job (7 of 7 success). The commit status on the scratch repo matches `gh pr checks`. No Actions ran on the private repo. |
| 6. Read MR pipeline status | not run, no account | gate G0 |
| 7. Forward webhooks to a local listener | PASS | `push`, `status`, `pull_request`, `pull_request_review` and two `pull_request_review_comment` deliveries arrived, passed the signature check and parsed. The run after the last fix also received a `push`, then exited and left no hook on the repo. |
| 8. Polling only | PASS | With zero hooks on the repo, the poller saw a new head 15.9 s after the push |
| 9. Two factory prefixes | PASS | `route` assigns `#1 aw/alpha/t1` to `alpha` and `#2 aw/beta/t2` to `beta` |
| 10. Operator merges by hand | parked | The operator merges scratch PR #1 by hand. Then run `poll --pr 1 --until merged` and search `api-calls.jsonl` for `/merge`. |

## Numbers

All numbers are measured on 2026-11-16 from a WSL2 machine in Bangkok against `api.github.com`. The probe made 20 pushes to scratch PR #2 through the contents API, with a random 5 to 40 s gap between pushes. A webhook listener and a poller on a 35 s interval both watched every push. The plan says to alternate the two runs. Both ran on every push instead, because the webhook observer makes no API calls and so cannot change the poller's count. Each latency runs from the moment the script sends the push to the moment the observer sees the new head. It therefore includes the push request itself, about 1 s.

| Metric | Value | Budget |
| --- | --- | --- |
| Webhook latency, p50 / p95 / max | 2.2 s / 2.6 s / 2.9 s | none |
| Polling latency, p50 / p95 / max | 22.4 s / 36.5 s / 37.5 s | p95 at most 60 s |
| Pushes seen, webhook / polling | 20 / 20 | 20 |
| Poll calls per PR per hour, from `api-calls.jsonl` | 105 (25 calls in 856 s) | at most 120 |
| Calls per PR per hour, webhook observer | 0 | at most 120 |
| `304` responses to polls | 0 of 25 | none |
| Calls to a merge path | 0 of 66 | 0 |

Verdict: PASS. GitLab has no numbers, because it did not run.

The interval sets the polling numbers. A push lands at a random point between two polls, so the latency is spread across 0 to 35 s, plus up to 2.5 s for the request and for GitHub to update the PR head. The p95 of 36.5 s matches that bound. A shorter interval cuts the latency and raises the call count at the same rate: 30 s gives 120 calls per hour, which is the budget. The script's own count was 101 per hour, because it divides by the whole run, including the last sleep. The table uses the log, as the plan asks.

Raw output is in `/tmp/swarm-p0-4/owner/` on the owner machine: `perf-run.txt`, `run-perf/perf.json` and `run-perf/api-calls.jsonl`.

## What this changes for later PRs

- Webhooks are the main signal and polling is the fallback. Webhook latency is about 2 s, and polling at a 35 s interval stays inside both budgets.
- Do not count on ETags to make polling free. A 304 costs no rate limit: `x-ratelimit-used` stayed at 167 across two 304 responses. Polling `pulls/<n>` almost never gets one, though. The PR body embeds `head.repo` and `base.repo`, and their `pushed_at` changes on a push to any branch of the repo. In a repo where several agents push, every poll returns 200. The perf run logged zero 304 responses.
- A pushed branch gets one `push` event for the ref creation and one for each commit. Only the commit push moves the PR head.
- GitHub forbids approving your own PR. With one account, reviews post as `COMMENT` or `REQUEST_CHANGES`. P1-2 needs a second account or a GitHub App to approve.
- Check runs need a GitHub App to create. On a repo without Actions, a commit status is the check that HQ can post with a user token.
- `gh webhook forward` creates the repo hook and deletes it when it exits. It does not appear in `api-calls.jsonl`, because the extension makes those calls itself.
- A SIGINT to `gh` alone leaves the `gh-webhook` extension running. The hook stays on the repo, and the listener cannot close. The script now starts the forwarder in its own process group, signals the whole group and waits for it to exit. On Windows it signals only `gh`, and that path has not been tested.
- A deleted branch sends a `push` whose `after` is 40 zeros. HQ must read that as a deletion, not as a new head.

## Gaps

- GitLab lanes 2, 4 and 6 did not run. The GitLab parser has been tested only on docs examples.
- Lane 3 has no screenshot.
- Lane 10 waits for the operator.
- No `pull_request` `closed` payload with `merged: true` exists yet. The unit test sets `merged` on the recorded `closed` payload to cover that case. Lane 10 records the real one.
