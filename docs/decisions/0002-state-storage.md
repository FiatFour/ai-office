# ADR 0002. HQ state storage

Status: accepted at gate G1, 2026-11-17. The G1 message gave no explicit recommendation for storage, so the root chose SQLite through `node:sqlite` and the operator may override. Revised in round 2 of P1-1, which removes the file store the first round built.

## Context

`packages/core` holds a pure reducer, `reduce(state, event)`, that returns the next state and commands (`docs/lifecycle.md`). HQ must persist the state across restarts, keep an append-only record of every event for P1-3's replay, hand commands to executors without losing or doubling one, and not grow without bound. P0-7 named the two options: an atomically renamed snapshot plus event log, or SQLite with a state row, append-only events, an outbox for commands, and pruning of superseded-head facts.

## Decision

SQLite through `node:sqlite`, one database file `state/hq.db` in the HQ home. There is no second store.

- `state` holds one row, the whole `Persisted` value: the reducer state, the revision, the outbox and the superseded head shas. The outbox lives in the same row as the state, so a state and the commands it produced become visible in one commit. This is the transactional outbox.
- `events` is append-only, one row per event with its sequence number and a checksum over both. HQ writes the event row and the state row in one `BEGIN IMMEDIATE` transaction, so an event is acknowledged only after both are durable and a failed reduce rolls both back. There is no replay at start, because the state row and the log cannot disagree after a commit.
- The connection runs `journal_mode = WAL` and `synchronous = FULL`, so every commit is synced before HQ answers. A test reads both pragmas, because a `kill -9` cannot show a missing sync.
- Command delivery is at least once. A command carries `id = <event seq>.<index>`, and executors treat a repeat id as done. The outbox keeps `pending`, `failed`, `done` and `skipped` (no executor wired yet) and trims the closed ones to the newest 200.
- Pruning drops `check` and `review` fact groups for a head sha that a change has moved past, and never one that a change holds now. HQ learns the superseded shas by comparing the state before and after each event. The event table is not pruned, because P1-3 replays it. A late fact for a replaced sha is added back by the reducer and removed at the next head move. A head that moves back to an old sha relies on the host redelivering facts, which polls do.

## Damage fails loudly

On start HQ checks that sequence numbers run from 1 to the row count with no gap, that every event matches its checksum, and that the state row was saved at the last event. Any miss raises `StoreCorruptError` naming the event, releases the lock and starts nothing. HQ never truncates the log to get past a bad row, so an acknowledged event is never dropped and a sequence number is never issued twice. The operator repairs or restores the file by hand.

## Why the first round deviated, and why it was wrong

Round 1 fell back to a snapshot file plus a line log and said CI runs Node 20, where `node:sqlite` does not exist. That reason does not hold. HQ's own `engines.node` is `>=22.18`, and `node:sqlite` needs no flag from 22.13, so every Node that can run HQ has the module (measured on 24.21.0 with SQLite 3.53.4). Node 20 can run neither the CLI nor HQ, so CI skips the store, HQ and `kill -9` tests there the same way it skips the CLI tests, through `hasSqlite` in `server/test/helpers.ts`. The module is still marked experimental on 22.x and prints a warning to `hq.log`. The file store also had two defects that the move removes: its repair step dropped every line after one bad checksum, silently shortening the log and reissuing sequence numbers, and it never synced the directory after a rename.

## Consequences

- The reducer state is serialised with sorted keys, as `docs/lifecycle.md` asks, so a state's bytes do not stand in for its identity.
- A crash before commit loses nothing that was acknowledged. A crash after commit and before an executor finishes redelivers the command, and the executor is idempotent by command id.
- The registry files `repos.json` and `factories.json` stay small JSON files written by `writeAtomic` (temp file, fsync, rename, directory fsync). They are not HQ state and need no history.
- One HQ owns the directory. A lock file holds its pid and a stale one is reclaimed, so a second HQ is refused with the owner's pid.
- `docs/plans/agent-works-plan.md` still says HQ records events to `events.jsonl` for P1-3. The record is now the `events` table, and P1-3 reads it through `GET /api/events?after=<seq>`. The plan line is outside P1-1's boundary and needs the root's edit.
