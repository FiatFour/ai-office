# Demo run

`events.jsonl` is the event log that `agent-works --demo` replays through HQ's reducer. One line per event, `{"seq", "event"}`, the shape of `GET /api/events?after=`.

Lines 1 to 14 are the export of the P1-2 live run `alpha/p12c` (scratch PR 6), unchanged. The agent in that run was the scripted runtime, not a real Claude Code run, because the real run waits on the operator's login. Lines 15 and 16 are not recorded. They are a peer approval by `vega` on the last head and a poll that reports the PR merged, written by hand in the same shape, because the operator's merge on the host is a parked gate and with one GitHub account the box waits in `qc`.

Rerun the replay: `pnpm --filter @agent-works/floor build && node bin/agent-works.ts --demo`.
