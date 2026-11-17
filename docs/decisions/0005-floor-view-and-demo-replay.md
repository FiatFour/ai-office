# ADR 0005. The floor is a pure view of the snapshot, and `--demo` replays the event log through HQ

Status: proposed in P1-3, 2026-11-18. The operator may override any default below.

## Context

P1-3 draws the run on the 480 by 270 factory floor and adds `agent-works --demo`. The spec asks for mock data, and the sharpened prompt and the plan ask for the event log of the real run instead of invented data. HQ already pushes one snapshot over the WebSocket and records every event in `events.jsonl` order (`GET /api/events?after=`).

## Decision

- **The data shape is `FloorView`, derived by one pure function `floorView(snapshot)` in `src/floor/model.ts`.** It holds the boxes (each with its station and stamp), the workers (each with one of four moods), the Action items, the six station counters and the shipped count. React components only draw it. The same function serves the live HQ and the demo, so there is no second data path.
- **Station table.** `belt` is ORDER, `building` CODE, `test` TEST, `qc` QC (stamp CHANGES when changes are requested), `merge` MERGE, `shipping` SHIPPING, `shipped` SHIPPING with the SHIPPED stamp, `cancelled` off the belt with the SCRAPPED stamp.
- **Mood table, first match wins.** Needs you (the builder of a box that waits on a person: at `merge`, closed unmerged, or named by an HQ Action item), At QC (the reviewer of a box in `qc`), Working (the worker of a box in `building`, `test` or `qc`), On break.
- **Action items are the union of the state-derived ones and `snapshot.actions`,** deduplicated by kind and task. A box at `merge` is an item even before HQ posts the brief, so the floor never hides a box that waits on a person.
- **`--demo` is a mode, not a mock.** `server/modes/demo.ts` is a `ModeFactory`. It feeds `fixtures/demo/events.jsonl` to `HqPort.ingest`, which runs the same parser, the same reducer and the same ledger as `POST /api/events`, on a timer (2 s by default, `AGENT_WORKS_DEMO_INTERVAL_MS` overrides). HQ runs in a throw-away home that is removed on exit, so a demo never touches `~/.agent-works`. `GET /api/demo` names the file, its sha256 and the replay count.
- **HQ serves the built floor** from `src/dist` when `index.html` is there (`startHq({ assets })`), and falls back to the plain dashboard page otherwise.
- **Floor stamps stay English** in both languages and live in code, not in the locale files. HUD text, drawer text and station counters come from `src/locales/{en,th}.json` through i18next. A test compares the keys and the `{{placeholders}}` of the two files, counting `_one` and `_other` plural forms as one key.
- **The TH and EN switch sits in the Debug drawer for now.** The spec puts it in Settings, Project, Language, which P1-3 does not build. The choice is kept in `localStorage`, and the first run reads `navigator.language`.

## Consequences

- A new snapshot state needs one row in `stationOf` or `moodOf` and one case in `src/test/floor-state.test.ts`. `node src/scripts/mutants.mjs` shows which rows the tests pin.
- The recorded run ends at `qc` on the real host, because one account cannot approve its own PR and the operator's merge is parked. The last two events of the fixture (a peer approval and a merged poll) were written by hand in the same shape. `fixtures/demo/README.md` says so.
- The floor shows at most six workers and one belt. More lines, the firewall counters, the truck load and the shipment board need snapshot fields that do not exist yet.
