# Canvas floor artboard versus the built floor

Source of the canvas side: `docs/review/canvas/Main.dc.txt` (the artboard `project/Main.dc.html`, sha256 13a3d20a321f0ca69c98d9a38b24df80d77f3909477a785b2b3a86a5ae71198e), rendered by `src/e2e/canvas.mjs`.

**This list is checked against a machine-made inventory, not against a reader.** A hand-written list of differences cannot be shown complete by reading it (round 1 found 8 missing, round 2 found 10 more), so lane 9 of `src/e2e/lanes.mjs` (`src/e2e/lane9.mjs`) builds `src/scripts/inventory.mjs` inventories of the rendered canvas artboard and of the built floor and fails if they differ in anything this file does not name. The inventory holds, from the rendered DOM and SVG with computed styles and the scene zones in viewBox units:

- `text:` every visible string (lower case, digits as `#`)
- `paint:<zone>:<shape|text>:<fill|stroke>:<colour>` and `paint:dom:<tag>:<bg|color|border-side>:<colour>` every distinct colour per role
- `shape:<zone>:<tag>` count and a hash of the 4-unit-bucketed bounding boxes, `shape:dom:<tag>` counts
- `font:` family and size, `class:` scene classes, `role:` icon, stripe, laser, LED, bubble, glyph and ARIA roles, `anim:` animation names, `boxes:` boxes per station

Each line below is `id | status | text on the canvas | text on the built floor | what differs`. The indented lines under it are the contract with the inventory:

- `covers:` the inventory keys this entry accounts for, `;;` separated. Every key that differs between the two sides must be in exactly one entry (else lane 9 fails "uncovered"). A key in an entry that no longer differs fails "stale". For `fixed` the key must be on both sides with the same value. A `not-built` entry may not cover a built-only key.
- `regions:` cells of the 12 by 9 grid of the 1440 by 900 renders, `R<first row>-<last row>C<first col>-<last col>`. Every cell whose mean colour distance is above 40 (`docs/review/P1-3-review-pixel-regions.md`, heatmap `docs/review/P1-3-review-pixel-heatmap.png`) must be inside one.

Status: `fixed` (built now equals the canvas), `changed` (both show something, different, or built adds something), `not-built` (the canvas shows it, built does not; a later unit or a snapshot field is needed), `conflict` (the spec and the canvas disagree, the choice made is stated). A text on the canvas is checked to be on the rendered artboard, and for `not-built` to be absent from the built floor. A `-` means there is no text to look up.

D01 | fixed | Demo data | - | The demo chip, the Debug drawer's mode line and the `--demo` start line say "Demo data" as on the canvas (they said "Demo replay"). Operator call 2026-11-21, follow the canvas. The demo shows the recorded run's own worker names (nova, vega); the canvas crew (Captain, Byte, Pixel, Echo) is not copied in, because the recorded export is the demo's provenance and the snapshot has no field the canvas names would honestly fill.
  covers: text:demo data
D02 | fixed | WIN · PWSH | - | Host chip (detected computer) in the run-mode chip, from the snapshot's host field. The lane starts HQ with AGENT_WORKS_HOST=windows, the computer the canvas is drawn for, so the compare does not depend on the lane machine.
  covers: text:win · pwsh
D03 | not-built | elsewhere | - | Factory switcher ("FACTORY my-app", "3 lines", "+2 elsewhere"). Needs the factory park screen.
  covers: text:# lines ;; text:+# elsewhere ;; text:factory
  covers: text:my-app ;; text:▾
D04 | not-built | Order board | - | Order-board select (First active, Backlog). Needs boards.
  covers: text:order board
D05 | not-built | 4x | - | Line speed buttons 1x, 2x, 4x.
  covers: text:#x
D06 | not-built | Zoom in | - | Zoom out and zoom in buttons.
  covers: text:+ ;; text:−
D07 | fixed | Sandbox cages | - | Run-mode chip ("MODE Cages | Sandbox cages · 6 running", WIN · PWSH, dot). The count is the cages HQ holds. Cages is the only run mode.
  covers: text:cages ;; text:mode ;; text:sandbox cages · running
  covers: text:|
D08 | not-built | Preflight | - | HQ menu: + New order, Setup, Preflight, Boards, Docs, PRs / MRs, Terminal, Settings. Built has Action items, Debug and a Settings button (see D44). Each target is a later screen.
  covers: text:+ new order ;; text:boards ;; text:docs · #
  covers: text:preflight · # ✕ ;; text:prs / mrs · #
  covers: text:setup · # ;; text:terminal
  regions: R1-1C1-12
D09 | not-built | Factory level | - | Factory level 3 with a 340 / 500 XP bar. The snapshot has no level or XP.
  covers: text:# / # xp ;; text:factory level
D10 | not-built | + Hire | - | "+ Hire" button in the crew header. A button with no screen behind it would be dead.
  covers: text:+ hire
D11 | fixed | need you | - | "N NEED YOU" in the crew header is #ffca28 as on the canvas (it was #ff8a80). Lane 9 reads the computed colour.
  covers: text:# need you ;; paint:dom:span:color:#ffca28
