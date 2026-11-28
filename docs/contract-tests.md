# Driver contract tests (P2-3)

Two contracts pin what every sandbox engine and every git host must do. Each contract is a list of cases. A case has an id, the rule it guards, optional `needs`, and a body that talks only to the driver interface.

| Contract | File | Runs against |
| --- | --- | --- |
| SandboxDriver, 15 cases | `test/contract/sandbox.contract.ts` | real docker (local, CI), real rootless podman (CI only), an in-memory fake (self test) |
| GitHost, 13 host cases and 6 payload cases | `test/contract/githost.contract.ts` | the P1-2 fake GitHub and GitLab APIs with recorded P0-4 payloads, live GitHub scratch repo with live webhooks, an in-memory fake (self test) |

## Run it

```sh
pnpm vitest run test/contract                       # everything this machine can run
pnpm vitest run test/contract/self.test.ts          # each contract fails on a fake that breaks one rule
AW_LIVE_GITHUB=FiatFour/agent-works-scratch pnpm vitest run test/contract/githost.live.test.ts
node test/contract/mutants.mjs                      # break the real driver and host code, require the right case to fail
```

The live GitHub lane uses the API and `gh webhook forward` on the private scratch repo. It opens PRs from `aw/contract/<run>-<case>` branches, never merges, adds no workflow file, and closes the PRs and deletes the branches when it ends. It needs a `gh` login with admin on the repo, so public CI does not run it.

## Never silently skipped

Every driver gets a cell on every OS. A case that cannot run says why: `needs <capability>` from the subject, a `NotRun` reason from the case, or a reason recorded for the whole driver (`docker is not installed on this runner`, `no /dev/kvm`, `not run, no account`). Each result is appended to the file in `CONTRACT_RESULTS` as one JSON line. `scripts/contract-table.mjs` joins the files into the driver by OS table and exits non-zero for a failed case, a skip without a reason, or a cell nobody reported. The `contract table` CI job runs it over the three runner artifacts and writes the table to the job summary.

## What does not run

- `a-failed-job-reads-back-bounded-and-without-secrets` on live GitHub: the subject cannot fail an Actions job on the scratch repo, so it reports `needs failing-checks`. It runs on both fake APIs and the in-memory fake.
- GitLab live: no account (gate G0). The GitLab contract runs on the fake API and the docs-example payloads only.
- krun: the driver contract needs `exec`, and krun cannot exec (`fw-krun-exec`). The P0-2 krun lanes cover its network rules.
- podman on a developer machine: podman runs on `ubuntu-latest` only.
- Docker on macOS and Windows runners: the runners have no Linux container engine, and the cage image is Linux. The job records what `docker info` reports.
