# PRs artboard versus the built screen

The format is that of `docs/review/P1-3-canvas-differences.md`. `node src/e2e/prs.mjs` checks this list against the inventories of both renders. The built screen shows the PR of the scripted run after it reached READY.

D01 | not-built | SHIPPING | - | The factory floor drawn behind the panel. The built screen is a page of its own on a plain background, as Preflight is.
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
  covers: role:glyph:stations:t5 ;; role:laser:firewall ;; role:laser:floor
  covers: role:led:break ;; role:led:cage1 ;; role:led:cage2
  covers: role:led:cage3 ;; role:led:cage4 ;; role:led:cage5
  covers: role:led:dispatch ;; role:led:firewall ;; role:led:stations
  covers: role:stripe:dock ;; shape:break:ellipse ;; shape:break:rect
  covers: shape:break:text ;; shape:cage1:ellipse ;; shape:cage1:rect
  covers: shape:cage1:text ;; shape:cage2:rect ;; shape:cage2:text
  covers: shape:cage3:ellipse ;; shape:cage3:rect ;; shape:cage3:text
  covers: shape:cage4:rect ;; shape:cage4:text ;; shape:cage5:ellipse
  covers: shape:cage5:rect ;; shape:cage5:text ;; shape:cage6:rect
  covers: shape:cage6:text ;; shape:dispatch:ellipse ;; shape:dispatch:rect
  covers: shape:dispatch:text ;; shape:dock:rect ;; shape:dock:text
  covers: shape:dock:use#crate ;; shape:dom:rect ;; shape:firewall:rect
  covers: shape:firewall:text ;; shape:floor:rect ;; shape:floor:text
  covers: shape:floor:use#tree ;; shape:line1:rect ;; shape:line1:text
  covers: shape:line2:rect ;; shape:line2:text ;; shape:line3:rect
  covers: shape:line3:text ;; shape:prrack:rect ;; shape:prrack:text
  covers: shape:stations:ellipse ;; shape:stations:rect ;; shape:stations:text
  covers: text:# ;; text:# / # loaded ;; text:# blocked · # allowed
  covers: text:# lines · # factory ;; text:## ;; text:+# xp
  covers: text:agent works · # ;; text:blocked ;; text:break +energy
  covers: text:byte ;; text:c# ;; text:cage # · byte
  covers: text:cage # · echo ;; text:cage # · nova ;; text:cage # · pixel
  covers: text:cage # · temp-# ;; text:captain ;; text:d#
  covers: text:dispatch ;; text:echo ;; text:firewall
  covers: text:git ;; text:hired for l# · #m ;; text:hotfix
  covers: text:l# my-app-api ;; text:l# my-app-web ;; text:l# shared-contracts ⇄
  covers: text:leaves after #m idle ;; text:merge ;; text:nova
  covers: text:npm ;; text:orders ;; text:pixel
  covers: text:pr rack ;; text:qc ;; text:s-# sign-in · l#+l#
  covers: text:s-# webhook · l# ;; text:shipments ;; text:shipping
  covers: text:t# ;; text:temp bay ;; text:temp-#
  covers: text:test ;; text:truck waits for all prs ;; text:v#.#
  covers: text:z ;; boxes:CODE ;; boxes:ORDER
  covers: boxes:QC

D02 | not-built | Sandbox cages | - | The HQ header: factory switcher, demo chip, cage chip and the nav buttons. The floor owns the header and later tickets own those targets.
  covers: text:# lines ;; text:+ new order ;; text:+# elsewhere
  covers: text:action items · # ;; text:boards ;; text:debug
  covers: text:demo data ;; text:docs · # ;; text:factory
  covers: text:my-app ;; text:preflight · # ✕ ;; text:prs / mrs · #
  covers: text:sandbox cages · running ;; text:settings ;; text:setup · #
  covers: text:terminal ;; text:▾
  regions: R1-1C1-12

D03 | not-built | Send back to | - | Send back and Report pass to Captain. HQ has no route that does either, so the screen shows no button that would do nothing.
  covers: text:report pass to captain ;; text:send back to pixel

