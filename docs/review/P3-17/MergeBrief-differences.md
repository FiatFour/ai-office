# MergeBrief artboard versus the built screen

The format is that of `docs/review/P1-3-canvas-differences.md`. `node src/e2e/merge-brief.mjs` checks this list against the inventories of both renders. The built screen shows the PR of the scripted run once it is ready.

D01 | not-built | SHIPPING | - | The factory floor drawn behind the panel. The built screen is a page of its own on a plain background, as Preflight and PRs are.
  covers: anim:belt ;; anim:blink ;; anim:bob
  covers: anim:jump ;; anim:press ;; anim:rise
  covers: anim:tA ;; anim:tB ;; anim:zz
  covers: class:belt ;; class:blink ;; class:bob
  covers: class:jump ;; class:press ;; class:rise
  covers: class:typeA ;; class:zz ;; font:svg:pixelify sans:4px
  covers: font:svg:pixelify sans:5px ;; font:svg:silkscreen:2.8px ;; font:svg:silkscreen:3.2px
  covers: font:svg:silkscreen:3.4px ;; font:svg:silkscreen:3.6px ;; font:svg:silkscreen:3px
  covers: font:svg:silkscreen:4px ;; font:svg:silkscreen:6px ;; font:svg:vt323:3.6px
  covers: font:svg:vt323:3.8px ;; font:svg:vt323:4px ;; paint:break:shape:fill:#000000
  covers: paint:break:shape:fill:#00796b ;; paint:break:shape:fill:#15181c ;; paint:break:shape:fill:#1f2328
  covers: paint:break:shape:fill:#26a69a ;; paint:break:shape:fill:#3a3f4a ;; paint:break:shape:fill:#454b55
  covers: paint:break:shape:fill:#5d4037 ;; paint:break:shape:fill:#66bb6a ;; paint:break:shape:fill:#6b7280
  covers: paint:break:shape:fill:#90caf9 ;; paint:break:shape:fill:#9aa1ab ;; paint:break:shape:fill:#9b9b9b
  covers: paint:break:shape:fill:#b06cff ;; paint:break:shape:fill:#b5654a ;; paint:break:shape:fill:#c62828
  covers: paint:break:shape:fill:#c79a00 ;; paint:break:shape:fill:#e8d9c4 ;; paint:break:shape:fill:#f2c79b
  covers: paint:break:shape:fill:#ffca28 ;; paint:break:shape:fill:#fff59d ;; paint:break:shape:fill:#ffffff
  covers: paint:break:text:fill:#5d4037 ;; paint:break:text:fill:#f5f3ec ;; paint:break:text:stroke:#15181c
  covers: paint:cage1:shape:fill:#000000 ;; paint:cage1:shape:fill:#0d1a24 ;; paint:cage1:shape:fill:#15181c
  covers: paint:cage1:shape:fill:#1f2328 ;; paint:cage1:shape:fill:#2fbf71 ;; paint:cage1:shape:fill:#3a3f4a
  covers: paint:cage1:shape:fill:#454b55 ;; paint:cage1:shape:fill:#4a2f27 ;; paint:cage1:shape:fill:#5d4037
  covers: paint:cage1:shape:fill:#66bb6a ;; paint:cage1:shape:fill:#6b7280 ;; paint:cage1:shape:fill:#8d6e63
  covers: paint:cage1:shape:fill:#b5654a ;; paint:cage1:shape:fill:#b9b4a6 ;; paint:cage1:shape:fill:#c79a00
  covers: paint:cage1:shape:fill:#e0a878 ;; paint:cage1:shape:fill:#f5f3ec ;; paint:cage1:shape:fill:#ffca28
  covers: paint:cage1:shape:fill:#fff59d ;; paint:cage1:shape:fill:#ffffff ;; paint:cage1:shape:fill:pattern:mesh
  covers: paint:cage1:text:fill:#454b55 ;; paint:cage1:text:fill:#f5f3ec ;; paint:cage2:shape:fill:#0d1a24
  covers: paint:cage2:shape:fill:#15181c ;; paint:cage2:shape:fill:#454b55 ;; paint:cage2:shape:fill:#5d4037
  covers: paint:cage2:shape:fill:#6b7280 ;; paint:cage2:shape:fill:#8d6e63 ;; paint:cage2:shape:fill:#b9b4a6
  covers: paint:cage2:shape:fill:#ffca28 ;; paint:cage2:shape:fill:pattern:mesh ;; paint:cage2:text:fill:#454b55
  covers: paint:cage3:shape:fill:#000000 ;; paint:cage3:shape:fill:#15181c ;; paint:cage3:shape:fill:#1b1730
  covers: paint:cage3:shape:fill:#1f2328 ;; paint:cage3:shape:fill:#3a3f4a ;; paint:cage3:shape:fill:#454b55
  covers: paint:cage3:shape:fill:#5ab0ff ;; paint:cage3:shape:fill:#5d4037 ;; paint:cage3:shape:fill:#6b7280
  covers: paint:cage3:shape:fill:#7f1d1d ;; paint:cage3:shape:fill:#8d6e63 ;; paint:cage3:shape:fill:#b5654a
  covers: paint:cage3:shape:fill:#b9b4a6 ;; paint:cage3:shape:fill:#c68642 ;; paint:cage3:shape:fill:#c79a00
  covers: paint:cage3:shape:fill:#ef5350 ;; paint:cage3:shape:fill:#f5f3ec ;; paint:cage3:shape:fill:#ffca28
  covers: paint:cage3:shape:fill:#fff59d ;; paint:cage3:shape:fill:#ffffff ;; paint:cage3:shape:fill:pattern:mesh
  covers: paint:cage3:text:fill:#454b55 ;; paint:cage3:text:fill:#f5f3ec ;; paint:cage4:shape:fill:#0d1a24
  covers: paint:cage4:shape:fill:#15181c ;; paint:cage4:shape:fill:#454b55 ;; paint:cage4:shape:fill:#5d4037
  covers: paint:cage4:shape:fill:#6b7280 ;; paint:cage4:shape:fill:#8d6e63 ;; paint:cage4:shape:fill:#9aa1ab
  covers: paint:cage4:shape:fill:#b9b4a6 ;; paint:cage4:shape:fill:pattern:mesh ;; paint:cage4:text:fill:#454b55
  covers: paint:cage5:shape:fill:#000000 ;; paint:cage5:shape:fill:#0d1a24 ;; paint:cage5:shape:fill:#15181c
  covers: paint:cage5:shape:fill:#1f2328 ;; paint:cage5:shape:fill:#3a3f4a ;; paint:cage5:shape:fill:#454b55
  covers: paint:cage5:shape:fill:#5d4037 ;; paint:cage5:shape:fill:#66bb6a ;; paint:cage5:shape:fill:#6b7280
  covers: paint:cage5:shape:fill:#6d4c41 ;; paint:cage5:shape:fill:#78909c ;; paint:cage5:shape:fill:#8d6e63
  covers: paint:cage5:shape:fill:#b5654a ;; paint:cage5:shape:fill:#b9b4a6 ;; paint:cage5:shape:fill:#bf360c
  covers: paint:cage5:shape:fill:#e0a878 ;; paint:cage5:shape:fill:#f5f3ec ;; paint:cage5:shape:fill:#ff7043
  covers: paint:cage5:shape:fill:#fff59d ;; paint:cage5:shape:fill:#ffffff ;; paint:cage5:shape:fill:pattern:mesh
  covers: paint:cage5:text:fill:#454b55 ;; paint:cage5:text:fill:#f5f3ec ;; paint:cage6:shape:fill:#cbc4b1
  covers: paint:cage6:shape:fill:#ff7043 ;; paint:cage6:shape:fill:pattern:mesh ;; paint:cage6:text:fill:#15181c
  covers: paint:cage6:text:fill:#454b55 ;; paint:dispatch:shape:fill:#000000 ;; paint:dispatch:shape:fill:#0d1a24
  covers: paint:dispatch:shape:fill:#15181c ;; paint:dispatch:shape:fill:#1f2328 ;; paint:dispatch:shape:fill:#3a3f4a
  covers: paint:dispatch:shape:fill:#42a5f5 ;; paint:dispatch:shape:fill:#454b55 ;; paint:dispatch:shape:fill:#455a64
  covers: paint:dispatch:shape:fill:#4a2f27 ;; paint:dispatch:shape:fill:#546e7a ;; paint:dispatch:shape:fill:#5d4037
  covers: paint:dispatch:shape:fill:#66bb6a ;; paint:dispatch:shape:fill:#78909c ;; paint:dispatch:shape:fill:#8d6e63
  covers: paint:dispatch:shape:fill:#9aa1ab ;; paint:dispatch:shape:fill:#b5654a ;; paint:dispatch:shape:fill:#cfe6f2
  covers: paint:dispatch:shape:fill:#d97757 ;; paint:dispatch:shape:fill:#ef5350 ;; paint:dispatch:shape:fill:#f2c79b
  covers: paint:dispatch:shape:fill:#f5f3ec ;; paint:dispatch:shape:fill:#ffca28 ;; paint:dispatch:shape:fill:#fff59d
  covers: paint:dispatch:shape:fill:#ffffff ;; paint:dispatch:shape:fill:pattern:mesh ;; paint:dispatch:text:fill:#455a64
  covers: paint:dispatch:text:fill:#c62828 ;; paint:dispatch:text:fill:#f5f3ec ;; paint:dock:shape:fill:#000000
  covers: paint:dock:shape:fill:#15181c ;; paint:dock:shape:fill:#1565c0 ;; paint:dock:shape:fill:#26c6da
  covers: paint:dock:shape:fill:#6b7280 ;; paint:dock:shape:fill:#90caf9 ;; paint:dock:shape:fill:#9aa1ab
  covers: paint:dock:shape:fill:#b9b4a6 ;; paint:dock:shape:fill:#cbc4b1 ;; paint:dock:shape:fill:#eceff1
  covers: paint:dock:shape:fill:#ff77a8 ;; paint:dock:shape:fill:pattern:haz ;; paint:dock:shape:fill:pattern:roof
  covers: paint:dock:shape:stroke:#15181c ;; paint:dock:shape:stroke:#9aa1ab ;; paint:dock:text:fill:#15181c
  covers: paint:dock:text:fill:#454b55 ;; paint:firewall:shape:fill:#15181c ;; paint:firewall:shape:fill:#3a2a2e
  covers: paint:firewall:shape:fill:#454b55 ;; paint:firewall:shape:fill:#66bb6a ;; paint:firewall:shape:fill:#ef5350
  covers: paint:firewall:shape:fill:#f5f3ec ;; paint:firewall:shape:fill:#ff5252 ;; paint:firewall:text:fill:#15181c
  covers: paint:firewall:text:fill:#ef5350 ;; paint:firewall:text:fill:#ffb3b3 ;; paint:floor:shape:fill:#000000
  covers: paint:floor:shape:fill:#15181c ;; paint:floor:shape:fill:#6b7078 ;; paint:floor:shape:fill:#ffca28
  covers: paint:floor:shape:fill:pattern:floor ;; paint:floor:shape:fill:pattern:grass ;; paint:floor:shape:fill:pattern:roof
  covers: paint:floor:shape:fill:pattern:yard ;; paint:floor:text:fill:#15181c ;; paint:floor:text:fill:#bdb6a2
  covers: paint:line1:shape:fill:#15181c ;; paint:line1:shape:fill:#1565c0 ;; paint:line1:shape:fill:#42a5f5
  covers: paint:line1:shape:fill:#b71c1c ;; paint:line1:shape:fill:#ef5350 ;; paint:line1:shape:fill:#ff77a8
  covers: paint:line1:shape:fill:#ffca28 ;; paint:line1:shape:fill:pattern:belt ;; paint:line1:shape:stroke:#15181c
  covers: paint:line1:text:fill:#15181c ;; paint:line1:text:fill:#f5f3ec ;; paint:line2:shape:fill:#15181c
  covers: paint:line2:shape:fill:#26c6da ;; paint:line2:shape:fill:#42a5f5 ;; paint:line2:shape:fill:#b71c1c
  covers: paint:line2:shape:fill:#ef5350 ;; paint:line2:shape:fill:pattern:belt ;; paint:line2:shape:stroke:#15181c
  covers: paint:line2:text:fill:#15181c ;; paint:line2:text:fill:#f5f3ec ;; paint:line3:shape:fill:#15181c
  covers: paint:line3:shape:fill:#1565c0 ;; paint:line3:shape:fill:#42a5f5 ;; paint:line3:shape:fill:#6b7280
  covers: paint:line3:shape:fill:#9aa1ab ;; paint:line3:shape:fill:#b06cff ;; paint:line3:shape:fill:#ff77a8
  covers: paint:line3:shape:fill:pattern:belt ;; paint:line3:shape:stroke:#15181c ;; paint:line3:text:fill:#15181c
  covers: paint:line3:text:fill:#f5f3ec ;; paint:prrack:shape:fill:#66bb6a ;; paint:prrack:shape:fill:#9aa1ab
  covers: paint:prrack:shape:fill:#cbc4b1 ;; paint:prrack:shape:fill:#e65100 ;; paint:prrack:shape:fill:#ffca28
  covers: paint:prrack:text:fill:#15181c ;; paint:prrack:text:fill:#454b55 ;; paint:prrack:text:fill:#66bb6a
  covers: paint:prrack:text:stroke:#15181c ;; paint:stations:shape:fill:#000000 ;; paint:stations:shape:fill:#15181c
  covers: paint:stations:shape:fill:#1f2328 ;; paint:stations:shape:fill:#2e7d32 ;; paint:stations:shape:fill:#3a3f4a
  covers: paint:stations:shape:fill:#454b55 ;; paint:stations:shape:fill:#455a64 ;; paint:stations:shape:fill:#5d4037
  covers: paint:stations:shape:fill:#66bb6a ;; paint:stations:shape:fill:#8d6e63 ;; paint:stations:shape:fill:#c79a00
  covers: paint:stations:shape:fill:#e2557a ;; paint:stations:shape:fill:#ef5350 ;; paint:stations:shape:fill:#f2c79b
  covers: paint:stations:shape:fill:#ff7043 ;; paint:stations:shape:fill:#ff9f43 ;; paint:stations:shape:fill:#ffa726
  covers: paint:stations:shape:fill:#ffca28 ;; paint:stations:shape:fill:#fff59d ;; paint:stations:text:fill:#15181c
  covers: paint:stations:text:fill:#2e7d32 ;; paint:stations:text:fill:#c79a00 ;; paint:stations:text:fill:#e65100
  covers: paint:stations:text:fill:#f5f3ec ;; role:bubble ;; role:glyph:break:z
  covers: role:glyph:line1:d1 ;; role:glyph:line1:t3 ;; role:glyph:line2:t6
  covers: role:glyph:line3:c1 ;; role:glyph:line3:c2 ;; role:glyph:stations:qc
  covers: role:glyph:stations:t5 ;; role:icon ;; role:laser:firewall
  covers: role:laser:floor ;; role:led:break ;; role:led:cage1
  covers: role:led:cage2 ;; role:led:cage3 ;; role:led:cage4
  covers: role:led:cage5 ;; role:led:dispatch ;; role:led:firewall
  covers: role:led:stations ;; role:stripe:dock ;; shape:break:ellipse
  covers: shape:break:rect ;; shape:break:text ;; shape:cage1:ellipse
  covers: shape:cage1:rect ;; shape:cage1:text ;; shape:cage2:rect
  covers: shape:cage2:text ;; shape:cage3:ellipse ;; shape:cage3:rect
  covers: shape:cage3:text ;; shape:cage4:rect ;; shape:cage4:text
  covers: shape:cage5:ellipse ;; shape:cage5:rect ;; shape:cage5:text
  covers: shape:cage6:rect ;; shape:cage6:text ;; shape:dispatch:ellipse
  covers: shape:dispatch:rect ;; shape:dispatch:text ;; shape:dock:rect
  covers: shape:dock:text ;; shape:dock:use#crate ;; shape:firewall:rect
  covers: shape:firewall:text ;; shape:floor:rect ;; shape:floor:text
  covers: shape:floor:use#tree ;; shape:line1:rect ;; shape:line1:text
  covers: shape:line2:rect ;; shape:line2:text ;; shape:line3:rect
  covers: shape:line3:text ;; shape:prrack:rect ;; shape:prrack:text
  covers: shape:stations:ellipse ;; shape:stations:rect ;; shape:stations:text
  covers: text:# / # loaded ;; text:# blocked · # allowed ;; text:# lines
  covers: text:## ;; text:+# xp ;; text:blocked
  covers: text:break +energy ;; text:cage # · byte ;; text:cage # · echo
  covers: text:cage # · nova ;; text:cage # · pixel ;; text:cage # · temp-#
  covers: text:d# ;; text:dispatch ;; text:firewall
  covers: text:git ;; text:hired for l# · #m ;; text:hotfix
  covers: text:l# my-app-api ;; text:l# my-app-web ;; text:l# shared-contracts ⇄
  covers: text:leaves after #m idle ;; text:merge ;; text:nova
  covers: text:npm ;; text:orders ;; text:pr rack
  covers: text:qc ;; text:shipping ;; text:t#
  covers: text:test ;; text:truck waits for all prs ;; text:v#.#
  covers: text:z ;; boxes:CODE ;; boxes:ORDER
  covers: boxes:QC
  regions: R1-9C1-12

