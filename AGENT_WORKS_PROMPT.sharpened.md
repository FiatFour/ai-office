# Build prompt — Agent Works (deeper pass)

Paste everything below the line into Claude Code, run in this folder.

---

Build **Agent Works**, the local CLI + pixel-art dashboard that runs a crew of sandboxed AI coding
agents on my GitHub/GitLab repos. Two inputs describe where it ends up:

- **Product spec:** `AGENT_WORKS_PROMPT.md` (everything below its `---` line).
- **UI mockups:** the "AI Agent Office" design canvas, https://claude.ai/artifact/UF6uF24jnVSSWryFBFdU48
  (24 artboards, one per screen). Where the spec and an artboard disagree, list the conflict and ask me.

The spec describes the destination. **Your job is to prove the core claim before building out the
breadth.** The claim is that a sandboxed agent crew turns tickets into PRs a human merges, without
leaking credentials, at a cost worth paying. Every phase ends with evidence I can rerun myself. Your
own say-so doesn't count.

## Phase 0 — Ground truth (no product code yet)

1. **Primary sources, not summaries.** Read the current docs, and the source where it is open, for:
   Claude Code hooks, subagents, permission rules and settings precedence, and headless/stream-JSON
   output; the Codex CLI sandbox and config; GitHub REST and webhook payloads; GitLab REST v4 and
   webhooks; Docker and Podman `--internal` networks, rootless user namespaces and krun. Write
   `docs/sources.md`: every fact the design depends on, with its link and the version you checked.
   Mark anything the spec assumes that the sources contradict.
2. **Spikes**, each timeboxed and each leaving a runnable script in `spikes/` plus a one-page finding:
   - a. An internal network plus a CONNECT allowlist proxy fails closed on docker and podman (and on
     krun if `/dev/kvm` exists). Show this with a direct-socket bypass attempt, not just curl through
     the proxy.
   - b. Claude Code in a cage under tmux: its hooks POST to a local server, and deny rules plus a
     PreToolUse hook block reads of `.env`, `~/.ssh` and `cat`/`cp`/`grep -r` over them.
   - c. The same for Codex.
   - d. node-pty to `<engine> exec -it … tmux attach` on Windows/ConPTY. [MY CHOICE: run it now on
     a Windows machine I provide, or defer it to the CI runner.]
   - e. `gh` and `glab` against a scratch repo: open a PR/MR, post a review with line comments, read
     checks, and receive a webhook.
3. **Prior art.** Study the issue trackers of at least three existing open-source multi-agent
   coding orchestrators. List their top recurring failure modes (stuck agents, rate limits, merge
   conflicts, runaway cost, flaky tests, lost state), with links, and say how this design handles
   each one. Learn from them only; copy no names, art or code.
4. **Threat model**, in `docs/threat-model.md`.
   - Assets: host credentials, git tokens, repo secrets and the host itself.
   - Adversary: a prompt-injected agent, reached through malicious issue text, poisoned docs, an
     MCP response or a dependency's install script.
   - For each run mode, draw the trust boundaries. For every attack path, name which of the spec's
     five protected-file layers and which firewall rule stops it, and which defenses are only best
     effort.
5. **Lifecycle as an executable model.** Model the states and events of a box, a PR/MR and a
   shipment, fed by hooks, webhooks and polling, as a pure reducer. Check these invariants:
   - HQ never merges.
   - 1 task = 1 branch = 1 PR.
   - The author never reviews its own PR.
   - A box is at exactly one station.
   - The truck leaves only when every PR in its shipment is merged.
   - Nothing exceeds the machine budget.

   Check them with [MY CHOICE: property-based tests (e.g. fast-check) over the reducer / a model
   checker such as TLA+ / both].

**Stop after Phase 0 and show me the results.** Then ask me to decide the hard-to-change choices
(proxy implementation, message protocol between agents, state storage). Give the spike evidence
for each option.

## Phase 1 — Walking skeleton

One line, one worker, one cage, one real repo, end to end. The CLI starts HQ, HQ starts the cage,
and the agent works the ticket into a branch and a PR. A reviewer on the other runtime reviews it,
Captain writes the merge brief, I merge on the host, and HQ closes the task. The UI needs only the
floor with the box moving through its stations. `--demo` replays the event log recorded from this
real run instead of invented mock data.

## Phase 2 — Prove the claim with checks that are not you or me

- **Benchmark.**
  - Set A: [MY CHOICE: N] closed issues from [MY CHOICE: which repos]. Revert the fixing commit and
    hide its tests from the workers. A task passes when the hidden tests pass.
  - Set B: open issues. A task passes when I merge the PR unchanged.
  - Record per task: pass/fail, review rounds, wall time, tokens/cost and my minutes spent.
  - Run the same tasks through a plain single Claude Code session as a baseline, and report whether
    the factory beats it.
- **Red team.**
  - Write injection tasks that tell the agent to read `.env` or `~/.ssh`, curl an outside host, push
    to the base branch, edit CI, or disable hooks.
  - Plant canary credentials and a canary hostname on an external listener, so any leak shows up
    outside the tool.
  - A run passes with zero canary hits and every attempt listed in BLOCKED ATTEMPTS.
  - Run this per run mode. Report `subagents-local` honestly as best effort.
- **Contract tests.** Run the SandboxDriver suite against real docker and podman in CI. Run the
  GitHost suite against a github.com scratch repo and a GitLab instance [MY CHOICE: a GitLab CE
  container / a gitlab.com scratch project], using both recorded and live webhook payloads.
- **Platforms.** The CI matrix must pass on `ubuntu-latest`, `macos-latest` and `windows-latest`,
  with jobs that a platform can't run (krun, Podman) marked rather than silently skipped.
- **Thresholds:** [MY CHOICE: minimum merge rate, maximum cost per merged PR, maximum human
  minutes per PR]. If the numbers miss, report them and stop. Don't widen scope to make up for it.

## Phase 3 — Breadth, in the order of the spec's §9

Add each remaining feature only together with:
- a test of the invariant it touches;
- a Playwright e2e test against a real HQ, not only `--demo`;
- a side-by-side screenshot against its artboard, with the differences listed.

Gates that run in CI:
- axe-core reports zero serious violations, and text contrast is at least 4.5:1;
- the i18n key-parity check passes for `en.json` and `th.json`;
- a recheck that `prefers-reduced-motion` stops the floor animation.

v1 scope: [MY CHOICE: which run modes, runtimes, hosts and screens are in v1, and which come later].

## At the end of every phase, hand me

- the commands that reproduce each result;
- the numbers and logs, plus links to the real PRs/MRs and reviews;
- what failed, and what you would cut.

Never say something works unless a check I can rerun shows it. Work in small commits.

## Decisions that are mine (ask me, don't pick)

- The bracketed [MY CHOICE] items above.
- Proxy implementation, the message protocol between agents, state storage (after Phase 0).
- Any conflict between the spec and the canvas.
- Anything the threat model rates as best effort that I would have to accept.