D12 | not-built | Dispatch office | - | Crew rows: portrait, level, an energy bar labelled EN, a station line ("L1 web · Cage 1 · T-03"), a red border on a worker that needs you. Built rows have the key, the name and the mood chip. (EN on the canvas is the energy bar, not a language chip.)
  covers: text:break room ;; text:dispatch office ;; text:en
  covers: text:l# api · cage # · t-# ;; text:l# contracts · cage # · c-# ;; text:l# web · cage # · t-#
  covers: text:l# web · pr ## at qc
  regions: R2-5C1-2
D13 | not-built | Shift log | - | Shift log feed (nine lines with icons and ages). The snapshot has no feed.
  covers: text:#m ;; text:#s ;; text:byte picked up box t-# clerk sign-in
  covers: text:cage # blocked api.stripe.com (nova) ;; text:captain → byte: pull main, start t-# ;; text:echo (peer) sent pr ## back: # change
  covers: text:nova opened mr !# on gitlab (draft) ;; text:pixel carried pr ## to qc ;; text:pixel reached level #
  covers: text:pr ## merged · loaded on truck ;; text:shift log ;; text:you approved temp-# for l# contracts
  covers: text:▲ ;; text:▸ ;; text:★
  covers: text:✉ ;; text:✦
  regions: R6-8C1-2
D14 | not-built | Shift 2 | - | Shift clock (SHIFT 2, 19:58, 4 shipped).
  covers: text:# shipped ;; text:#:# ;; text:shift #
D15 | not-built | Sprint 1 | - | Production order title "Sprint 1 — Auth + Billing" and the per-line list (L1 2 boxes, L2 1 blocked, L3 TEMP-1 on it).
  covers: text:# blocked ;; text:# boxes ;; text:sprint # — auth + billing
  covers: text:temp-# on it
  regions: R2-3C11-12
D16 | fixed | SHIP | SHIP | Station cells. Five cells as on the canvas (ORDER, CODE, TEST, QC, SHIP) in capitals. Operator call 2026-11-21, follow the canvas over the plan and sharpened prompt (six, with MERGE). This is a display change only: `stationOf` and the lifecycle reducer keep six states, the scene still draws the MERGE gantry and the shipping dock where the canvas draws them, and a box in merge, shipping or shipped counts under SHIP (`panelOf` in `src/floor/model.ts`).
  covers: text:ship
D17 | not-built | S-1 waits | - | Shipment status line "S-1 waits for L1 + L3 · 4 / 9 on the truck".
  covers: text:s-# waits for l# + l# · # / # on the truck
D18 | not-built | Worker file | - | Selected worker card: role and runtime line, EN and XP bars, TOOLS, a terminal, blocked sites with Allow and Dismiss, Worker file and Message buttons. Built has state, box, station and one line of text.
  covers: text:allow ;; text:developer · claude code · l# api · cage # · t-# ;; text:dismiss
  covers: text:message ;; text:tools ;; text:worker file
  covers: text:xp ;; text:“my cage blocked api.stripe.com. can you open it?” ;; text:└ blocked by sandbox policy
  covers: text:█ ;; text:● bash(curl api.stripe.com) ;; text:⚠ api.stripe.com:#
  covers: text:⚠ mcp.notion.com:# ;; text:✻ asking hq for access… ;; text:❯
  regions: R4-9C11-12
D19 | not-built | Inspect PRs at the QC gate | - | Hotbar Q W E R T Y (Order, QC, Unlock, Stop, Term, Hire) with badges.
  covers: text:e ;; text:hire ;; text:q
  covers: text:r ;; text:stop ;; text:t
  covers: text:term ;; text:unlock ;; text:w
  covers: text:y
  regions: R8-9C3-9
D20 | not-built | Factory map | - | Factory map (minimap) above the shift clock.
D21 | not-built | +50 XP | - | "+50 XP" rising over the PR rack and in the toast. The snapshot has no XP.
  covers: anim:rise ;; class:rise ;; paint:prrack:text:fill:#66bb6a
  covers: text:+# xp
D22 | changed | PR #12 merged | merged and shipped | Toast text. Canvas "SHIPMENT DELIVERED / PR #12 merged · +50 XP". Built "Shipment delivered / alpha/p12c merged and shipped", from the task, in the active language.
  covers: text:alpha/p#c merged and shipped ;; text:pr ## merged · +# xp
D23 | not-built | - | - | The blocked packets in the FIREWALL gate. The counter under the gate is built (D79).
  covers: paint:firewall:shape:fill:#f5f3ec ;; role:laser:floor
  covers: role:led:firewall ;; shape:firewall:rect
  regions: R2-4C6-7
D24 | not-built | 4 / 9 LOADED | - | Truck load, the v0.1 label, the crates and the empty slots. Built truck is a blank door (38 by 40 px, the canvas truck is 38 by 78).
  covers: font:svg:silkscreen:3.4px ;; paint:dock:shape:stroke:#9aa1ab ;; paint:dock:text:fill:#454b55
  covers: shape:dock:rect ;; shape:dock:text ;; shape:dock:use#crate
  covers: text:# / # loaded ;; text:v#.#
  regions: R2-8C9-10