D02 | not-built | Demo data | - | The HQ header: demo chip, factory switcher, cage chip and the nav buttons. The floor owns the header.
  covers: paint:dom:header:bg:#1f2328@96 ;; shape:dom:nav ;; text:# lines · # factory
  covers: text:+ new order ;; text:+# elsewhere ;; text:action items · #
  covers: text:agent works · # ;; text:boards ;; text:debug
  covers: text:demo data ;; text:docs · # ;; text:factory
  covers: text:my-app ;; text:preflight · # ✕ ;; text:prs / mrs · #
  covers: text:sandbox cages · running ;; text:settings ;; text:setup · #
  covers: text:terminal ;; text:▾

D03 | not-built | Shipment S-1 | - | The tabs and the shipment brief. The page shows the one task named in its address, and shipments are not in v1.
  covers: role:aria:tab ;; role:aria:tablist ;; text:byte
  covers: text:c# ;; text:pr ## · fix d-# · ready ;; text:pr ## · pricing page layout
  covers: text:pr ## · pricing page · ready ;; text:s-# sign-in · l#+l# ;; text:s-# webhook · l#
  covers: text:shipment s-# · sign-in · # of # ready ;; text:shipments ;; text:temp bay
  covers: text:temp-#

D04 | not-built | Send back with a note | - | Send back with a note and Ask Captain a question. HQ has no route for either, so the screen shows no control that would do nothing.
  covers: text:ask captain a question ;; text:send back with a note

