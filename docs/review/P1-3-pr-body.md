## What this adds

The factory floor (480 by 270 pixel scene, one belt L1, boxes ORDER CODE TEST QC MERGE SHIPPING, four worker states, "!" for Action items, Action items drawer over a dimmed floor, keys 1 to 9 and D) and `agent-works --demo`, which replays `fixtures/demo/events.jsonl` through the same parser, reducer, ledger and snapshot path as `POST /api/events`. There is no separate mock data path. For the operator: `pnpm --filter @agent-works/floor build && node bin/agent-works.ts --demo` shows the recorded run from ticket to shipped. For the next engineer: a new snapshot state needs one row in `stationOf` or `moodOf` (`src/floor/model.ts`) and one case in `src/test/floor-state.test.ts`. ADR: `docs/decisions/0005-floor-view-and-demo-replay.md`.

**The recorded run is scripted, not a real Claude run.** The agent in the P1-2 export (`alpha/p12c`, scratch PR 6) was the scripted runtime, because the real run is parked on the operator's login. Neither P1-2 export reaches shipped (one account, the operator's merge is a parked gate), so lines 15 and 16 of the fixture are written by hand in the same shape. Lines 1 to 14 are the export unchanged.

**One-account reviewer, stated plainly.** Line 16 (the merged poll) now lists only a review by `FiatFour`, the PR author, a login a one-account host can produce. Line 15, the peer approval, stays by `vega`, which a one-account host cannot produce. If its reviewer were `FiatFour`, the author would be approving their own PR, the reducer would keep the box in `qc`, and the demo would never show MERGE or a worker that Needs you (`src/test/floor-state.test.ts` pins both results). `fixtures/demo/README.md` says the same.

## Round 2: what changed after the verifier (NOT CLEAN at 4fe7dce: 1 blocker, 9 minors, 21 surviving mutants)

| Finding | Fix | Test that fails without it |
| --- | --- | --- |
| B1 lane 9 was hard-coded true, the compare image was the floor with five badges | The canvas artboard is rendered from its own source (the template runtime lives on claude.ai and needs a login, so `src/e2e/canvas.mjs` expands the `sc-for`, `sc-if` and `{{ }}` markup with the component's own `renderVals()`; fonts from `@fontsource`, no network). 45 differences (re-diffed from the source, not only the verifier's list) are in `docs/review/P1-3-canvas-differences.md`, one id per line. Lane 9 checks each: its canvas text is on the rendered artboard, a `not-built` text is absent from the built floor, a `fixed` text is present, the table in this body and in ADR 0005 equals the one generated from the file, the `N NEED YOU` colour is read, the image exists and equals neither input. `docs/review/P1-3-review-canvas-compare.png` is the real side by side with a badge per difference and a legend | lane 9; mutants `locale-demo-chip-wording`, `css-warn-colour`, `scene-cage-plate-removed` |
| M2 perf claims | Stated below: the 30 s trace is a real HQ fed over HTTP with six workers (the fixture has two); literal rAF p95 reads 16.8 ms; the CI gate. A second probe runs during `--demo` itself | `node src/e2e/perf.mjs` |
| M3 axe 0 violations is not a contrast proof | axe leaves nodes "incomplete" (cannot decide): they are recorded, not counted as passes (`axe.txt`, 171 nodes over 8 states, 21 to 30 per state). Axe also runs on the Needs-you states now (live floor, Action items drawer with a ticket, worker card, TH floor). The FIREWALL art label sat on `#3a2a2e`; it now sits on the `#15181c` plate the canvas has, 5.11 to 1, and lane 7 computes the contrast of every scene label (estimate, listed in `axe.txt`) | lane 7; mutant `scene-firewall-label-no-bar` |
| M4 i18n | Parity fails when a plural form is missing from either locale (English needs `_one` and `_other`, Thai `_other`, each with `{{count}}`) or when one file has plain text where the other has plural forms. The delivered toast keeps the task and is written again on a language switch. `.pixel` Thai falls back to Sarabun (self-hosted Thai subset), checked with CDP `getPlatformFontsForNode`. `aria-label` of the HQ nav is translated | `src/test/i18n-parity.test.ts`; lane 8; mutants `locale-plural-*`, `toast-string-frozen`, `css-thai-pixel-monospace`, `nav-aria-not-translated` |
| M5 demo must be read-only | `readOnly` option on `startHq`, set by `--demo`: every non-GET request (`/api/events`, `/api/factories`, `/api/repos`, `/api/stop`, `/api/cages`, `DELETE /api/cages/…`, others) is 403 with "demo mode is read-only…". The replay uses `HqPort.ingest` and is unaffected | `src/test/demo.test.ts` (8 routes), `src/test/demo-cli.test.ts`; mutants `demo-write-allowed`, `cli-demo-not-read-only` |
| M6 cleanup and bad fixture | The throw-away home is removed on SIGTERM, SIGINT, SIGHUP, SIGQUIT and in a `process.on('exit')` hook. A malformed fixture line gives `file line N: reason` and exit 2, no stack | `src/test/demo-cli.test.ts` (4 signals, bad file); mutants `cli-demo-no-sighup`, `cli-demo-no-sigquit`, `cli-demo-bad-fixture-code`, `demo-fixture-line-unnamed` |
| M7 headers and assets | `X-Content-Type-Options: nosniff` and a CSP (`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*`, no external host, no inline script) on every response. The P1-1 dashboard page has one inline script and style, allowed by sha256 hash only. `readAsset` refuses symlinks (real path must equal the path asked for). The dead `..` check is gone: `normalize` of a path that starts with `/` cannot keep `..`, so the guard is the real-path prefix test | `src/test/demo.test.ts`; lane 7.5 (zero CSP violations in the console); mutants `assets-symlink-followed`, `assets-no-root-prefix-check`, `hq-no-nosniff`, `hq-csp-inline-script`, `hq-csp-external-host`, `assets-any-method` |
| M8 lint and lane 7.5 | The unused `biome-ignore` is gone (the effect now reads `rev`, so the dependency is real). Lane 7.5 aborts every request to a host other than HQ with a Playwright route and asserts zero; it proves the blocker by sending a probe to 192.0.2.1 | `pnpm lint` (0 warnings); lane 7.5; mutant `index-external-font` |
| M9 fixture reviewer | See "One-account reviewer" above | `src/test/floor-state.test.ts`; mutant `fixture-poll-by-non-author` |
| 21 surviving mutants | All ported into `src/scripts/mutants.mjs`, with tiers (unit, then the Playwright lanes). Two extra verifier mutants are included | table below |

