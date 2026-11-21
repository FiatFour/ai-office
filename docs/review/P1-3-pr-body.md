## What this adds

The factory floor (480 by 270 pixel scene, one belt L1, station cells ORDER CODE TEST QC SHIP, four worker states, "!" for Action items, Action items drawer over a dimmed floor, keys 1 to 9 and D) and `agent-works --demo`, which replays `fixtures/demo/events.jsonl` through the same parser, reducer, ledger and snapshot path as `POST /api/events`. There is no separate mock data path. For the operator: `pnpm --filter @agent-works/floor build && node bin/agent-works.ts --demo` shows the recorded run from ticket to shipped. For the next engineer: a new snapshot state needs one row in `stationOf` or `moodOf` (`src/floor/model.ts`) and one case in `src/test/floor-state.test.ts`. ADR: `docs/decisions/0005-floor-view-and-demo-replay.md`.

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

## Round 3: what changed after the second verifier (NOT CLEAN at 9db7671: 1 blocker, 7 minors, 11 surviving mutants)

**B1, the premise.** Rounds 1 and 2 each found more differences missing from a hand-written list (8, then 10). The premise "a human-curated difference list is complete" cannot be shown by reading, so it is now checked by a machine. `src/scripts/inventory.mjs` extracts from the rendered canvas artboard and from the built floor (Playwright, computed styles, scene zones in viewBox units) every visible string, every distinct fill, stroke, background, border and text colour per element role, font family and size, scene class, role (icon, stripe, laser, LED, bubble, glyph, ARIA), animation name, shape counts and 4-unit-bucketed bounding boxes per zone, and boxes per station. Lane 9 (`src/e2e/lane9.mjs`) computes the symmetric difference and fails when:

- a differing key is in no entry's `covers:` list ("uncovered"), or in two entries
- an entry covers a key that no longer differs ("stale"), or a `fixed` entry covers a key that is missing or still differs, or a `not-built` entry covers a key only the built floor has
- a cell of the 12 by 9 pixel grid (mean colour distance above 40, `docs/review/P1-3-review-pixel-regions.md`, `docs/review/P1-3-review-pixel-heatmap.png`) is in no entry's `regions:` list
- the compare image is not two 720 px panes of the same size (marker strips found by reading the PNG) plus a legend, the committed image differs from a fresh one, or the image does not change when either input changes (re-composed with a hue-rotated copy of each input)

Numbers (measured, lane 9 note): **372 canvas-only, 99 built-only, 42 changed keys; 513 covered, 0 uncovered; 33 of 108 pixel cells hot, all inside a region.** The list went from 45 to 73 entries (D01 to D75, D67 and D71 unused). Inventory output is identical across two runs (diffed). 17 negative tests run inside lane 9 on mutated copies of the real inputs (entry deleted, covers key deleted, stale key, key covered twice, not-built relabelled fixed, a changed key relabelled fixed, fixed relabelled not-built, changed relabelled not-built over a built-only key, regions dropped, three entries only, PR body table stale, ADR table stale, a not-built text on the built floor, a fixed text gone, the NEED YOU colour, unequal panes, a plain screenshot as the compare image). Lane 9 fails if any of them does not fail.

Differences the verifier listed, now each a keyed entry: built-only header fields (D47), `N boxes · N shipped` (D49), logo icon (D50, fixed) and link (D51, not built), scene label colours (D52, fixed, and D53, conflict: the canvas cage plate is 4.24 to 1), sleep glyph (D54, fixed), "!" bubble (D55, fixed), box colours and motion (D56, D68, D75), per-cell top borders (D59), hazard stripe and dock (D73), cage LED and door gap (D57, fixed), sixth cage (D58), firewall frame, lights and lasers (D72, fixed), roll-up door (D73), toast truck icon and pop (D50, D62, fixed), gantry press and scan lines (D74, fixed). Everything else the tool found is in D46 to D75 or in an older entry. Cheap spec items built: those marked fixed. The rest stays not built.

