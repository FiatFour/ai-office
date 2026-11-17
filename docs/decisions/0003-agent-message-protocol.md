# ADR 0003. The agent message protocol is the `Event` union in `packages/core`

Status: accepted at gate G1, 2026-11-17, "as proposed", with the extra fields below carried from P1-2.

## Context

HQ learns what happened from four sources, and all four become one `Event` the reducer takes: human clicks, cage hooks, host webhooks and host polls. P0-7 replayed the P0-4 fixtures through the reducer and found what the host adapter drops (`docs/lifecycle.md`, "Replay of the P0-4 fixtures").

## Decision

The protocol is `Event` from `packages/core/src/lifecycle.ts`, with these rules.

- Every webhook and poll fact carries the host's own timestamp `at`, never HQ's clock. A fact without one is refused at the boundary.
- A change fact carries the repo, the head repo, the number, the branch, the author login, the state and the head sha. A review fact carries the reviewer login and the commit id the review was given on. A check fact carries the head sha. Logins are lower-cased once, where an event enters `reduce`.
- A fork PR (head repo differs from base repo) is dropped by the reducer, so the adapter must send the head repo.
- Cage hooks send `session_ended` with the task and the worker. They send nothing else today.
- `start_cage` has no ack in the union. The ack lives in HQ's outbox, not in the reducer. A command moves `pending`, `done`, `failed`. A command that stays `failed` after its retries raises a human-visible alert in the snapshot and never becomes a reducer event, so the checked model and its oracle do not change.
- HQ validates an event at the HTTP boundary (`POST /api/events`), then appends it to the log, then reduces it. The reducer sees only validated events.

## Consequences

- The HQ API accepts human events from the CLI and the dashboard. Webhook and poll events arrive from P1-2's adapters, which must keep the five fields P0-4's `GitHostEvent` drops.
- The worker-name to host-login mapping, adopt and replace events, fork PRs, the stopping station and the human-cancelled shipment member use the defaults in `docs/lifecycle.md`.
- Changes to the union change the oracle and the mutants in `packages/core`, so they are made there first.