## Boundary files: request for the operator to accept

This unit touches files outside `src/` that belong to the server, CI and workspace. The operator is asked to accept them:

- `server/hq.ts` (assets option, GET reaches `mode.route`, `readOnly`, security headers), `server/cli.ts` (`--demo`, signals, bad file exit), `server/assets.ts` (new), `server/modes/demo.ts` (new)
- `.github/workflows/ci.yml` (two new jobs: `src`, `floor-e2e`; every existing job kept)
- `pnpm-workspace.yaml` (adds `src`), `pnpm-lock.yaml` (adds `@fontsource/sarabun` 5.3.0)
- Root `package.json` and `tsconfig.base.json` are untouched, so root `pnpm typecheck` does not see `src`; the `src` CI job runs `pnpm --filter @agent-works/floor typecheck`.

## Verify, unit

`pnpm test` (root): 1342 tests, 51 files, all pass. `pnpm test src`: 92 tests, 5 files. `pnpm lint`: no errors, no warnings. Typecheck root and `src`: clean.

Mutants, `node src/scripts/mutants.mjs` (baseline PASS, 83 mutants, 0 survived; result file `/tmp/swarm-P1-3/owner/mutants-p1-3.txt`). Tier unit runs `pnpm vitest run src/test`; tier e2e rebuilds the floor and runs `node src/e2e/lanes.mjs`.