D25 | not-built | Shipments | - | Shipments board (S-1 sign-in · L1+L3, S-2 webhook · L2, "truck waits for all PRs").
  covers: paint:dock:shape:fill:#26c6da ;; paint:dock:shape:fill:#cbc4b1 ;; paint:dock:shape:fill:#ff77a8
  covers: text:s-# sign-in · l#+l# ;; text:s-# webhook · l# ;; text:shipments
  covers: text:truck waits for all prs
D26 | not-built | #15 | - | PR rack cards #11, #12, #14, #15. Built rack is art only.
  covers: paint:prrack:shape:fill:#66bb6a ;; paint:prrack:shape:fill:#9aa1ab ;; paint:prrack:shape:fill:#ffca28
  covers: paint:prrack:text:fill:#15181c ;; paint:prrack:text:stroke:#15181c ;; shape:prrack:rect
  covers: shape:prrack:text ;; text:##
  regions: R2-4C7-8
D27 | not-built | L3 shared-contracts | - | Three lines L1 to L3 with names, three belts and the shared-line mark. Built has one belt labelled "L1".
  covers: paint:line2:shape:fill:#15181c ;; paint:line2:shape:fill:#26c6da ;; paint:line2:shape:fill:#42a5f5
  covers: paint:line2:shape:fill:#b71c1c ;; paint:line2:shape:fill:#ef5350 ;; paint:line2:shape:fill:pattern:belt
  covers: paint:line2:shape:stroke:#15181c ;; paint:line2:text:fill:#15181c ;; paint:line3:shape:fill:#15181c
  covers: paint:line3:shape:fill:#1565c0 ;; paint:line3:shape:fill:#42a5f5 ;; paint:line3:shape:fill:#6b7280
  covers: paint:line3:shape:fill:#9aa1ab ;; paint:line3:shape:fill:#ff77a8 ;; paint:line3:shape:fill:pattern:belt
  covers: paint:line3:shape:stroke:#15181c ;; paint:line3:text:fill:#15181c ;; shape:line2:rect
  covers: shape:line2:text ;; shape:line3:rect ;; shape:line3:text
  covers: text:l# my-app-api ;; text:l# my-app-web ;; text:l# shared-contracts ⇄
  regions: R4-8C5-9
D28 | not-built | Temp bay | - | Temp bay (hired for L3 · 4m, leaves after 15m idle) and the TEMP-1 worker with an orange hat.
  covers: font:svg:vt323:3.8px ;; text:cage # · temp-# ;; text:hired for l# · #m
  covers: text:leaves after #m idle ;; text:temp bay
D29 | fixed | CAGE 1 · | CAGE 1 · | "CAGE n · NAME" plate under every cage, as on the canvas.
  covers: text:cage # · nova
D30 | not-built | SUBAGENT · BYTE | - | Run-mode label on each cage in subagent modes. The snapshot has no run mode.
D31 | not-built | SHARED CAGE · CAPTAIN + 5 | - | Shared-cage banner over the cages in the one-cage subagent mode.
D32 | not-built | OFF · NO SANDBOX | - | "FIREWALL OFF · NO SANDBOX" panel ("agents use this computer") when subagents run on the host.
D33 | not-built | HOTFIX | - | HOTFIX, BLOCKED and ASKS YOU stamps. Built has SHIPPED, SCRAPPED and CHANGES only.
  covers: text:blocked ;; text:hotfix
D34 | changed | D1 | P12C | Box codes. The canvas prefixes a box type (D1, T3, C2, T6, T5, C1). Built shows the task name in capitals (P12C), because a box in the snapshot has no type. The full task name is in the box title.
  covers: role:glyph:line1:d1 ;; role:glyph:line1:t3 ;; role:glyph:line2:t6
  covers: role:glyph:line3:c1 ;; role:glyph:line3:c2 ;; role:glyph:stations:t5
  covers: text:c# ;; text:d# ;; text:one
  covers: text:p#c ;; text:t# ;; text:two
