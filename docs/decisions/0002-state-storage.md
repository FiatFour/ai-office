# ADR 0002. HQ state storage

Status: accepted at gate G1, 2026-11-17, with one deviation recorded below. The G1 message gave no explicit recommendation for storage, so the root chose SQLite through `node:sqlite` and the operator may override.

## Context

`packages/core` holds a pure reducer, `reduce(state, event)`, that returns the next state and commands (`docs/lifecycle.md`). HQ must persist the state across restarts, keep an append-only record of every event for P1-3's replay, hand commands to executors without losing or doubling one, and not grow without bound. P0-7 named the two options: an atomically renamed snapshot plus event log, or SQLite with a state row, append-only events, an outbox for commands, and pruning of superseded-head facts.

## Decision

Chosen: SQLite through `node:sqlite` with four things. A state row. Append-only events. A transactional outbox for commands. Pruning of superseded-head facts. The reducer stays pure and HQ only persists and pushes.

## Finding that forces a deviation

`node:sqlite` was added in Node 22.5.0 and needs no flag from 22.13.0. `.github/workflows/ci.yml` runs the check job on Node `20` and `lts/*` on ubuntu, macOS and Windows, and `package.json` declares `engines.node >=20`. Node 20 has no `node:sqlite` (documented by Node, not run here: the sandbox refused a download of a Node 20 binary, so this is a documented fact and not a measurement). This machine runs Node 24.21.0, where the module loads (measured, `/tmp/swarm-P1-1/owner/node20-sqlite.txt`). The brief says to fall back and report when the matrix cannot run it. Changing the matrix is outside P1-1's file boundary.

## Deviation, built now

`server/store/` implements the same four things on files, behind one `Store` interface:

- The state row is `state.json`, written to a temp file, fsynced, and renamed over the old one. It also holds the outbox, so a state and the commands it produced become visible in one rename. This is what makes the outbox transactional.
- The event log is `events.jsonl`, append-only, one JSON line per event with a sequence number and a checksum. HQ fsyncs the line before it reduces. On start, HQ replays every event after `state.json`'s `seq` through the reducer. A torn last line is dropped.
- Command delivery is at least once. A command carries `id = <event seq>.<index>`, and executors treat a repeat id as done. The outbox keeps `pending`, `failed`, `done` and `skipped` (no executor wired yet) and trims the closed ones to the last 200.
- Pruning drops `check` and `review` fact groups for a head sha that a change has moved past, and never one that a change holds now. HQ learns the superseded shas by comparing the state before and after each event. The event log is not pruned, because P1-3 replays it. A late fact for a replaced sha is added back by the reducer and removed at the next head move. A head that moves back to an old sha relies on the host redelivering facts, which polls do.

Moving to `node:sqlite` later is one file, because nothing outside `server/store/` reads the files. It becomes possible when the matrix drops Node 20, which is end of life, and an operator override of this ADR does not need a rewrite of HQ.

## Consequences

- The state is serialised with sorted keys, as `docs/lifecycle.md` asks, so a state's bytes do not stand in for its identity.
- A crash between the event append and the state rename loses nothing, because replay re-applies the event. A crash after the rename and before the executor finishes redelivers the command, and the executor is idempotent by command id.
- Windows can fail a rename onto an open file, so the writer retries on `EPERM` and `EBUSY`.
- One HQ owns the directory. A lock file holds its pid, so a second HQ reuses the first and does not write.