| Mutant | Result | Claim it checks |
| --- | --- | --- |
| the 35 owner mutants (stations, stamps, counters, Needs you, At QC, Working, mood priority, sorting, Action items, locale keys) | all caught by unit tests | unchanged from round 1 |
| `human-cancel-needs-you` | caught by unit tests | a box scrapped by a person asks nothing of its builder |
| `cancelled-counted-at-ORDER` | caught by unit tests | a scrapped box counts at no station |
| `shipping-counted-as-shipped` | caught by unit tests | a box on the truck that has not left is not shipped |
| `stations-order-QC-MERGE-swapped` | caught by unit tests | the stations run ORDER CODE TEST QC MERGE SHIPPING |
| `codeOf-no-upper` | caught by unit tests | the box code is upper case |
| `rev-zero` | caught by unit tests | the view carries the snapshot rev |
| `action-worker-last-owner` | caught by unit tests | the first builder is asked, not the last owner |
| `workers-only-staff` | caught by unit tests | a worker on a box but not in the staff is listed |
| `owners-drop-worker` | caught by unit tests | the worker of a box is one of its owners |
| `layout-MERGE-drawn-at-QC` | caught by unit tests | each station has its own gantry x |
| `layout-max-workers-4` | caught by unit tests | six workers are drawn |
| `scene-bang-on-qc` | caught by FAIL lane 3 | the "!" button sits on the worker that needs you |
| `scene-no-stamp` | caught by FAIL lane 8 | a stamped box shows its stamp |
| `css-reduced-motion-transitions-kept` | caught by FAIL lane 6 | with prefers-reduced-motion a moving box jumps, it does not glide |
| `css-reduced-motion-animations-kept` | caught by FAIL lane 6 | with prefers-reduced-motion nothing animates |
| `css-not-pixelated` | caught by FAIL lane 5 | the scene is drawn with hard pixels |
| `css-thai-pixel-monospace` | caught by FAIL lane 8 | Thai in the pixel font falls back to a Thai font |
| `css-warn-colour` | caught by FAIL lane 9 | N NEED YOU is the canvas yellow |
| `i18n-langFromLocale-exact` | caught by unit tests | any th-* locale picks Thai |
| `i18n-fallback-th` | caught by unit tests | a missing key falls back to English |
| `main-saved-lang-ignored` | caught by unit tests | the saved language is read back |
| `main-saved-lang-not-passed` | caught by FAIL lane 8 | the page reads the saved language on load |
| `main-html-lang-not-updated` | caught by unit tests | switching language sets the lang of the page |
| `main-switch-not-persisted` | caught by FAIL lane 8 | the switch writes the page lang and the saved choice |
| `toast-string-frozen` | caught by FAIL lane 8, FAIL lane 9 | the delivered toast follows the language |
| `nav-aria-not-translated` | caught by FAIL lane 8 | the HQ nav label comes from the locale files |
| `locale-plural-other-missing-en` | caught by unit tests | a plural form missing from en.json is caught |
| `locale-plural-other-missing-th` | caught by unit tests | a plural form missing from th.json is caught |
| `locale-plural-lost-count` | caught by unit tests | a plural form without {{count}} is caught |
| `locale-demo-chip-wording` | caught by FAIL lane 9 | the demo chip says Demo data as on the canvas |
| `scene-firewall-label-no-bar` | caught by FAIL lane 7 | the FIREWALL art label is 4.5 to 1 or better |
| `scene-cage-plate-removed` | caught by FAIL lane 9 | every cage has its CAGE n plate |
| `index-external-font` | caught by FAIL lane 7.5 | the floor loads nothing from another host |
| `assets-any-method` | caught by unit tests | only GET reads an asset |
| `assets-symlink-followed` | caught by unit tests | a symlink in the asset folder is refused |
| `assets-no-root-prefix-check` | caught by unit tests | a path that climbs out of the folder is refused |
| `hq-no-nosniff` | caught by unit tests | every response says nosniff |
| `hq-csp-inline-script` | caught by unit tests | the policy allows no inline script |
| `hq-csp-external-host` | caught by unit tests | the policy names no external host |
| `demo-write-allowed` | caught by unit tests | demo mode refuses writes |
| `cli-demo-not-read-only` | caught by unit tests | --demo starts HQ read-only |
| `cli-demo-home-kept` | caught by unit tests | --demo removes its throw-away home |
| `cli-demo-uses-real-home` | caught by unit tests | --demo never touches ~/.agent-works |
| `cli-demo-no-sighup` | caught by unit tests | --demo cleans up on SIGHUP |
| `cli-demo-no-sigquit` | caught by unit tests | --demo cleans up on SIGQUIT |
| `cli-demo-bad-fixture-code` | caught by unit tests | a bad events file exits 2 |
| `demo-fixture-line-unnamed` | caught by unit tests | a bad events line is named with its file and line number |
| `fixture-poll-by-non-author` | caught by unit tests | a poll in the fixture reports only reviews the PR author could post on one account |

Not killed on purpose: the verifier's `qc-mood-on-test-box` (a box in `test` has no `reviewer` field, so `reviewer === name` is false for every name: equivalent), and a `process.on('exit')` wipe that only runs on an uncaught exception (the same `wipe` runs in `finally` for every path the tests can reach; not testable without a crash hook).

## Verify, live (Playwright, Chromium 1255 headless, `node src/e2e/lanes.mjs`; evidence in `/tmp/swarm-P1-3/owner/`)

