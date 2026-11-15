# Spikes

Phase 0 spikes prove the risky mechanics before any product code exists. Each spike is throwaway code that leaves evidence someone else can rerun.

## Layout

Each spike lives in `spikes/<pr-id>/`, for example `spikes/P0-2/`. It holds:

- One entry script you run with `node`, such as `node spikes/P0-2/firewall.mjs --engine docker`.
- Unit tests named `*.test.ts`. Run one spike's tests with `pnpm test spikes/<pr-id>`.
- Recorded fixtures, when the spike needs them.

The findings page for a spike is `docs/spikes/<pr-id>-<topic>.md`. It states what ran, the commands to rerun it, the numbers, and what failed.

## Rules

- Write scripts in Node, not shell, so they run in PowerShell 7 on Windows as well as on Linux and macOS.
- Name every container and network the spike creates with the `agent-works.project` label, and clean them up by that label.
- Cite `docs/sources.md` row ids for every engine, agent, or git-host behavior the spike depends on. When a spike disproves a row, update the row in the same PR.
- A spike touches only `spikes/<pr-id>/**` and `docs/**`.