D05 | not-built | yearly off | - | Before and after screenshots. No worker takes them yet, so the Screenshots card says not collected with the reason.
  covers: paint:dom:figcaption:color:#454b55 ;; role:aria:img ;; shape:dom:figcaption
  covers: shape:dom:figure ;; text:$# / month ;; text:$# / year
  covers: text:after ;; text:en-us · # px · yearly off ;; text:en-us · # px · yearly on
  covers: text:my-app.local/pricing ;; text:pro ;; text:starter

D06 | not-built | Kibana | - | The ELK log cards, bars and sample lines. No log source exists, so the Logs card says not collected.
  covers: text:# errors ;; text:elk ;; text:elk mcp · kibana.internal.example · read-only query
  covers: text:kibana · my-app-web errors on preview pr-# · # min ;; text:open in kibana ↗ ;; text:screenshots taken by pixel in cage # with a headless browser. links open in github and kibana.

D07 | not-built | new page, yearly toggle | - | A short description of each file and the check durations. HQ records neither.
  covers: text:# new tests ;; text:#m #s ;; text:#s
  covers: text:adds the pricing page: monthly or yearly plans, with plan cards that read the currency from the visitor's locale. done for work order t-#, following product requirements §# and the brand guide. ;; text:app/pricing/page.tsx ;; text:components/plan.tsx
  covers: text:new page, yearly toggle ;; text:plan card, currency from locale ;; text:tests/pricing.spec.ts

