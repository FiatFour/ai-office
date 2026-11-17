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
- **`--demo` is read-only.** HQ is started with `readOnly`, and every request that is not a GET (`POST /api/events`, `/api/factories`, `/api/repos`, `/api/stop`, `/api/cages`, `DELETE /api/cages/…`, anything else) is answered 403 with the reason. The replay itself goes through `HqPort.ingest`, not HTTP, so it is not affected. Stop a demo with Ctrl-C or a signal. The throw-away home is removed on SIGTERM, SIGINT, SIGHUP, SIGQUIT and on process exit. A malformed line in the events file ends with `file line N: reason` and exit code 2, not a stack trace (`AGENT_WORKS_DEMO_EVENTS` points the demo at another file, which is how the tests reach that path).
- **HQ serves the built floor** from `src/dist` when `index.html` is there (`startHq({ assets })`), and falls back to the plain dashboard page otherwise. `readAsset` refuses any path that is, or passes through, a symlink (the real path must equal the path asked for) and any path outside the folder. Every response, asset, API or error, carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The plain dashboard page of P1-1 has one inline script and one inline style, so its response allows exactly those two by sha256 hash and nothing else inline.
- **Floor stamps stay English** in both languages and live in code, not in the locale files. HUD text, drawer text and station counters come from `src/locales/{en,th}.json` through i18next. A test compares the keys and the `{{placeholders}}` of the two files, and for a plural key it requires every form the language needs (`Intl.PluralRules`: `_one` and `_other` for English, `_other` for Thai), each with `{{count}}`, in each file. Thai text in the pixel fonts falls back to Sarabun (self-hosted, `@fontsource/sarabun`, Thai subset), not to the system monospace. The delivered toast keeps the task, not the sentence, so it is written again when the language changes.
- **The TH and EN switch sits in the Debug drawer for now.** The spec puts it in Settings, Project, Language, which P1-3 does not build. The choice is kept in `localStorage`, and the first run reads `navigator.language`.

## Consequences

- A new snapshot state needs one row in `stationOf` or `moodOf` and one case in `src/test/floor-state.test.ts`. `node src/scripts/mutants.mjs` shows which rows the tests pin.
- The recorded run ends at `qc` on the real host, because one account cannot approve its own PR and the operator's merge is parked. The last two events of the fixture (a peer approval and a merged poll) were written by hand in the same shape. `fixtures/demo/README.md` says so. The merged poll lists only a review by the PR author (`FiatFour`), which a one-account host can produce. The peer approval before it stays by `vega`: with `FiatFour` as reviewer the author would be approving their own PR, the reducer keeps the box in `qc`, and the MERGE station and the Needs you worker would never appear. A test pins both facts.
- The floor shows at most six workers and one belt. More lines, the firewall counters, the truck load and the shipment board need snapshot fields that do not exist yet.

## Differences from the canvas artboard

