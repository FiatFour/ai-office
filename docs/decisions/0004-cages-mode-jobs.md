# ADR 0004. The cages mode derives each job from the reducer state

Status: proposed in P1-2, 2026-11-17. The operator may override any default below.

## Context

P1-2 runs one ticket to a reviewed PR that a person merges. The reducer in `packages/core` emits commands (`start_cage`, `request_review`, `send_review_to_author`, `notify_ready`, `close_task`) and HQ's outbox delivers each one at least once. An agent session runs for minutes, HQ can die at any point, and the git host is the only place where a PR, a review or a comment exists. HQ must never open a second PR, post a second review or brief, or merge.

## Decision

- **Commands are triggers, the state decides.** An executor only wakes the task. The mode computes the one job the task needs from the current state: `building` needs the author job, `qc` with changes requested needs a fix round, `qc` with a reviewer who has not reviewed the head needs a review, `merge` with no brief for the head needs a brief. A repeated command, a restart and a poll tick all run the same function, so the job that runs is the job the state still needs. On start HQ wakes every task.
- **Each job checks the host before it writes.** The author job looks for an open PR on `aw/<factory>/<task>` and adopts it. The fix job reads the head first and stops if it already moved. The review job looks for a review on the head that carries its marker (`<!-- agent-works:review worker=<w> verdict=<v> -->`). The brief job looks for a comment that carries `<!-- agent-works:merge-brief task=<t> head=<sha> -->`. A crash between a host write and HQ seeing it therefore repeats no write.
- **Jobs run in the background,** one at a time per task and in parallel across tasks, so the outbox drain stays short. A job that fails three times on the same head becomes a `job_failed` Action item. An author job that gives up sends `session_ended`, so the reducer moves the box back to the belt and raises `worker_ended_without_pr`.
- **Rounds come from the event log.** A round is a head on which a peer asked for changes. The mode replays review facts from the `events` table at start and keeps the count as events arrive, because the state row prunes facts of replaced heads. After three fix rounds the box stays in `qc` and the snapshot shows a `round_limit` Action item. The fourth request for changes gets no fix.
- **Action items are derived, not stored:** `ready_to_merge` (box at `merge` with a posted brief), `round_limit`, `website` (a proxy denial not yet allowed), `alert` (every `alert_human` command in the outbox) and `job_failed`. `POST /api/actions/allow {host}` adds the host to the egress allowlist, and the worker's own retry then goes through.
- **A worker is named by its host login.** This answers the G1 mapping question in the direction `docs/lifecycle.md` names: the hired name is the host login. With one host account (the scratch repo today), every PR and review comes from the same login. HQ then attributes a review it posted itself to the reviewer worker and keeps only a `changes` verdict. It records an approval as a `comment`, so with one account a box waits in `qc`, as G1 decided. The host's copy of that review has the author's login and the reducer refuses it.
- **GitHost writes pass one allowlist.** `server/githost/host.ts` refuses every write that is not one of: create a ref, put a file, open a PR or MR, post a review, discussion, note or approval, post an issue comment. Paths that URL normalization changes, or that hold `%2e`, `%5c` or (outside the GitLab project id) `%2f`, are refused. No merge endpoint is on the list.
- **HQ reaches the host through `gh api` and `glab api`,** so HQ never reads or stores a token.
- **The event record for P1-3 is `GET /api/events?after=`.** `node server/modes/events-export.ts <hq-url> <file>` writes it as `events.jsonl`.

## Consequences

- A fix round is pushed by HQ through the host API from the files the author's runtime returns. The Claude Code runtime reads those files with git inside the cage, so the host never runs git over a repo an agent can write.
- The cross-runtime review in the spec cannot run while Codex is deferred. The reviewer runs on the same runtime under another worker name, and the merge brief and the snapshot say so.
- Webhooks are not wired into HQ yet. The mode polls every open PR (35 s by default), which meets the 60 s close budget measured in P0-4.
- The real sandbox driver is not wired to the Claude Code runtime yet: `claudeCode({ shell })` takes the cage shell as a port. Every live lane that needs a Claude agent needs the operator's login (gate P1-2).