D04 | not-built | What changed | - | The brief inside the card: summary, risk, changed files, tests, how to check, roll back. The merge brief page (P3-17) shows it; this screen links to it by URL and to the posted comment.
  covers: text:# unit tests pass · build ok in #m #s · no e#e for this page yet ;; text:adds the pricing page: monthly or yearly plans, with plan cards that read the currency from the locale. ;; text:also posted as a comment on the pr.
  covers: text:app/pricing/page.tsx · new page with the yearly toggle ;; text:based on ;; text:before merge
  covers: text:brand guide ;; text:components/plan.tsx · plan card, currency from locale ;; text:echo (peer, codex) asked for # change in round #, fixed in round #. coderabbit asked for # change, fixed.
  covers: text:how to check ;; text:nothing. no new secrets, no migrations. ;; text:open /pricing, switch monthly and yearly, and check that the prices and the currency update.
  covers: text:product requirements §# ;; text:revert the merge commit. nothing to clean up. ;; text:review
  covers: text:risk ;; text:risk: low ;; text:roll back
  covers: text:t-# ;; text:tests ;; text:tests/pricing.spec.ts · # new tests
  covers: text:ui only. no api, data or config changes. ;; text:what changed ;; text:written by captain · #m ago
  regions: R7-9C5-12

D05 | changed | Pricing page layout | Add a two-file note | PR data comes from the running factory: one GitHub PR of the scripted run here, six PRs of two repos on the artboard. The rows and the card keep the canvas layout.
  covers: text:!# · nova · ;; text:## · byte · ;; text:## · echo ·
  covers: text:## · nova · ;; text:## · pixel · ;; text:build
  covers: text:clerk sign-in page ;; text:draft ;; text:github
  covers: text:gitlab ;; text:landing hero ;; text:navbar + base layout
  covers: text:pr ## · my-app-web on github · t-#-pricing-page → main ;; text:pricing page layout ;; text:scrapped
  covers: text:shipped ;; text:stripe checkout webhook ;; text:try prisma instead of supabase
  covers: text:typecheck ;; text:unit tests · # ;; text:# # · nova · github
  covers: text:add a two-file note ;; text:by nova · alpha/t# ;; text:ci
  covers: text:passed ;; text:posted as a comment on the pr ;; text:pr # # · acme/app · github · aw/alpha/t# → main
  regions: R2-3C1-12

D06 | changed | FIXED IN ROUND 2 | Review round | Comments are grouped by review round with the verdict of each review. HQ does not claim a comment was fixed, because it has no evidence for that.
  covers: text:docs/note.md:#
  covers: text:app/pricing/page.tsx:# ;; text:components/plan.tsx:# ;; text:echo · peer review (codex)
  covers: text:fixed ;; text:fixed in round # ;; text:plan cards use a hard-coded currency. read it from the locale.
  covers: text:the yearly toggle does not update the price label on first render. add a test for it. ;; text:(current commit) ;; text:approved
  covers: text:changes requested ;; text:commit ;; text:looks right.
  covers: text:please fix the comments. ;; text:review round # ;; text:say "second draft".
  regions: R4-6C1-12

D07 | not-built | +212 −18 | - | Check durations, diff line counts and the worker sprites. HQ records none of the first two.
  covers: text:#m #s ;; text:#s ;; text:by · t-# · +# −#

D08 | changed | CodeRabbit | vega (peer) | Approvals show the reviewers that gave a verdict on the current commit, then You. State is also written for screen readers.
  covers: text:coderabbit ;; text:… you ;; text:✓ coderabbit
  covers: text:✓ echo (peer) · round # ;; text:: approved ;; text:: waiting
  covers: text:vega ;; text:vega (peer) ;; text:you
  covers: text:…