D35 | not-built | LV7 | - | Worker plate: level, name and an energy bar over every worker, a white-hat lead with a clipboard (CAPTAIN), thought bubble text. Built plates are the name only and every hat is yellow.
  covers: paint:break:shape:fill:#9b9b9b ;; paint:break:shape:fill:#b5654a ;; paint:break:shape:fill:#ffffff
  covers: paint:cage1:shape:fill:#000000 ;; paint:cage1:shape:fill:#1f2328 ;; paint:cage1:shape:fill:#2fbf71
  covers: paint:cage1:shape:fill:#3a3f4a ;; paint:cage1:shape:fill:#4a2f27 ;; paint:cage1:shape:fill:#b5654a
  covers: paint:cage1:shape:fill:#e0a878 ;; paint:cage1:shape:fill:#f5f3ec ;; paint:cage1:shape:fill:#fff59d
  covers: paint:cage1:shape:fill:#ffffff ;; paint:cage3:shape:fill:#000000 ;; paint:cage3:shape:fill:#1b1730
  covers: paint:cage3:shape:fill:#1f2328 ;; paint:cage3:shape:fill:#3a3f4a ;; paint:cage3:shape:fill:#5ab0ff
  covers: paint:cage3:shape:fill:#b5654a ;; paint:cage3:shape:fill:#c68642 ;; paint:cage3:shape:fill:#f5f3ec
  covers: paint:cage3:shape:fill:#fff59d ;; paint:cage3:shape:fill:#ffffff ;; paint:cage5:shape:fill:#6d4c41
  covers: paint:cage5:shape:fill:#78909c ;; paint:cage5:shape:fill:#b5654a ;; paint:cage5:shape:fill:#e0a878
  covers: paint:cage5:shape:fill:#f5f3ec ;; paint:cage5:shape:fill:#ffffff ;; paint:dispatch:shape:fill:#000000
  covers: paint:dispatch:shape:fill:#1f2328 ;; paint:dispatch:shape:fill:#3a3f4a ;; paint:dispatch:shape:fill:#4a2f27
  covers: paint:dispatch:shape:fill:#b5654a ;; paint:dispatch:shape:fill:#d97757 ;; paint:dispatch:shape:fill:#f2c79b
  covers: paint:dispatch:shape:fill:#fff59d ;; paint:dispatch:shape:fill:#ffffff ;; paint:dispatch:text:fill:#f5f3ec
  covers: paint:dock:shape:fill:#000000 ;; paint:floor:shape:fill:#000000 ;; paint:line2:text:fill:#f5f3ec
  covers: paint:line3:shape:fill:#b06cff ;; paint:line3:text:fill:#f5f3ec ;; text:byte
  covers: text:captain ;; text:echo ;; text:pixel
  covers: text:temp-#
D36 | not-built | 3 LINES · 1 FACTORY | - | Floor caption.
  covers: paint:floor:text:fill:#bdb6a2 ;; text:# lines · # factory
D37 | not-built | - | - | Yard art: trees, crates, the truck lane and the fence posts.
  covers: paint:floor:shape:fill:#6b7078 ;; shape:floor:rect ;; shape:floor:text
  covers: shape:floor:use#tree
D38 | not-built | - | - | Dispatch office desks and monitors, break room vending machine, coffee and sofa detail. Built draws the window, the orders board and the sofa only.
  covers: paint:break:shape:fill:#454b55 ;; paint:break:shape:fill:#5d4037 ;; paint:break:shape:fill:#66bb6a
  covers: paint:break:shape:fill:#90caf9 ;; paint:break:shape:fill:#9aa1ab ;; paint:break:shape:fill:#c62828
  covers: paint:dispatch:shape:fill:#0d1a24 ;; paint:dispatch:shape:fill:#42a5f5 ;; paint:dispatch:shape:fill:#454b55
  covers: paint:dispatch:shape:fill:#455a64 ;; paint:dispatch:shape:fill:#546e7a ;; paint:dispatch:shape:fill:#5d4037
  covers: paint:dispatch:shape:fill:#66bb6a ;; paint:dispatch:shape:fill:#8d6e63 ;; paint:dispatch:shape:fill:#9aa1ab
  covers: paint:dispatch:shape:fill:#ef5350 ;; paint:dispatch:shape:fill:#ffca28 ;; role:led:dispatch
  covers: shape:break:ellipse ;; shape:break:rect ;; shape:break:text
  covers: shape:dispatch:ellipse ;; shape:dispatch:rect ;; shape:dispatch:text
  regions: R2-4C3-6
D39 | changed | - | - | Belt: the canvas belt is 138 px wide and ends before the dock, built is 150 px and runs into the SHIPPING bay, so the box rests on the dock. Belt animation is a pattern shift (0.6 s) against the canvas 30 px slide (2.4 s).
  covers: paint:line1:text:fill:#454b55 ;; role:glyph:line1:l1 ;; shape:line1:rect
  covers: shape:line1:text ;; text:l#