D08 | changed | Open comments | Line comments | Stat tiles count the files and lines the host lists, the green checks, approvals, rounds and line comments on this commit. HQ does not know whether a comment is resolved.
  covers: text:# changes asked, # fixed ;; text:+# ;; text:echo (peer) · coderabbit
  covers: text:nothing left ;; text:open comments ;; text:−#
  covers: text:# request for changes ;; text:+ # ;; text:all green on this commit
  covers: text:checks ;; text:line comments ;; text:on this commit
  covers: text:vega ;; text:− #

D09 | changed | Adds the pricing page | Taken from the work order | The summary is the work order text, labelled as such. No captain writes a summary yet.
  covers: text:risk · low ;; text:ui only. no api, data, config or shared-contract changes. every page except /pricing is untouched. ;; text:taken from the work order.
  covers: text:write docs/note.md and src/note.txt.

D10 | changed | Unit tests | passed | The tests are the checks the host reports on this commit, by name, with no duration.
  covers: text:build ;; text:build #m #s ;; text:e#e
  covers: text:none for this page yet ;; text:typecheck ;; text:unit tests · # (# new)
  covers: text:– ;; text:passed

D11 | changed | Screenshots taken by Pixel | not collected | Each kind of evidence has a card. A missing one says not collected and why. The CI card links to the checks on the host.
  covers: text:github actions · run ## · typecheck, # tests, build ;; text:github.com/you/my-app-web/actions/runs/# ;; text:open run ↗
  covers: text:pass ;; text:# check passed on ;; text:logs
  covers: text:no log source is set for this line ;; text:not collected ;; text:open the checks on github
  covers: text:screenshots ;; text:test output ;; text:the worker attached no before and after screenshots
  covers: text:the worker attached no test output that fails before the change and passes after it; the work order is a feature