D09 | changed | - | - | Markup and colours: the app stylesheet and shared panel are used, and stamp and link colours are darkened where the canvas colour is under 4.5 to 1.
  covers: anim:stamp ;; font:dom:pixelify sans:10px ;; font:dom:pixelify sans:15px
  covers: font:dom:press start 2p:13px ;; font:dom:silkscreen:10px ;; font:dom:silkscreen:13px
  covers: font:dom:vt323:17px ;; paint:dom:a:bg:#15181c ;; paint:dom:a:bg:#454b55
  covers: paint:dom:a:border-bottom:#454b55 ;; paint:dom:a:border-left:#454b55 ;; paint:dom:a:border-right:#454b55
  covers: paint:dom:a:border-top:#454b55 ;; paint:dom:a:color:#1565c0 ;; paint:dom:a:color:#f5f3ec
  covers: paint:dom:b:color:#1f2328 ;; paint:dom:b:color:#ffca28 ;; paint:dom:button:bg:#23272d
  covers: paint:dom:button:bg:#ffca28 ;; paint:dom:button:border-bottom:#15181c ;; paint:dom:button:border-left:#15181c
  covers: paint:dom:button:border-right:#15181c ;; paint:dom:button:border-top:#15181c ;; paint:dom:button:color:#15181c
  covers: paint:dom:button:color:#f5f3ec ;; paint:dom:dd:color:#1f2328 ;; paint:dom:div:bg:#15181c
  covers: paint:dom:div:bg:#15181c@62 ;; paint:dom:div:bg:#1f2328 ;; paint:dom:div:color:#f5f3ec
  covers: paint:dom:dt:color:#6b7280 ;; paint:dom:header:bg:#1f2328@96 ;; paint:dom:li:color:#1f2328
  covers: paint:dom:p:color:#e3e6ea ;; paint:dom:section:bg:#2f343b ;; paint:dom:span:bg:#15181c
  covers: paint:dom:span:bg:#454b55 ;; paint:dom:span:bg:#9aa1ab ;; paint:dom:span:bg:#e3e6ea
  covers: paint:dom:span:bg:#ffca28 ;; paint:dom:span:border-bottom:#2e7d32 ;; paint:dom:span:border-bottom:#9aa1ab
  covers: paint:dom:span:border-left:#2e7d32 ;; paint:dom:span:border-left:#9aa1ab ;; paint:dom:span:border-right:#2e7d32
  covers: paint:dom:span:border-right:#9aa1ab ;; paint:dom:span:border-top:#2e7d32 ;; paint:dom:span:border-top:#9aa1ab
  covers: paint:dom:span:color:#2e7d32 ;; paint:dom:span:color:#454b55 ;; paint:dom:span:color:#6b7280
  covers: paint:dom:span:color:#9aa1ab ;; paint:dom:span:color:#ff8a65 ;; paint:dom:span:color:#ffa726
  covers: paint:dom:span:color:#ffca28 ;; paint:dom:ul:border-right:#15181c ;; role:icon
  covers: shape:dom:dd ;; shape:dom:dl ;; shape:dom:dt
  covers: shape:dom:icon ;; shape:dom:nav ;; font:dom:silkscreen:12px
  covers: font:dom:silkscreen:14px ;; font:dom:vt323:16px ;; paint:dom:a:color:#0d47a1
  covers: paint:dom:a:color:#ffca28 ;; paint:dom:code:color:#f5f3ec ;; paint:dom:div:border-left:#9aa1ab
  covers: paint:dom:h3:color:#1b5e20 ;; paint:dom:h3:color:#ffa726 ;; paint:dom:h3:color:#ffca28
  covers: paint:dom:h4:color:#f5f3ec ;; paint:dom:header:bg:#2f343b ;; paint:dom:li:bg:#66bb6a
  covers: paint:dom:li:bg:#9aa1ab ;; paint:dom:li:border-bottom:#15181c ;; paint:dom:li:border-left:#15181c
  covers: paint:dom:li:border-right:#15181c ;; paint:dom:li:border-top:#15181c ;; paint:dom:li:color:#15181c
  covers: paint:dom:main:bg:#2f343b ;; paint:dom:main:border-bottom:#15181c ;; paint:dom:main:border-left:#15181c
  covers: paint:dom:main:border-right:#15181c ;; paint:dom:main:border-top:#15181c ;; paint:dom:p:color:#f5f3ec
  covers: paint:dom:span:border-bottom:#1b5e20 ;; paint:dom:span:border-left:#1b5e20 ;; paint:dom:span:border-right:#1b5e20
  covers: paint:dom:span:border-top:#1b5e20 ;; paint:dom:span:color:#1b5e20 ;; shape:dom:article
  covers: shape:dom:code ;; shape:dom:h3 ;; shape:dom:h4
  covers: shape:dom:main ;; shape:dom:a ;; shape:dom:b
  covers: shape:dom:button ;; shape:dom:div ;; shape:dom:li
  covers: shape:dom:p ;; shape:dom:section ;; shape:dom:span
  covers: shape:dom:ul

D10 | changed | ✕ | Press the logo to go back | The logo goes back to the floor, as on Preflight, instead of a close button on an overlay.
  covers: text:✕ ;; text:press the logo to go back to the factory floor

D11 | fixed | Agent Works never merges for you | - | The never-merges note.

D12 | fixed | Open on GitHub to merge | - | The link to merge on the host. It is the only way to merge and it leaves HQ.

D13 | fixed | QC GATE · PRS AND MRS | - | Heading, intro, the TEST STATION and QC REVIEW blocks and the stamps.