| Minor | Fix | Test that fails without it |
| --- | --- | --- |
| M1 toast title | Lane 8 asserts the title in Thai and English, not only the detail | lane 8; mutant `toast-title-language-frozen` |
| M2 demo read-only with `AGENT_WORKS_DEMO_EVENTS` | Test starts the CLI with the variable set and expects 403 on three writes | `src/test/demo-cli.test.ts`; mutant `cli-demo-not-read-only-with-env` |
| M3 CSP strength | Test parses the policy of the floor, an asset, an API reply, an API error and the dashboard: connect-src is exactly `'self'` and the two loopback ws origins, frame-ancestors, object-src, base-uri, form-action are `'none'`, and the directive set is fixed | `src/test/demo.test.ts`; mutants `hq-csp-connect-any-ws`, `hq-csp-no-frame-ancestors`, `hq-csp-no-object-src` |
| M4 exit hook and blank line | A child process calls `process.exit(7)` mid-replay and the throw-away home must be gone; a line of only spaces or tabs is skipped and still counted in line numbers | `src/test/demo-cli.test.ts`, `src/test/demo.test.ts`; mutants `cli-demo-no-exit-hook`, `demo-fixture-blank-strict` |
| M5 Sarabun 400 | Lane 8 asserts the two loaded Sarabun faces are exactly 400 and 700 with the network blocked | lane 8; mutant `fonts-sarabun-400-missing` |
| M6 lane 9 negative tests | The 17 above, one per lane 9 assertion, including the verifier's v32 (not-built check), v33 (stale table) and v34 (minimum count) | mutants `lane9-notbuilt-check-off`, `lane9-stale-table-check-off`, `lane9-min-count-1` and 16 more |
| M7 orphan demo children | The mutation runner starts each command in its own process group and kills the group when it ends or times out, then checks `pgrep` for new `agent-works.ts` processes | the run prints "0 orphan demo processes" |

Floor changes made to close differences: label colours, firewall frame and four lasers, git and npm lights, dock wall, ramp and roll-up door, cage LED and door gap, QC yellow and red jumping boxes with per-colour bands, the two sleep letters, the "!" drawn from rectangles, the gantry press, scan lines and light stack, the header logo icon, the toast truck icon and pop animation, keyframes named as on the canvas. Cage plate colour stays `#2f343b` for contrast (D53).

Mutants: 109 total (90 unit and e2e, 19 lane 9), 0 survived. The verifier's survivors v10, v11, v12, v17, v19, v21, v30, v31, v32, v33, v34 are ported and killed. Two lane 9 mutants (`lane9-fixed-check-off`, `lane9-layout-widths-off`) survived the first run, which found two missing negative tests; both tests were added and both mutants are now killed.

## Boundary files: request for the operator to accept

This unit touches files outside `src/` that belong to the server, CI and workspace. The operator is asked to accept them:

- `server/hq.ts` (assets option, GET reaches `mode.route`, `readOnly`, security headers), `server/cli.ts` (`--demo`, signals, bad file exit), `server/assets.ts` (new), `server/modes/demo.ts` (new)
- `.github/workflows/ci.yml` (two new jobs: `src`, `floor-e2e`; every existing job kept)
- `pnpm-workspace.yaml` (adds `src`), `pnpm-lock.yaml` (adds `@fontsource/sarabun` 5.3.0)
- Root `package.json` and `tsconfig.base.json` are untouched, so root `pnpm typecheck` does not see `src`; the `src` CI job runs `pnpm --filter @agent-works/floor typecheck`.

## Verify, unit

`pnpm test` (root): 1346 tests, 51 files, all pass. `pnpm lint`: no errors, no warnings. Typecheck root and `src`: clean.

Mutants, `node src/scripts/mutants.mjs` (baseline PASS, 109 mutants, 0 survived; result files `/tmp/swarm-P1-3/owner/mutants-p1-3-r3.txt` and `mutants-lane9-r3.txt`). Tier unit runs `pnpm vitest run src/test`; tier e2e rebuilds the floor and runs `node src/e2e/lanes.mjs`; tier lane9 runs `node src/e2e/lane9.mjs`. Every command runs in its own process group and the group is killed afterwards.

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
| 7 axe-core | PASS: 0 violations, 3 named-exception nodes (color-contrast on the Needs you chip), 188 incomplete nodes recorded, `docs/review/P1-3-review-axe.txt` |
| 6 reduced motion | PASS |
| 3.5 six cages, seven workers | PASS |
| 9 canvas compare | PASS (73 entries, 513 inventory keys covered, 0 uncovered, 17 negative tests, see below) |

## Verify, perf (measured, 1440x900 headless Chromium on this machine, `node src/e2e/perf.mjs`)