D40 | changed | - | - | Station labels. Built draws ORDER and CODE under the belt (the canvas has no such labels) and TEST, QC, MERGE in darker ink for contrast than the canvas (#8a3500, #6b4f00, #1b5e20 against #e65100, #c79a00, #2e7d32).
  covers: paint:stations:text:fill:#1b5e20 ;; paint:stations:text:fill:#2e7d32 ;; paint:stations:text:fill:#6b4f00
  covers: paint:stations:text:fill:#8a3500 ;; paint:stations:text:fill:#c79a00 ;; paint:stations:text:fill:#e65100
D41 | changed | - | - | Worker movement. Canvas workers loop along the floor and a QC worker carries a labelled PR box on its head. Built places the worker at the cage, the break room or the QC gantry by mood and moves it between them with a stepped transition; the carried box is an unlabelled blue block.
  covers: class:mover ;; paint:stations:shape:fill:#1565c0 ;; paint:stations:shape:fill:#1b1730
  covers: paint:stations:shape:fill:#26c6da ;; paint:stations:shape:fill:#42a5f5 ;; paint:stations:shape:fill:#454b55
  covers: paint:stations:shape:fill:#5ab0ff ;; paint:stations:shape:fill:#8d6e63 ;; paint:stations:shape:fill:#c68642
  covers: paint:stations:shape:fill:#e2557a ;; paint:stations:shape:fill:#f2c79b ;; paint:stations:shape:fill:#ff9f43
  covers: paint:stations:shape:stroke:#15181c ;; shape:stations:ellipse ;; shape:stations:rect
  covers: shape:stations:text
D42 | conflict | - | - | Mood chip colours. Operator call 2026-11-21, follow the canvas: the "Needs you" chip is cream #f5f3ec on #ef5350 as on the canvas, which is 3.14 to 1 against the 4.5 to 1 target. The other three chips already match the canvas. Named exception, narrow and not a pass: only axe rule `color-contrast` (lane 7 of `src/e2e/lanes.mjs`, `isNeedsChip` in `src/e2e/harness.mjs`) reports it, on nodes that are a `.chip[data-mood="needs"]` with exactly #f5f3ec on #ef5350 and a ratio of 3.14; any other colour, ratio or element is still a violation, the gate is not weakened for anything else, and `axe.txt` lists every excepted node. A person who needs 4.5 to 1 sees low contrast on this one chip; its text and the "!" button carry the same state.
D43 | conflict | - | - | Fonts. Operator call 2026-11-21 was follow the canvas. The built floor already draws the canvas's four faces (Silkscreen, Press Start 2P, Pixelify Sans, VT323) at the canvas sizes; the only difference left is delivery. The canvas loads them from Google Fonts at runtime, which would break lane 7.5 (no request to a host other than HQ), the `font-src 'self'` policy pinned in `src/test/demo.test.ts`, and the spec rule of no network at runtime. Left as it is, for the operator to decide: built serves the same four from @fontsource, plus Sarabun for Thai glyphs the pixel faces lack.
D44 | changed | - | - | Language switch. Operator call 2026-11-21, follow the canvas: the floor header has no language switch, and the canvas HQ menu has a Settings entry. Built now has the same Settings button in the HQ menu, which opens a Settings drawer with Project and Language, the place the spec names (Settings, Project, Language). The switch left the Debug drawer. The canvas Settings is a separate page (`Settings.dc.html`) that is not built; the drawer holds only the language.
D45 | changed | - | - | HUD frame. The canvas HUD is a two-row header laid over the scene, 32 px controls and a 5 percent by 11 percent hit area per worker. Built is a one-row header above the scene, 28 to 32 px buttons, and a 44 px "!" target at 390 px.
D46 | changed | - | - | Roster. The canvas draws Captain, Byte, Pixel, Nova, Echo and Temp-1 (their names, plates and cage plates); the built floor draws the workers HQ reports, with the hair, skin and shirt colours of its six slots.
  covers: paint:break:shape:fill:#1b1730 ;; paint:break:shape:fill:#2fbf71 ;; paint:break:shape:fill:#4a2f27
  covers: paint:break:shape:fill:#5ab0ff ;; paint:break:shape:fill:#6d4c41 ;; paint:break:shape:fill:#c68642
  covers: paint:break:shape:fill:#e0a878 ;; paint:break:shape:fill:#e2557a ;; paint:break:shape:fill:#ff9f43
  covers: paint:cage5:shape:fill:#9b9b9b ;; paint:cage5:shape:fill:#d97757 ;; paint:cage5:shape:fill:#f2c79b
  covers: paint:cage6:shape:fill:#000000 ;; paint:cage6:shape:fill:#1f2328 ;; paint:cage6:shape:fill:#3a3f4a
  covers: paint:cage6:shape:fill:#4a2f27 ;; paint:cage6:shape:fill:#78909c ;; paint:cage6:shape:fill:#c68642
  covers: paint:cage6:shape:fill:#f5f3ec ;; paint:cage6:shape:fill:#fff59d ;; text:atlas
  covers: text:cage # · atlas ;; text:cage # · byte ;; text:cage # · echo
  covers: text:cage # · juno ;; text:cage # · kai ;; text:cage # · lyra
  covers: text:cage # · orion ;; text:cage # · pixel ;; text:cage # · vega
  covers: text:juno ;; text:kai ;; text:lyra
  covers: text:orion ;; text:vega
D47 | changed | - | Snapshot rev | Built-only header fields: "Snapshot rev N", the connection state "Live" or "Reconnecting", and "Replaying N of M events" in demo. The canvas header has none of them.
  covers: text:live ;; text:replaying # of # events ;; text:snapshot rev
D48 | changed | - | Factory floor | Built-only page heading "Factory floor" (visually hidden, for screen readers and the landmark outline).
  covers: font:dom:pixelify sans:28px ;; text:factory floor
D49 | changed | - | - | Built-only "N boxes · N shipped" line in the right panel under the station counters (the canvas shows "N shipped" in the shift clock and "N boxes" per line).
  covers: text:# box · # shipped ;; text:# boxes · # shipped
D50 | fixed | - | - | Pixel icons: the factory logo in the header and the truck in the toast are drawn as on the canvas (26 px and 34 px SVG art, aria-hidden).
  covers: role:icon
D51 | not-built | - | - | The logo is a link to the industrial park ("Industrial park: all factories"). The park screen is not built, so a link would be dead.
D52 | fixed | - | - | Scene label colours DISPATCH (#455a64), BREAK +ENERGY (#5d4037) and PR RACK (#454b55) are the canvas colours; they were near-black (#15181c).
  covers: paint:dispatch:text:fill:#455a64 ;; paint:break:text:fill:#5d4037 ;; paint:prrack:text:fill:#454b55
D53 | conflict | - | - | Cage plate colour. The canvas plate is #454b55 (4.24 to 1 on the cage floor, under 4.5); built keeps #2f343b so the label passes.
  covers: paint:cage1:text:fill:#2f343b ;; paint:cage1:text:fill:#454b55 ;; paint:cage1:text:fill:#f5f3ec
  covers: paint:cage2:text:fill:#2f343b ;; paint:cage2:text:fill:#454b55 ;; paint:cage3:text:fill:#2f343b
  covers: paint:cage3:text:fill:#454b55 ;; paint:cage3:text:fill:#f5f3ec ;; paint:cage4:text:fill:#2f343b
  covers: paint:cage4:text:fill:#454b55 ;; paint:cage5:text:fill:#2f343b ;; paint:cage5:text:fill:#454b55
  covers: paint:cage6:text:fill:#15181c ;; paint:cage6:text:fill:#2f343b ;; paint:cage6:text:fill:#454b55
  covers: paint:cage6:text:fill:#f5f3ec
D54 | fixed | - | - | Sleep glyph: a small "z" and a larger "Z" in Press Start 2P, cream with an ink outline, rising, as on the canvas (built had one "z Z" string in Silkscreen).
  covers: role:glyph:break:z
D55 | fixed | - | - | The "!" bubble is the canvas art (ink frame, yellow face, ink bar and dot) and jumps. It was a yellow box with a Press Start 2P glyph. The hit target stays a 44 px button.
  covers: role:bubble
D56 | changed | - | - | Box colours and motion. Built now colours a box at QC yellow, one with changes requested red with the jump motion, a scrapped one gray, others blue, each with the canvas band colour. The canvas also has blue boxes on lines 2 and 3, a gray idle box and the HOTFIX tag (D33), and colours by what the box waits for, which the snapshot does not carry.
  covers: paint:dock:shape:fill:#42a5f5 ;; paint:dock:shape:fill:#66bb6a ;; paint:dock:shape:fill:#ffca28
  covers: paint:line1:shape:fill:#1565c0 ;; paint:line1:shape:fill:#42a5f5 ;; paint:line1:shape:fill:#b71c1c
  covers: paint:line1:shape:fill:#ef5350 ;; paint:line1:shape:fill:#ff77a8 ;; paint:line1:shape:stroke:#15181c
  covers: paint:line1:text:fill:#15181c
D57 | fixed | - | - | Cage status LED and the door gap in the right wall of every cage, coloured by mood (green working, yellow at QC, red needs you, gray on break).
  covers: role:led:cage1 ;; role:led:cage2 ;; role:led:cage3
  covers: role:led:cage4 ;; role:led:cage5
D58 | conflict | - | - | Sixth cage placement. The canvas puts the temp bay (TEMP BAY, hired for L3) in slot 6 and has five cages; the plan and the sharpened prompt name six cages, so built draws a sixth cage there with its own plate and LED.
  covers: paint:cage6:shape:fill:#0d1a24 ;; paint:cage6:shape:fill:#15181c ;; paint:cage6:shape:fill:#66bb6a
  covers: paint:cage6:shape:fill:#6b7280 ;; paint:cage6:shape:fill:#8d6e63 ;; paint:cage6:shape:fill:#b9b4a6
  covers: paint:cage6:shape:fill:#c79a00 ;; paint:cage6:shape:fill:#cbc4b1 ;; paint:cage6:shape:fill:#ff7043
  covers: paint:cage6:shape:fill:#ffca28 ;; role:led:cage6 ;; shape:cage6:ellipse
  covers: shape:cage6:rect ;; shape:cage6:text ;; text:cage #
D59 | not-built | - | - | Per-cell top-border colours on the station cells, the order-line chips and the hotbar badges (ORDER gray, CODE blue, TEST orange, QC yellow, SHIP green). Built station counters have one border colour.
  covers: paint:dom:span:border-top:#42a5f5 ;; paint:dom:span:border-top:#454b55 ;; paint:dom:span:border-top:#66bb6a
  covers: paint:dom:span:border-top:#9aa1ab ;; paint:dom:span:border-top:#ffa726 ;; paint:dom:span:border-top:#ffca28
D60 | changed | - | - | HUD colours. The canvas HUD paints about 70 distinct background, border and text colours (page #1f2328, plates #15181c, chips per status, runtime badges #00add8 and #c74634); built paints its own smaller set from floor.css variables.
  covers: paint:dom:a:bg:#454b55 ;; paint:dom:a:bg:#66bb6a
  covers: paint:dom:a:bg:#ffca28 ;; paint:dom:a:border-bottom:#15181c ;; paint:dom:a:border-bottom:#454b55
  covers: paint:dom:a:border-left:#15181c ;; paint:dom:a:border-left:#454b55 ;; paint:dom:a:border-right:#15181c
  covers: paint:dom:a:border-right:#454b55 ;; paint:dom:a:border-top:#15181c ;; paint:dom:a:border-top:#454b55
  covers: paint:dom:a:color:#15181c ;; paint:dom:a:color:#f5f3ec ;; paint:dom:button:bg:#15181c
  covers: paint:dom:button:bg:#66bb6a ;; paint:dom:button:bg:#f5f3ec ;; paint:dom:button:border-bottom:#454b55
  covers: paint:dom:button:border-bottom:#66bb6a ;; paint:dom:button:border-bottom:#ffca28 ;; paint:dom:button:border-left:#454b55
  covers: paint:dom:button:border-left:#66bb6a ;; paint:dom:button:border-left:#ffca28 ;; paint:dom:button:border-right:#454b55
  covers: paint:dom:button:border-right:#66bb6a ;; paint:dom:button:border-right:#ffca28 ;; paint:dom:button:border-top:#454b55
  covers: paint:dom:button:border-top:#66bb6a ;; paint:dom:button:border-top:#ffca28 ;; paint:dom:button:color:#000000
  covers: paint:dom:div:bg:#0d1a24 ;; paint:dom:div:bg:#1f2328 ;; paint:dom:div:bg:#5a5f66
  covers: paint:dom:div:bg:#d6d0bf ;; paint:dom:div:bg:#f5f3ec ;; paint:dom:div:bg:#ffe0b2
  covers: paint:dom:div:border-bottom:#15181c ;; paint:dom:div:border-left:#15181c ;; paint:dom:div:border-right:#15181c
  covers: paint:dom:div:border-top:#15181c ;; paint:dom:div:color:#1f2328 ;; paint:dom:div:color:#ffca28
  covers: paint:dom:nav:bg:#2f343b ;; paint:dom:nav:border-bottom:#15181c ;; paint:dom:nav:border-left:#15181c
  covers: paint:dom:nav:border-right:#15181c ;; paint:dom:nav:border-top:#15181c ;; paint:dom:span:bg:#00add8
  covers: paint:dom:span:bg:#15181c ;; paint:dom:span:bg:#2fbf71 ;; paint:dom:span:bg:#3a3f4a
  covers: paint:dom:span:bg:#b06cff
  covers: paint:dom:span:bg:#b9b4a6 ;; paint:dom:span:bg:#c74634 ;; paint:dom:span:bg:#d97757
  covers: paint:dom:span:bg:#ff9f43 ;; paint:dom:span:bg:#ffa726 ;; paint:dom:span:border-bottom:#454b55
  covers: paint:dom:span:border-left:#454b55 ;; paint:dom:span:border-right:#454b55 ;; paint:dom:span:color:#1f2328
  covers: paint:dom:span:color:#42a5f5 ;; paint:dom:span:color:#66bb6a
  covers: paint:dom:span:color:#c62828 ;; paint:dom:span:color:#e3e6ea ;; paint:dom:span:color:#ef5350
  covers: paint:dom:span:color:#ff7043 ;; paint:dom:span:color:#ff8a65 ;; paint:dom:span:color:#ff8a80
  covers: paint:dom:span:color:#ffa726
D61 | changed | - | - | Built-only panel colours and sizes: the Action items list (#15181c rows with a #ffca28 top border), the 12 px Silkscreen headings, #c9cdd4 body text.
  covers: font:dom:silkscreen:12px ;; paint:dom:h1:color:#f5f3ec ;; paint:dom:h2:color:#f5f3ec
  covers: paint:dom:h2:color:#ffa726 ;; paint:dom:li:bg:#15181c ;; paint:dom:li:border-top:#ffca28
  covers: paint:dom:p:color:#c9cdd4
D62 | fixed | - | - | Animations: bob, jump, blink, zz, belt, press, tA, tB and pop use the canvas names and keyframes (the typing arms were typeA and typeB, the gantry press and the toast pop were missing).
  covers: anim:bob ;; anim:jump ;; anim:blink
  covers: anim:zz ;; anim:belt ;; anim:press
  covers: anim:tA ;; anim:tB ;; anim:pop
D63 | changed | - | - | Cage detail. The canvas draws a desk shadow line, a per-worker monitor with coloured lines and a lamp, and a LED colour per worker; built draws one desk, one monitor and the LED by mood. Cage counts per zone differ (canvas 17 to 44 shapes, built 9).
  covers: paint:cage1:shape:fill:#454b55 ;; paint:cage1:shape:fill:#5d4037 ;; paint:cage1:shape:fill:#66bb6a
  covers: paint:cage1:shape:fill:#9aa1ab ;; paint:cage1:shape:fill:#c79a00 ;; paint:cage2:shape:fill:#454b55
  covers: paint:cage2:shape:fill:#5d4037 ;; paint:cage2:shape:fill:#9aa1ab ;; paint:cage2:shape:fill:#ffca28
  covers: paint:cage3:shape:fill:#0d1a24 ;; paint:cage3:shape:fill:#454b55 ;; paint:cage3:shape:fill:#5d4037
  covers: paint:cage3:shape:fill:#7f1d1d ;; paint:cage3:shape:fill:#9aa1ab ;; paint:cage3:shape:fill:#c79a00
  covers: paint:cage3:shape:fill:#ef5350 ;; paint:cage3:shape:fill:#ffca28 ;; paint:cage4:shape:fill:#454b55
  covers: paint:cage4:shape:fill:#5d4037 ;; paint:cage5:shape:fill:#454b55 ;; paint:cage5:shape:fill:#5d4037
  covers: paint:cage5:shape:fill:#66bb6a ;; paint:cage5:shape:fill:#bf360c ;; paint:cage5:shape:fill:#c79a00
  covers: paint:cage5:shape:fill:#ef5350 ;; paint:cage5:shape:fill:#ff7043 ;; paint:cage5:shape:fill:#ffca28
  covers: shape:cage1:ellipse ;; shape:cage1:rect ;; shape:cage1:text
  covers: shape:cage2:rect ;; shape:cage3:ellipse ;; shape:cage3:rect
  covers: shape:cage3:text ;; shape:cage4:rect ;; shape:cage5:rect
  covers: shape:cage5:text
  regions: R4-8C3-5
D64 | not-built | - | - | ARIA group on the canvas control panel (the hotbar and menu). Built has no hotbar or menu group.
  covers: role:aria:group
D65 | changed | - | - | Built-only DOM and ARIA: the scene is role="img" with a label, and main, h1, aside, h2 and p landmarks the canvas does not have.
  covers: role:aria:img ;; shape:dom:aside ;; shape:dom:h1
  covers: shape:dom:h2 ;; shape:dom:main ;; shape:dom:p
D66 | changed | - | - | HUD font sizes. The canvas HUD mixes 7 to 16 px in Silkscreen, Press Start 2P, VT323 and Pixelify Sans; built uses 9 to 17 px in the same families.
  covers: font:dom:pixelify sans:13px ;; font:dom:pixelify sans:16px ;; font:dom:press start 2p:10px
  covers: font:dom:press start 2p:14px ;; font:dom:press start 2p:7px ;; font:dom:press start 2p:8px
  covers: font:dom:silkscreen:10px ;; font:dom:silkscreen:14px ;; font:dom:silkscreen:7px
  covers: font:dom:silkscreen:8px ;; font:dom:vt323:13px
  covers: font:dom:vt323:14px ;; font:dom:vt323:16px
D68 | changed | - | - | Boxes per station. The canvas draws 2 at ORDER, 3 at CODE and 4 at QC; built draws the boxes of its snapshot (the live run has two in QC and none elsewhere), so the counts differ by design.
  covers: boxes:CODE ;; boxes:MERGE ;; boxes:ORDER
  covers: boxes:QC
D69 | changed | - | - | DOM element counts per tag differ: the canvas HUD has about 25 buttons, 200 spans and 30 divs; built has 7 buttons and 24 spans.
  covers: shape:dom:b ;; shape:dom:button ;; shape:dom:div
  covers: shape:dom:icon ;; shape:dom:li ;; shape:dom:nav
  covers: shape:dom:rect ;; shape:dom:section ;; shape:dom:span
  covers: shape:dom:ul
D70 | not-built | - | - | DOM elements only on the canvas: 19 links (menu), a label and line breaks.
  covers: shape:dom:a ;; shape:dom:br ;; shape:dom:label
D72 | fixed | - | - | Firewall frame (four red edges), the git and npm lights and the four scan lasers are the canvas shapes. The blocked packets are not built (D23).
  covers: role:laser:firewall ;; text:git ;; text:npm
  covers: paint:firewall:shape:fill:#66bb6a ;; paint:firewall:text:fill:#15181c ;; paint:firewall:shape:fill:#ef5350
D73 | fixed | - | - | Shipping dock: the hazard stripe, the left wall edge, the side ramp and the roll-up door with its blue bumper are the canvas shapes. The truck load is not built (D24).
  covers: role:stripe:dock ;; paint:dock:shape:fill:pattern:haz ;; paint:dock:shape:fill:#1565c0
  covers: paint:dock:shape:fill:#eceff1 ;; paint:dock:shape:fill:#90caf9
D74 | fixed | - | - | TEST scan lines, the QC press and light stack, and the MERGE pads are drawn as on the canvas.
  covers: class:press ;; paint:stations:shape:fill:#ff7043 ;; paint:stations:shape:fill:#455a64
  covers: class:blink ;; class:jump ;; class:bob
  covers: class:zz ;; class:belt
D75 | changed | - | - | Built-only SHIPPED stamp on a delivered box (green), next to SCRAPPED and CHANGES; the canvas has the HOTFIX and BLOCKED tags only (D33).
  covers: text:shipped
D76 | changed | - | - | The built run-mode chip is a link that opens the preflight screen, so its green frame is painted on a link. The canvas has a button that cycles run modes and a dot that blinks; the built dot is still.
  covers: paint:dom:a:border-bottom:#66bb6a ;; paint:dom:a:border-left:#66bb6a ;; paint:dom:a:border-right:#66bb6a ;; paint:dom:a:border-top:#66bb6a
D79 | changed | 3 BLOCKED · 2 ALLOWED | 0 BLOCKED · 4 ALLOWED | The FIREWALL counter. Built counts the blocked sites HQ holds and the project allowlist rules, ALL for the open policy; the canvas numbers are drawn data. The git and npm lights are fixed art whatever the policy.