D12 | changed | pushed fixes for both | approved in round | The timeline holds the reviews the host has, with their comments. Push events and who opened the PR are left out because HQ does not read their times.
  covers: text:approved in round # ;; text:asked for # change: currency is hard-coded ;; text:asked for # change: yearly toggle does not update the price on first render
  covers: text:coderabbit ;; text:echo ;; text:echo (peer) and coderabbit
  covers: text:echo (peer, codex) ;; text:opened pr ## ;; text:pixel
  covers: text:pushed fixes for both, added # tests ;; text:approved in round # on ;; text:asked for changes in round # on
  covers: text:author and reviewer both run on scripted; codex is deferred (g#) ;; text:commit ;; text:docs/note.md:# say "second draft".
  covers: text:looks right. ;; text:please fix the comments.

D13 | changed | Pricing page layout | Add a two-file note | PR data comes from the scripted run. Risk reads not collected when the work order sets none.
  covers: text:brand guide ;; text:product requirements §# ;; text:risk: low
  covers: text:t-# ;; text:· my-app-web on github · aw/my-app/t-#-pricing-page → main ;; text:alpha/t#
  covers: text:docs/note.md ;; text:open the work order ;; text:pr # # · add a two-file note
  covers: text:risk ;; text:risk: not collected ;; text:src/note.txt
  covers: text:the work order sets no risk level. ;; text:· acme/app · github · aw/alpha/t# → main

D14 | changed | Nothing to set up first | I checked whether anything must be set up first | The checklist uses native checkboxes. It claims no fact about setup: the reader confirms they looked.
  covers: text:nothing to set up first (no secrets, no migrations) ;; text:read the summary and the risk ;; text:i checked whether anything must be set up first
  covers: text:i read the summary and the risk ;; text:neither the work order nor the worker named a step before merge

D15 | changed | You merge on GitHub or GitLab | Agent Works does not merge for you | The merge note. The link to the host is the only way to merge and it leaves HQ.
  covers: text:you merge on github or gitlab. when the merge lands, the box ships and the truck loads it. ;; text:agent works does not merge for you. you merge on github or gitlab.

D16 | changed | Switch monthly and yearly | the work order names no manual check | How to check after merge reads not collected, because no work order names a manual check.
  covers: text:open /pricing ;; text:revert the merge commit. nothing to clean up. ;; text:set the browser to th-th and check prices show in thb
  covers: text:switch monthly and yearly ;; text:checks and reviews read from github at #:#. ;; text:revert the merge commit of pr ##.
  covers: text:the work order names no manual check

D17 | changed | - | - | Markup and colours: the app stylesheet and shared panel are used, and heading and link colours are darkened where the canvas colour is under 4.5 to 1.
  covers: font:dom:pixelify sans:10px ;; font:dom:pixelify sans:11px ;; font:dom:pixelify sans:15px
  covers: font:dom:pixelify sans:16px ;; font:dom:press start 2p:11px ;; font:dom:press start 2p:13px
  covers: font:dom:press start 2p:16px ;; font:dom:silkscreen:10px ;; font:dom:vt323:11px
  covers: font:dom:vt323:16px ;; font:dom:vt323:17px ;; paint:dom:a:bg:#15181c
  covers: paint:dom:a:bg:#454b55 ;; paint:dom:a:bg:#e3e6ea ;; paint:dom:a:border-bottom:#454b55
  covers: paint:dom:a:border-bottom:#9aa1ab ;; paint:dom:a:border-left:#454b55 ;; paint:dom:a:border-left:#9aa1ab
  covers: paint:dom:a:border-right:#454b55 ;; paint:dom:a:border-right:#9aa1ab ;; paint:dom:a:border-top:#454b55
  covers: paint:dom:a:border-top:#9aa1ab ;; paint:dom:a:color:#1f2328 ;; paint:dom:a:color:#f5f3ec
  covers: paint:dom:b:color:#2e7d32 ;; paint:dom:b:color:#ffca28 ;; paint:dom:button:bg:#454b55
  covers: paint:dom:button:bg:#e3e6ea ;; paint:dom:button:bg:#ffca28 ;; paint:dom:button:bg:#ffffff
  covers: paint:dom:button:border-bottom:#15181c ;; paint:dom:button:border-left:#15181c ;; paint:dom:button:border-right:#15181c
  covers: paint:dom:button:border-top:#15181c ;; paint:dom:button:color:#15181c ;; paint:dom:button:color:#1f2328
  covers: paint:dom:button:color:#f5f3ec ;; paint:dom:div:bg:#15181c ;; paint:dom:div:bg:#15181c@62
  covers: paint:dom:div:bg:#1f2328 ;; paint:dom:div:bg:#e3e6ea ;; paint:dom:div:bg:#ffffff
  covers: paint:dom:div:border-bottom:#454b55 ;; paint:dom:div:border-bottom:#c4bdaa ;; paint:dom:div:border-left:#15181c
  covers: paint:dom:div:border-left:#454b55 ;; paint:dom:div:border-left:#c4bdaa ;; paint:dom:div:border-right:#15181c
  covers: paint:dom:div:border-right:#454b55 ;; paint:dom:div:border-right:#c4bdaa ;; paint:dom:div:border-top:#15181c
  covers: paint:dom:div:border-top:#454b55 ;; paint:dom:div:border-top:#c4bdaa ;; paint:dom:div:color:#f5f3ec
  covers: paint:dom:h3:color:#c62828 ;; paint:dom:li:color:#1f2328 ;; paint:dom:section:bg:#2f343b
  covers: paint:dom:span:bg:#26c6da ;; paint:dom:span:bg:#66bb6a ;; paint:dom:span:bg:#c9cdd4
  covers: paint:dom:span:bg:#e3e6ea ;; paint:dom:span:bg:#ef5350 ;; paint:dom:span:bg:#ff9f43
  covers: paint:dom:span:bg:#ffca28 ;; paint:dom:span:bg:#ffffff ;; paint:dom:span:color:#2e7d32
  covers: paint:dom:span:color:#66bb6a ;; paint:dom:span:color:#6b7280 ;; paint:dom:span:color:#9aa1ab
  covers: paint:dom:span:color:#c62828 ;; paint:dom:span:color:#ffca28 ;; role:aria:checkbox
  covers: shape:dom:button ;; shape:dom:icon ;; shape:dom:rect
  covers: font:dom:silkscreen:15px ;; font:dom:silkscreen:18px ;; paint:dom:a:color:#0d47a1
  covers: paint:dom:a:color:#ffca28 ;; paint:dom:article:bg:#ffffff ;; paint:dom:article:border-bottom:#c4bdaa
  covers: paint:dom:article:border-left:#c4bdaa ;; paint:dom:article:border-right:#c4bdaa ;; paint:dom:article:border-top:#c4bdaa
  covers: paint:dom:b:bg:#e3e6ea ;; paint:dom:b:border-bottom:#454b55 ;; paint:dom:b:border-left:#454b55
  covers: paint:dom:b:border-right:#454b55 ;; paint:dom:b:border-top:#454b55 ;; paint:dom:b:color:#66bb6a
  covers: paint:dom:code:color:#1b5e20 ;; paint:dom:code:color:#1f2328 ;; paint:dom:code:color:#b71c1c
  covers: paint:dom:div:color:#1f2328 ;; paint:dom:h3:color:#b71c1c ;; paint:dom:h4:color:#1f2328
  covers: paint:dom:header:bg:#2f343b ;; paint:dom:li:bg:#15181c ;; paint:dom:li:border-bottom:#454b55
  covers: paint:dom:li:border-left:#2e7d32 ;; paint:dom:li:border-left:#454b55 ;; paint:dom:li:border-left:#c62828
  covers: paint:dom:li:border-right:#454b55 ;; paint:dom:li:border-top:#454b55 ;; paint:dom:main:bg:#2f343b
  covers: paint:dom:main:border-bottom:#15181c ;; paint:dom:main:border-left:#15181c ;; paint:dom:main:border-right:#15181c
  covers: paint:dom:main:border-top:#15181c ;; paint:dom:p:bg:#15181c ;; paint:dom:p:border-bottom:#ffca28
  covers: paint:dom:p:border-left:#ffca28 ;; paint:dom:p:border-right:#ffca28 ;; paint:dom:p:border-top:#ffca28
  covers: paint:dom:p:color:#454b55 ;; paint:dom:p:color:#c9cdd4 ;; paint:dom:p:color:#f5f3ec
  covers: paint:dom:span:bg:#9aa1ab ;; paint:dom:span:color:#1b5e20 ;; paint:dom:span:color:#454b55
  covers: paint:dom:time:color:#454b55 ;; shape:dom:article ;; shape:dom:code
  covers: shape:dom:h4 ;; shape:dom:input ;; shape:dom:label
  covers: shape:dom:main ;; shape:dom:time ;; shape:dom:ul
  covers: shape:dom:a ;; shape:dom:div ;; shape:dom:li
  covers: shape:dom:ol ;; shape:dom:p ;; shape:dom:section
  covers: shape:dom:span

D18 | changed | ✕ | All PRs | A page of its own: the logo goes back to the floor and a link goes to the PRs screen, in place of the close button of an overlay.
  covers: text:captain ;; text:captain's summary of what you are about to merge. ;; text:✕
  covers: text:all prs ;; text:what you are about to merge, and what hq knows about it.

D19 | fixed | READY TO MERGE | - | The ready banner with the PR, repo, branch and risk.
  covers: text:ready to merge

D20 | fixed | BEFORE YOU MERGE | - | The headings: Merge brief, Summary, What changed, Tests, Evidence, Before you merge, How to check after merge, Roll back and Based on.
  covers: text:merge brief ;; text:tests ;; text:summary
  covers: text:what changed ;; text:evidence ;; text:before you merge
  covers: text:how to check after merge ;; text:roll back ;; text:based on

D21 | fixed | I looked at the diff on GitHub | - | The checklist beside the brief and the link that counts what is checked.
  covers: text:i looked at the diff on github
