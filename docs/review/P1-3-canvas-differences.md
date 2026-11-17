# Canvas floor artboard versus the built floor

Source of the canvas side: `docs/review/canvas/Main.dc.txt` (the artboard `project/Main.dc.html`, sha256 13a3d20a321f0ca69c98d9a38b24df80d77f3909477a785b2b3a86a5ae71198e), rendered by `src/e2e/canvas.mjs`. Lane 9 of `src/e2e/lanes.mjs` reads this file, so every difference is one line:

`id | status | text on the canvas | text on the built floor | what differs`

Status: `fixed` (built now shows the canvas text), `changed` (both show something, different), `not-built` (the canvas shows it, the built floor does not, a later unit or a snapshot field is needed), `conflict` (the spec and the canvas disagree, the choice made is stated). A text on the canvas is checked to be on the rendered artboard, and for `not-built` to be absent from the built floor. A `-` means there is no text to look up.

D01 | fixed | Demo data | - | The demo chip says "Demo data" as on the canvas (it said "Demo replay"). The Debug drawer still says "Demo replay" for the mode.
D02 | not-built | WIN · PWSH | - | Host chip (detected computer) in the run-mode button. The snapshot has no host or shell field.
D03 | not-built | elsewhere | - | Factory switcher ("FACTORY my-app", "3 lines", "+2 elsewhere"). Needs the factory park screen.
D04 | not-built | Order board | - | Order-board select (First active, Backlog). Needs boards.
D05 | not-built | 4x | - | Line speed buttons 1x, 2x, 4x.
D06 | not-built | Zoom in | - | Zoom out and zoom in buttons.
D07 | not-built | Sandbox cages | - | Run-mode chip ("MODE Cages | Sandbox cages · 6 running", WIN · PWSH, blinking dot). The snapshot has no run mode.
D08 | not-built | Preflight | - | HQ menu: + New order, Setup, Preflight, Boards, Docs, PRs / MRs, Terminal, Settings. Built has Action items and Debug only. Each target is a later screen.
D09 | not-built | Factory level | - | Factory level 3 with a 340 / 500 XP bar. The snapshot has no level or XP.
D10 | not-built | + Hire | - | "+ Hire" button in the crew header. A button with no screen behind it would be dead.
D11 | fixed | need you | - | "N NEED YOU" in the crew header is #ffca28 as on the canvas (it was #ff8a80). Lane 9 reads the computed colour.
D12 | not-built | Dispatch office | - | Crew rows: portrait, level, an energy bar labelled EN, a station line ("L1 web · Cage 1 · T-03"), a red border on a worker that needs you. Built rows have the key, the name and the mood chip. (EN on the canvas is the energy bar, not a language chip.)
D13 | not-built | Shift log | - | Shift log feed (nine lines with icons and ages). The snapshot has no feed.
D14 | not-built | Shift 2 | - | Shift clock (SHIFT 2, 19:58, 4 shipped).
D15 | not-built | Sprint 1 | - | Production order title "Sprint 1 — Auth + Billing" and the per-line list (L1 2 boxes, L2 1 blocked, L3 TEMP-1 on it).
D16 | conflict | SHIP | Merge | Station cells. The canvas has five (ORDER, CODE, TEST, QC, SHIP) in capitals. The plan and the sharpened prompt name six with MERGE. Built has six, written "Order Code Test QC Merge Shipping".
D17 | not-built | S-1 waits | - | Shipment status line "S-1 waits for L1 + L3 · 4 / 9 on the truck".
D18 | not-built | Worker file | - | Selected worker card: role and runtime line, EN and XP bars, TOOLS, a terminal, blocked sites with Allow and Dismiss, Worker file and Message buttons. Built has state, box, station and one line of text.
D19 | not-built | Inspect PRs at the QC gate | - | Hotbar Q W E R T Y (Order, QC, Unlock, Stop, Term, Hire) with badges.
D20 | not-built | Factory map | - | Factory map (minimap) above the shift clock.
D21 | not-built | +50 XP | - | "+50 XP" rising over the PR rack and in the toast. The snapshot has no XP.
D22 | changed | PR #12 merged | merged and shipped | Toast text. Canvas "SHIPMENT DELIVERED / PR #12 merged · +50 XP". Built "Shipment delivered / alpha/p12c merged and shipped", from the task, in the active language.
D23 | not-built | 3 BLOCKED · 2 ALLOWED | - | Firewall counters, the git and npm lights and the blocked packets. HQ has denials but no allowed count.
D24 | not-built | 4 / 9 LOADED | - | Truck load, the v0.1 label, the crates and the empty slots. Built truck is a blank door (38 by 40 px, the canvas truck is 38 by 78).
D25 | not-built | Shipments | - | Shipments board (S-1 sign-in · L1+L3, S-2 webhook · L2, "truck waits for all PRs").
D26 | not-built | #15 | - | PR rack cards #11, #12, #14, #15. Built rack is art only.
D27 | not-built | L3 shared-contracts | - | Three lines L1 to L3 with names, three belts and the shared-line mark. Built has one belt labelled "L1".
D28 | not-built | Temp bay | - | Temp bay (hired for L3 · 4m, leaves after 15m idle) and the TEMP-1 worker with an orange hat.
D29 | fixed | CAGE 1 · | CAGE 1 · | "CAGE n · NAME" plate under every cage, as on the canvas.
D30 | not-built | SUBAGENT · BYTE | - | Run-mode label on each cage in subagent modes. The snapshot has no run mode.
D31 | not-built | SHARED CAGE · CAPTAIN + 5 | - | Shared-cage banner over the cages in the one-cage subagent mode.
D32 | not-built | OFF · NO SANDBOX | - | "FIREWALL OFF · NO SANDBOX" panel ("agents use this computer") when subagents run on the host.
D33 | not-built | HOTFIX | - | HOTFIX, BLOCKED and ASKS YOU stamps. Built has SHIPPED, SCRAPPED and CHANGES only.
D34 | changed | D1 | P12C | Box codes. The canvas prefixes a box type (D1, T3, C2, T6, T5, C1). Built shows the task name in capitals (P12C), because a box in the snapshot has no type. The full task name is in the box title.
D35 | not-built | LV7 | - | Worker plate: level, name and an energy bar over every worker, a white-hat lead with a clipboard (CAPTAIN), thought bubble text. Built plates are the name only and every hat is yellow.
D36 | not-built | 3 LINES · 1 FACTORY | - | Floor caption.
D37 | not-built | - | - | Yard art: trees, crates, the truck lane and the fence posts.
D38 | not-built | - | - | Dispatch office desks and monitors, break room vending machine, coffee and sofa detail. Built draws the window, the orders board and the sofa only.
D39 | changed | - | - | Belt: the canvas belt is 138 px wide and ends before the dock, built is 150 px and runs into the SHIPPING bay, so the box rests on the dock. Belt animation is a pattern shift (0.6 s) against the canvas 30 px slide (2.4 s).
D40 | changed | - | - | Station labels. Built draws ORDER and CODE under the belt (the canvas has no such labels) and TEST, QC, MERGE in darker ink for contrast than the canvas (#8a3500, #6b4f00, #1b5e20 against #e65100, #c79a00, #2e7d32).
D41 | changed | - | - | Worker movement. Canvas workers loop along the floor and a QC worker carries a labelled PR box on its head. Built places the worker at the cage, the break room or the QC gantry by mood and moves it between them with a stepped transition; the carried box is an unlabelled blue block.
D42 | conflict | - | - | Mood chip colours. The canvas chip is cream text on #ef5350 (3.14 to 1). Built uses dark ink (5.1 to 1) so the text passes 4.5 to 1.
D43 | conflict | - | - | Fonts. The canvas loads Silkscreen, Press Start 2P, Pixelify Sans and VT323 from Google Fonts. The spec says no network at runtime, so built serves the same four from @fontsource, plus Sarabun for Thai.
D44 | conflict | - | - | Language switch. The spec puts it in Settings, Project, Language; the canvas floor has none. Settings is not built, so the switch sits in the Debug drawer.
D45 | changed | - | - | HUD frame. The canvas HUD is a two-row header laid over the scene, 32 px controls and a 5 percent by 11 percent hit area per worker. Built is a one-row header above the scene, 28 to 32 px buttons, and a 44 px "!" target at 390 px.