The artboard `project/Main.dc.html` of the Design canvas was rendered from its own source (the template runtime lives on claude.ai, so `src/e2e/canvas.mjs` expands the markup with the component's own `renderVals()`; no login, no network) and compared with the built floor. The list is `docs/review/P1-3-canvas-differences.md`. Lane 9 of `src/e2e/lanes.mjs` fails when a listed canvas text is not on the artboard, when a `not-built` text is on the built floor, when a `fixed` text is not, when this table is stale (`node src/scripts/differences.mjs` rewrites it) or when an id is missing from this ADR or from the PR body source. The side-by-side image is `docs/review/P1-3-review-canvas-compare.png`, one badge per difference.

<!-- differences:start -->
| id | status | what differs |
| --- | --- | --- |
| D01 | fixed | The demo chip says "Demo data" as on the canvas (it said "Demo replay"). The Debug drawer still says "Demo replay" for the mode. |
| D02 | not-built | Host chip (detected computer) in the run-mode button. The snapshot has no host or shell field. |
| D03 | not-built | Factory switcher ("FACTORY my-app", "3 lines", "+2 elsewhere"). Needs the factory park screen. |
| D04 | not-built | Order-board select (First active, Backlog). Needs boards. |
| D05 | not-built | Line speed buttons 1x, 2x, 4x. |
| D06 | not-built | Zoom out and zoom in buttons. |
| D07 | not-built | Run-mode chip ("MODE Cages / Sandbox cages · 6 running", WIN · PWSH, blinking dot). The snapshot has no run mode. |
| D08 | not-built | HQ menu: + New order, Setup, Preflight, Boards, Docs, PRs / MRs, Terminal, Settings. Built has Action items and Debug only. Each target is a later screen. |
| D09 | not-built | Factory level 3 with a 340 / 500 XP bar. The snapshot has no level or XP. |
| D10 | not-built | "+ Hire" button in the crew header. A button with no screen behind it would be dead. |
| D11 | fixed | "N NEED YOU" in the crew header is #ffca28 as on the canvas (it was #ff8a80). Lane 9 reads the computed colour. |
| D12 | not-built | Crew rows: portrait, level, an energy bar labelled EN, a station line ("L1 web · Cage 1 · T-03"), a red border on a worker that needs you. Built rows have the key, the name and the mood chip. (EN on the canvas is the energy bar, not a language chip.) |
| D13 | not-built | Shift log feed (nine lines with icons and ages). The snapshot has no feed. |
| D14 | not-built | Shift clock (SHIFT 2, 19:58, 4 shipped). |
| D15 | not-built | Production order title "Sprint 1 — Auth + Billing" and the per-line list (L1 2 boxes, L2 1 blocked, L3 TEMP-1 on it). |
| D16 | conflict | Station cells. The canvas has five (ORDER, CODE, TEST, QC, SHIP) in capitals. The plan and the sharpened prompt name six with MERGE. Built has six, written "Order Code Test QC Merge Shipping". |
| D17 | not-built | Shipment status line "S-1 waits for L1 + L3 · 4 / 9 on the truck". |
| D18 | not-built | Selected worker card: role and runtime line, EN and XP bars, TOOLS, a terminal, blocked sites with Allow and Dismiss, Worker file and Message buttons. Built has state, box, station and one line of text. |
| D19 | not-built | Hotbar Q W E R T Y (Order, QC, Unlock, Stop, Term, Hire) with badges. |
| D20 | not-built | Factory map (minimap) above the shift clock. |
| D21 | not-built | "+50 XP" rising over the PR rack and in the toast. The snapshot has no XP. |
| D22 | changed | Toast text. Canvas "SHIPMENT DELIVERED / PR #12 merged · +50 XP". Built "Shipment delivered / alpha/p12c merged and shipped", from the task, in the active language. |
| D23 | not-built | Firewall counters, the git and npm lights and the blocked packets. HQ has denials but no allowed count. |
| D24 | not-built | Truck load, the v0.1 label, the crates and the empty slots. Built truck is a blank door (38 by 40 px, the canvas truck is 38 by 78). |
| D25 | not-built | Shipments board (S-1 sign-in · L1+L3, S-2 webhook · L2, "truck waits for all PRs"). |
| D26 | not-built | PR rack cards #11, #12, #14, #15. Built rack is art only. |
| D27 | not-built | Three lines L1 to L3 with names, three belts and the shared-line mark. Built has one belt labelled "L1". |
| D28 | not-built | Temp bay (hired for L3 · 4m, leaves after 15m idle) and the TEMP-1 worker with an orange hat. |
| D29 | fixed | "CAGE n · NAME" plate under every cage, as on the canvas. |
| D30 | not-built | Run-mode label on each cage in subagent modes. The snapshot has no run mode. |
| D31 | not-built | Shared-cage banner over the cages in the one-cage subagent mode. |
| D32 | not-built | "FIREWALL OFF · NO SANDBOX" panel ("agents use this computer") when subagents run on the host. |
| D33 | not-built | HOTFIX, BLOCKED and ASKS YOU stamps. Built has SHIPPED, SCRAPPED and CHANGES only. |
| D34 | changed | Box codes. The canvas prefixes a box type (D1, T3, C2, T6, T5, C1). Built shows the task name in capitals (P12C), because a box in the snapshot has no type. The full task name is in the box title. |
| D35 | not-built | Worker plate: level, name and an energy bar over every worker, a white-hat lead with a clipboard (CAPTAIN), thought bubble text. Built plates are the name only and every hat is yellow. |
| D36 | not-built | Floor caption. |
| D37 | not-built | Yard art: trees, crates, the truck lane and the fence posts. |
| D38 | not-built | Dispatch office desks and monitors, break room vending machine, coffee and sofa detail. Built draws the window, the orders board and the sofa only. |
| D39 | changed | Belt: the canvas belt is 138 px wide and ends before the dock, built is 150 px and runs into the SHIPPING bay, so the box rests on the dock. Belt animation is a pattern shift (0.6 s) against the canvas 30 px slide (2.4 s). |
| D40 | changed | Station labels. Built draws ORDER and CODE under the belt (the canvas has no such labels) and TEST, QC, MERGE in darker ink for contrast than the canvas (#8a3500, #6b4f00, #1b5e20 against #e65100, #c79a00, #2e7d32). |
| D41 | changed | Worker movement. Canvas workers loop along the floor and a QC worker carries a labelled PR box on its head. Built places the worker at the cage, the break room or the QC gantry by mood and moves it between them with a stepped transition; the carried box is an unlabelled blue block. |
| D42 | conflict | Mood chip colours. The canvas chip is cream text on #ef5350 (3.14 to 1). Built uses dark ink (5.1 to 1) so the text passes 4.5 to 1. |
| D43 | conflict | Fonts. The canvas loads Silkscreen, Press Start 2P, Pixelify Sans and VT323 from Google Fonts. The spec says no network at runtime, so built serves the same four from @fontsource, plus Sarabun for Thai. |
| D44 | conflict | Language switch. The spec puts it in Settings, Project, Language; the canvas floor has none. Settings is not built, so the switch sits in the Debug drawer. |
| D45 | changed | HUD frame. The canvas HUD is a two-row header laid over the scene, 32 px controls and a 5 percent by 11 percent hit area per worker. Built is a one-row header above the scene, 28 to 32 px buttons, and a 44 px "!" target at 390 px. |
<!-- differences:end -->