| Lane | Result |
| --- | --- |
| Lane | Result |
| --- | --- |
| 1 demo run | PASS |
| 2 demo source | PASS |
| 7.5 no network at runtime | PASS |
| 8 Thai | PASS |
| 8.5 html lang follows the switch | PASS |
| 10 keys 1 and D | PASS |
| 5 widths 1440 and 390 | PASS |
| 3 sprite states | PASS |
| 4 action drawer | PASS |
| 7 axe-core | PASS: 0 violations, 171 incomplete nodes recorded, `docs/review/P1-3-review-axe.txt` |
| 6 reduced motion | PASS |
| 3.5 six cages, seven workers | PASS |
| 9 canvas compare | PASS (45 differences checked, see below) |

## Verify, perf (measured, 1440x900 headless Chromium on this machine, `node src/e2e/perf.mjs`)

- Gzipped JS bundle: 91.4 KB (limit 400 KB). One JS file; fonts and CSS are separate files.
- **Probe 1, 30 s against a real HQ** (`bin/agent-works.ts serve`, fed over HTTP `POST /api/events`, **six workers** and six boxes moving; the fixture has only two workers). rAF intervals, 1971 frames: p50 16.7 ms, p95 16.8 ms, p99 16.8 ms, max 16.8 ms, 0 frames over 50 ms. Main-thread render work (Layout, UpdateLayoutTree, Paint, PrePaint, Commit, Layerize, FunctionCall, EvaluateScript from a Chrome trace) per 16.7 ms window: p50 0.37 ms, p95 1.40 ms, max 8.1 ms.
- **Probe 2, 20 s during `--demo` itself** (the CLI replaying the fixture at one event a second, two workers, one box). rAF p95 16.7 ms, max 16.8 ms, 0 frames over 50 ms; work per frame p50 0.29 ms, p95 1.18 ms, max 2.4 ms.
- **A literal "rAF p95 <= 16.7 ms" reads 16.8 ms** in probe 1 and in the earlier runs. That interval is the 60 Hz vsync period (16.67 ms) plus jitter, so it cannot be below 16.7 and a literal reading fails by 0.1 ms. **The CI gate trips on work per frame p95 over 16.7 ms or rAF p95 over 33.4 ms** (a dropped frame), for both probes. The operator may want a different reading of the rule.
- No baseline, trunk empty.

## Canvas compare (lane 9): 45 differences

The artboard was rendered, not guessed: `docs/review/canvas/Main.dc.txt` is `project/Main.dc.html` (sha256 `13a3d20a…71198e`), `src/e2e/canvas.mjs` renders it from its own source without the claude.ai runtime. Image: `docs/review/P1-3-review-canvas-compare.png` (canvas left, built floor right, badge n on difference Dn, legend below). The list is `docs/review/P1-3-canvas-differences.md`; the verifier's items are D01 (Demo data), D02 (WIN · PWSH), D10 (+ Hire), D11 (NEED YOU colour), D12 (the "EN" on the canvas is an energy bar label, not a language chip), D21 (+50 XP), D30 to D32 (run-mode labels), D34 (box codes).

Cheap spec items were built: D01 "Demo data", D11 `#ffca28`, D29 `CAGE n · NAME` plates. D34 box codes stay the task name because a box in the snapshot has no type; D21 needs XP; D30 to D32 need a run mode in the snapshot. Everything else is listed as not built with the snapshot field or screen it needs.

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

## Spec versus canvas conflicts (the operator decides; the choice made in the code is stated)

D16 stations (six, not five), D42 mood chip text colour (dark ink, 5.1 to 1, not cream, 3.14 to 1), D43 fonts (self-hosted, not Google Fonts), D44 language switch (Debug drawer, not Settings). `--demo` data: the spec says mock data, the sharpened prompt and the plan say to replay the recorded log; built the recorded log through the real reducer.

## Parked gates and gaps

- The real Claude run for the demo fixture stays parked on the operator's login (default not done). The fixture says it is scripted.
- Playwright is run against Chromium 1255 here. CI installs its own with `playwright install --with-deps chromium`.
- `npx agent-works --demo` needs the floor built (`src/dist`). Packaging the build into the published CLI is not part of this unit. Without a build, `--demo` prints how to build it and serves the plain dashboard page.
- Not done: type-prefixed box codes, XP, host chip, run-mode labels, shift log and the rest of the D-list marked `not-built`.
- Axe leaves 171 nodes undecided (mostly SVG text over art, header text over a gradient, and "✕" buttons whose label differs from their text). The scene label contrast in `axe.txt` is an estimate, not a proof.
- `deslop` is not installed: `/simplify` was run over the round 2 diff and `/no-comments` too (results in the trail).
- Every run used `TMPDIR=~/.cache/aw-p1-3-tmp` and the new tests clean up after themselves.