- Gzipped JS bundle: 91.4 KB (limit 400 KB). One JS file; fonts and CSS are separate files.
- **Probe 1, 30 s against a real HQ** (`bin/agent-works.ts serve`, fed over HTTP `POST /api/events`, **six workers** and six boxes moving; the fixture has only two workers). rAF intervals, 1971 frames: p50 16.7 ms, p95 16.8 ms, p99 16.8 ms, max 16.8 ms, 0 frames over 50 ms. Main-thread render work (Layout, UpdateLayoutTree, Paint, PrePaint, Commit, Layerize, FunctionCall, EvaluateScript from a Chrome trace) per 16.7 ms window: p50 0.37 ms, p95 1.40 ms, max 8.1 ms.
- **Probe 2, 20 s during `--demo` itself** (the CLI replaying the fixture at one event a second, two workers, one box). rAF p95 16.7 ms, max 16.8 ms, 0 frames over 50 ms; work per frame p50 0.29 ms, p95 1.18 ms, max 2.4 ms.
- **A literal "rAF p95 <= 16.7 ms" reads 16.8 ms** in probe 1 and in the earlier runs. That interval is the 60 Hz vsync period (16.67 ms) plus jitter, so it cannot be below 16.7 and a literal reading fails by 0.1 ms. **The CI gate trips on work per frame p95 over 16.7 ms or rAF p95 over 33.4 ms** (a dropped frame), for both probes. The operator may want a different reading of the rule.
- No baseline, trunk empty.

## Canvas compare (lane 9): 73 entries

The artboard was rendered, not guessed: `docs/review/canvas/Main.dc.txt` is `project/Main.dc.html` (sha256 `13a3d20a…71198e`), `src/e2e/canvas.mjs` renders it from its own source without the claude.ai runtime. Image: `docs/review/P1-3-review-canvas-compare.png` (canvas left, built floor right, badge n on difference Dn, legend below). The list is `docs/review/P1-3-canvas-differences.md`; the verifier's items are D01 (Demo data), D02 (WIN · PWSH), D10 (+ Hire), D11 (NEED YOU colour), D12 (the "EN" on the canvas is an energy bar label, not a language chip), D21 (+50 XP), D30 to D32 (run-mode labels), D34 (box codes).

Cheap spec items were built: D01 "Demo data", D11 `#ffca28`, D29 `CAGE n · NAME` plates. D34 box codes stay the task name because a box in the snapshot has no type; D21 needs XP; D30 to D32 need a run mode in the snapshot. Everything else is listed as not built with the snapshot field or screen it needs.

