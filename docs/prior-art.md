# Prior art

This page lists recurring failure modes from the issue trackers of three open-source tools that run several coding agents at once. Each row links one issue that shows the failure and names the PR in `docs/plans/agent-works-plan.md` that handles it. Agent Works learns from these trackers only. It copies no names, art or code from them.

Trackers read on 2026-11-16, sorted by comment count, with searches for stuck, hang, loop, rate limit, cost, conflict, rebase, worktree, lost, Windows and secret:

- claude-squad, a terminal tool that runs agents in tmux sessions on git worktrees. <https://github.com/smtg-ai/claude-squad/issues>
- vibe-kanban, a board that runs coding agents per task on git worktrees. <https://github.com/BloopAI/vibe-kanban/issues>
- OpenHands, an agent platform that runs agents in a Docker sandbox runtime. <https://github.com/OpenHands/OpenHands/issues>

Two more trackers were searched, `ruvnet/ruflo` and `stravu/crystal`. Their search results were mostly roadmaps, proposals or setup questions, so no row cites them.

## Failure modes

| Id | Project | Failure mode | Issue | Handled by | How this design handles it |
| --- | --- | --- | --- | --- | --- |
| F-01 | vibe-kanban | Stuck agent. The agent finishes, but its process never exits, so the task stays "In Progress" until the whole app restarts. | [BloopAI/vibe-kanban#1362](https://github.com/BloopAI/vibe-kanban/issues/1362) | P0-7, P1-2 | The lifecycle reducer moves a box on the `Stop` hook event and git state, not on process exit, and times out a station that gets no event. |
| F-02 | vibe-kanban | Stuck agent that cannot be stopped. A running task never finishes, the Stop button does nothing, and the console shows "database is locked". | [BloopAI/vibe-kanban#1718](https://github.com/BloopAI/vibe-kanban/issues/1718) | P0-7, P1-1 | Stopping a box removes its cage by label. P1-1 picks state storage at G1 with this failure as a criterion. |
| F-03 | OpenHands | Stuck loop with no recovery. After "Agent stuck in loop", the session takes no further messages. | [OpenHands/OpenHands#5480](https://github.com/OpenHands/OpenHands/issues/5480) | P0-7, P1-2 | A box has an explicit failed state with a restart event, checked by the reducer invariants. |
| F-04 | OpenHands | Sandbox never becomes ready. The app waits forever at "Waiting for client to become ready...". | [OpenHands/OpenHands#5968](https://github.com/OpenHands/OpenHands/issues/5968) | P0-3, P1-1 | P0-3 measures cage cold start against a 30 second budget, and Preflight shows a failed start with its fix instead of waiting. |
| F-05 | OpenHands | Model rate limits. Repeated `RateLimitError` responses end in a crash instead of a backoff. | [OpenHands/OpenHands#6890](https://github.com/OpenHands/OpenHands/issues/6890) | P2-1 | All factories share one account, so the benchmark records rate-limit waits per task, and the machine budget caps parallel workers. |
| F-06 | vibe-kanban | Git host polling that never backs off. A deleted target branch makes the diff stream retry every few seconds, with possible rate limiting. | [BloopAI/vibe-kanban#2459](https://github.com/BloopAI/vibe-kanban/issues/2459) | P0-4 | P0-4 fails when API calls per open PR per hour exceed 120 and uses webhooks when HQ is reachable. |
| F-07 | OpenHands | Runaway cost. Self-hosted runs have no per-conversation spend ceiling, and cost is published only when the run ends. | [OpenHands/OpenHands#17691](https://github.com/OpenHands/OpenHands/issues/17691) | P0-7, P2-1 | "Nothing exceeds the machine budget" is a reducer invariant, and P2-1 reports cost per merged PR against the G1 threshold. |
| F-08 | vibe-kanban | Stale base branch. Agents start from an outdated target branch and skip the fetch even when told to, so their PRs conflict. | [BloopAI/vibe-kanban#2100](https://github.com/BloopAI/vibe-kanban/issues/2100) | P1-2 | HQ fetches and creates the task branch before the agent starts, so the agent never picks the base. |
| F-09 | vibe-kanban | Parallel tasks on one base drift. Once one task merges, the open tasks' diffs include its changes and need a rebase. | [BloopAI/vibe-kanban#1141](https://github.com/BloopAI/vibe-kanban/issues/1141) | P0-7, P1-2 | A shipment records merge order, and the merge brief lists what breaks if only part of it merges. |
| F-10 | vibe-kanban | Worktree branch clash. git refuses with "reference is already checked out" even when the branches differ. | [BloopAI/vibe-kanban#306](https://github.com/BloopAI/vibe-kanban/issues/306) | P1-2 | One task gets one branch with a unique `aw/<factory>/<task>` name, so two worktrees never share a branch. |
| F-11 | vibe-kanban | Leaked worktrees. Finished and cancelled tasks leave worktrees on disk until someone deletes them. | [BloopAI/vibe-kanban#765](https://github.com/BloopAI/vibe-kanban/issues/765) | P0-2, P1-1 | Every cage and network carries the `agent-works.project` label, and P0-2 lane 10 proves cleanup by label leaves nothing. |
| F-12 | claude-squad | Lost session state. Checking out a worktree and resuming it starts a fresh chat with no history. | [smtg-ai/claude-squad#103](https://github.com/smtg-ai/claude-squad/issues/103) | P0-5, P1-2 | The agent's tmux session lives in the cage, and P0-5 lane 6 proves a reconnect keeps the same session and scrollback. |
| F-13 | claude-squad | Lost first prompt. The prompt is sent before the CLI is ready, and the agent waits with no task. | [smtg-ai/claude-squad#266](https://github.com/smtg-ai/claude-squad/issues/266) | P0-3, P1-2 | The worker gets its work order only after the `SessionStart` hook reports in, not after a fixed delay. |
| F-14 | claude-squad | Terminal capture fails. Reading the agent's tmux pane errors with "exit status 1". | [smtg-ai/claude-squad#51](https://github.com/smtg-ai/claude-squad/issues/51) | P0-5 | P0-5 streams the pane through node-pty and tests resize, reconnect and cage stop on every host. |
| F-15 | claude-squad | No Windows support. Creating a session on native Windows fails because the pty library does not support Windows. | [smtg-ai/claude-squad#275](https://github.com/smtg-ai/claude-squad/issues/275) | P0-5, P2-3 | node-pty uses ConPTY on Windows (S-54), and P0-5 lane 4 and the P2-3 matrix run on `windows-latest`. |
| F-16 | claude-squad | Agent config missing in new sessions. A second session starts with no MCP servers configured. | [smtg-ai/claude-squad#143](https://github.com/smtg-ai/claude-squad/issues/143) | P0-3 | HQ generates each worker's managed settings at cage start, so no session depends on what an earlier one wrote. |
| F-17 | claude-squad | Untracked files missing in worktrees. New worktrees lack dependencies and `.env` files, so agents fail or need secrets copied in. | [smtg-ai/claude-squad#260](https://github.com/smtg-ai/claude-squad/issues/260) | P0-3, P0-6 | Secrets reach the cage only as env vars from the Secrets list, and `.env` files stay masked. The threat model covers the urge to copy them. |
| F-18 | OpenHands | Secret leaks through redaction gaps. A `%` in an MCP server URL password stops query-string secrets from being redacted, with no error. | [OpenHands/OpenHands#16978](https://github.com/OpenHands/OpenHands/issues/16978) | P0-6, P2-2 | Agent Works does not rely on redaction. Credentials never enter the cage, and P2-2 checks for canary hits on an outside listener. |
| F-19 | OpenHands | No control over sandbox networking. Users ask to choose which Docker network the sandbox joins. | [OpenHands/OpenHands#6637](https://github.com/OpenHands/OpenHands/issues/6637) | P0-2 | Each project gets its own internal network and an allowlist proxy, with policies and per-agent additions. |

## Patterns across the trackers

- Process state is the wrong signal for progress. F-01 to F-04 all come from treating "process alive" as "agent working". P0-7 drives state from hook events, git and the host, and times out silence.
- Git topology breaks quietly. F-08 to F-11 come from agents choosing or sharing branches. HQ owns branch creation and cleanup.
- Spend and rate limits need a cap before the run, not a report after it (F-05 to F-07).
- Credential safety by redaction fails silently (F-18). Keeping credentials out of the cage is the stronger design, and P2-2 tests it from outside.