<!-- differences:start -->
| id | status | what differs |
| --- | --- | --- |
| D01 | fixed | The demo chip, the Debug drawer's mode line and the `--demo` start line say "Demo data" as on the canvas (they said "Demo replay"). Operator call 2026-11-21, follow the canvas. The demo shows the recorded run's own worker names (nova, vega); the canvas crew (Captain, Byte, Pixel, Echo) is not copied in, because the recorded export is the demo's provenance and the snapshot has no field the canvas names would honestly fill. |
| D02 | not-built | Host chip (detected computer) in the run-mode button. The snapshot has no host or shell field. |
| D03 | not-built | Factory switcher ("FACTORY my-app", "3 lines", "+2 elsewhere"). Needs the factory park screen. |
| D04 | not-built | Order-board select (First active, Backlog). Needs boards. |
| D05 | not-built | Line speed buttons 1x, 2x, 4x. |
| D06 | not-built | Zoom out and zoom in buttons. |
| D07 | not-built | Run-mode chip ("MODE Cages / Sandbox cages · 6 running", WIN · PWSH, blinking dot). The snapshot has no run mode. |
| D08 | not-built | HQ menu: + New order, Setup, Preflight, Boards, Docs, PRs / MRs, Terminal, Settings. Built has Action items, Debug and a Settings button (see D44). Each target is a later screen. |
| D09 | not-built | Factory level 3 with a 340 / 500 XP bar. The snapshot has no level or XP. |
| D10 | not-built | "+ Hire" button in the crew header. A button with no screen behind it would be dead. |
| D11 | fixed | "N NEED YOU" in the crew header is #ffca28 as on the canvas (it was #ff8a80). Lane 9 reads the computed colour. |
| D12 | not-built | Crew rows: portrait, level, an energy bar labelled EN, a station line ("L1 web · Cage 1 · T-03"), a red border on a worker that needs you. Built rows have the key, the name and the mood chip. (EN on the canvas is the energy bar, not a language chip.) |
| D13 | not-built | Shift log feed (nine lines with icons and ages). The snapshot has no feed. |
| D14 | not-built | Shift clock (SHIFT 2, 19:58, 4 shipped). |
| D15 | not-built | Production order title "Sprint 1 — Auth + Billing" and the per-line list (L1 2 boxes, L2 1 blocked, L3 TEMP-1 on it). |
| D16 | fixed | Station cells. Five cells as on the canvas (ORDER, CODE, TEST, QC, SHIP) in capitals. Operator call 2026-11-21, follow the canvas over the plan and sharpened prompt (six, with MERGE). This is a display change only: `stationOf` and the lifecycle reducer keep six states, the scene still draws the MERGE gantry and the shipping dock where the canvas draws them, and a box in merge, shipping or shipped counts under SHIP (`panelOf` in `src/floor/model.ts`). |
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
| D42 | conflict | Mood chip colours. Operator call 2026-11-21, follow the canvas: the "Needs you" chip is cream #f5f3ec on #ef5350 as on the canvas, which is 3.14 to 1 against the 4.5 to 1 target. The other three chips already match the canvas. Named exception, narrow and not a pass: only axe rule `color-contrast` (lane 7 of `src/e2e/lanes.mjs`, `isNeedsChip` in `src/e2e/harness.mjs`) reports it, on nodes that are a `.chip[data-mood="needs"]` with exactly #f5f3ec on #ef5350 and a ratio of 3.14; any other colour, ratio or element is still a violation, the gate is not weakened for anything else, and `axe.txt` lists every excepted node. A person who needs 4.5 to 1 sees low contrast on this one chip; its text and the "!" button carry the same state. |
| D43 | conflict | Fonts. Operator call 2026-11-21 was follow the canvas. The built floor already draws the canvas's four faces (Silkscreen, Press Start 2P, Pixelify Sans, VT323) at the canvas sizes; the only difference left is delivery. The canvas loads them from Google Fonts at runtime, which would break lane 7.5 (no request to a host other than HQ), the `font-src 'self'` policy pinned in `src/test/demo.test.ts`, and the spec rule of no network at runtime. Left as it is, for the operator to decide: built serves the same four from @fontsource, plus Sarabun for Thai glyphs the pixel faces lack. |
| D44 | changed | Language switch. Operator call 2026-11-21, follow the canvas: the floor header has no language switch, and the canvas HQ menu has a Settings entry. Built now has the same Settings button in the HQ menu, which opens a Settings drawer with Project and Language, the place the spec names (Settings, Project, Language). The switch left the Debug drawer. The canvas Settings is a separate page (`Settings.dc.html`) that is not built; the drawer holds only the language. |
| D45 | changed | HUD frame. The canvas HUD is a two-row header laid over the scene, 32 px controls and a 5 percent by 11 percent hit area per worker. Built is a one-row header above the scene, 28 to 32 px buttons, and a 44 px "!" target at 390 px. |
| D46 | changed | Roster. The canvas draws Captain, Byte, Pixel, Nova, Echo and Temp-1 (their names, plates and cage plates); the built floor draws the workers HQ reports, with the hair, skin and shirt colours of its six slots. |
| D47 | changed | Built-only header fields: "Snapshot rev N", the connection state "Live" or "Reconnecting", and "Replaying N of M events" in demo. The canvas header has none of them. |
| D48 | changed | Built-only page heading "Factory floor" (visually hidden, for screen readers and the landmark outline). |
| D49 | changed | Built-only "N boxes · N shipped" line in the right panel under the station counters (the canvas shows "N shipped" in the shift clock and "N boxes" per line). |
| D50 | fixed | Pixel icons: the factory logo in the header and the truck in the toast are drawn as on the canvas (26 px and 34 px SVG art, aria-hidden). |
| D51 | not-built | The logo is a link to the industrial park ("Industrial park: all factories"). The park screen is not built, so a link would be dead. |
| D52 | fixed | Scene label colours DISPATCH (#455a64), BREAK +ENERGY (#5d4037) and PR RACK (#454b55) are the canvas colours; they were near-black (#15181c). |
| D53 | conflict | Cage plate colour. The canvas plate is #454b55 (4.24 to 1 on the cage floor, under 4.5); built keeps #2f343b so the label passes. |
| D54 | fixed | Sleep glyph: a small "z" and a larger "Z" in Press Start 2P, cream with an ink outline, rising, as on the canvas (built had one "z Z" string in Silkscreen). |
| D55 | fixed | The "!" bubble is the canvas art (ink frame, yellow face, ink bar and dot) and jumps. It was a yellow box with a Press Start 2P glyph. The hit target stays a 44 px button. |
| D56 | changed | Box colours and motion. Built now colours a box at QC yellow, one with changes requested red with the jump motion, a scrapped one gray, others blue, each with the canvas band colour. The canvas also has blue boxes on lines 2 and 3, a gray idle box and the HOTFIX tag (D33), and colours by what the box waits for, which the snapshot does not carry. |
| D57 | fixed | Cage status LED and the door gap in the right wall of every cage, coloured by mood (green working, yellow at QC, red needs you, gray on break). |
| D58 | conflict | Sixth cage placement. The canvas puts the temp bay (TEMP BAY, hired for L3) in slot 6 and has five cages; the plan and the sharpened prompt name six cages, so built draws a sixth cage there with its own plate and LED. |
| D59 | not-built | Per-cell top-border colours on the station cells, the order-line chips and the hotbar badges (ORDER gray, CODE blue, TEST orange, QC yellow, SHIP green). Built station counters have one border colour. |
| D60 | changed | HUD colours. The canvas HUD paints about 70 distinct background, border and text colours (page #1f2328, plates #15181c, chips per status, runtime badges #00add8 and #c74634); built paints its own smaller set from floor.css variables. |
| D61 | changed | Built-only panel colours and sizes: the Action items list (#15181c rows with a #ffca28 top border), the 12 px Silkscreen headings, #c9cdd4 body text. |
| D62 | fixed | Animations: bob, jump, blink, zz, belt, press, tA, tB and pop use the canvas names and keyframes (the typing arms were typeA and typeB, the gantry press and the toast pop were missing). |
| D63 | changed | Cage detail. The canvas draws a desk shadow line, a per-worker monitor with coloured lines and a lamp, and a LED colour per worker; built draws one desk, one monitor and the LED by mood. Cage counts per zone differ (canvas 17 to 44 shapes, built 9). |
| D64 | not-built | ARIA group on the canvas control panel (the hotbar and menu). Built has no hotbar or menu group. |
| D65 | changed | Built-only DOM and ARIA: the scene is role="img" with a label, and main, h1, aside, h2 and p landmarks the canvas does not have. |
| D66 | changed | HUD font sizes. The canvas HUD mixes 7 to 16 px in Silkscreen, Press Start 2P, VT323 and Pixelify Sans; built uses 9 to 17 px in the same families. |
| D68 | changed | Boxes per station. The canvas draws 2 at ORDER, 3 at CODE and 4 at QC; built draws the boxes of its snapshot (the live run has two in QC and none elsewhere), so the counts differ by design. |
| D69 | changed | DOM element counts per tag differ: the canvas HUD has about 25 buttons, 200 spans and 30 divs; built has 7 buttons and 24 spans. |
| D70 | not-built | DOM elements only on the canvas: 19 links (menu), a label and line breaks. |
| D72 | fixed | Firewall frame (four red edges), the git and npm lights and the four scan lasers are the canvas shapes. The counters and blocked packets are not built (D23). |
| D73 | fixed | Shipping dock: the hazard stripe, the left wall edge, the side ramp and the roll-up door with its blue bumper are the canvas shapes. The truck load is not built (D24). |
| D74 | fixed | TEST scan lines, the QC press and light stack, and the MERGE pads are drawn as on the canvas. |
| D75 | changed | Built-only SHIPPED stamp on a delivered box (green), next to SCRAPPED and CHANGES; the canvas has the HOTFIX and BLOCKED tags only (D33). |
<!-- differences:end -->

## Spec versus canvas conflicts (the operator decides; the choice made in the code is stated)

Operator answered 2026-11-21: follow the canvas on all five. D16 stations are five cells (display only, the reducer keeps six states). D42 the Needs you chip is cream on #ef5350 as on the canvas, 3.14 to 1; the only exception is axe `color-contrast` on `.chip[data-mood="needs"]` with exactly those colours, listed in `axe.txt`, no gate weakened elsewhere. D43 fonts: the four faces already match; loading them from Google Fonts would break lane 7.5 and the CSP, so delivery stays @fontsource and the call is left to the operator. D44 the language switch is in a Settings drawer opened from the HQ menu entry the canvas has. `--demo` says "Demo data" in the chip, the Debug mode line and the start line; the data is the recorded log through the real reducer.

## Parked gates and gaps

- The real Claude run for the demo fixture stays parked on the operator's login (default not done). The fixture says it is scripted.
- Playwright is run against Chromium 1255 here. CI installs its own with `playwright install --with-deps chromium`.
- `npx agent-works --demo` needs the floor built (`src/dist`). Packaging the build into the published CLI is not part of this unit. Without a build, `--demo` prints how to build it and serves the plain dashboard page.
- Not done: type-prefixed box codes, XP, host chip, run-mode labels, shift log and the rest of the D-list marked `not-built`.
- Axe leaves 188 nodes undecided (mostly SVG text over art, header text over a gradient, and "✕" buttons whose label differs from their text). The scene label contrast in `axe.txt` is an estimate, not a proof.
- `deslop` is not installed: `/simplify` was run over the round 2 diff and `/no-comments` too (results in the trail).
- Every run used `TMPDIR=~/.cache/aw-p1-3-tmp` and the new tests clean up after themselves.
