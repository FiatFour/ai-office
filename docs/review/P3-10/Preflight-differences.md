# Preflight artboard versus the built screen

The format is that of `docs/review/P1-3-canvas-differences.md`. `node src/e2e/preflight.mjs` checks this list against the inventories of both renders. Both are a Windows computer, and the built one has docker not answering.

D01 | not-built | SHIPPING | - | The factory floor drawn behind the page. The built screen is a page of its own on a plain background.
  covers: text:# ;; text:# / # loaded ;; text:# blocked · # allowed
  covers: text:## ;; text:+# xp ;; text:agent works · #
  covers: text:blocked ;; text:break +energy ;; text:byte
  covers: text:c# ;; text:cage # · byte ;; text:cage # · echo
  covers: text:cage # · nova ;; text:cage # · pixel ;; text:cage # · temp-#
  covers: text:captain ;; text:change ;; text:d#
  covers: text:dispatch ;; text:echo ;; text:firewall
  covers: text:hired for l# · #m ;; text:hotfix ;; text:l# my-app-api
  covers: text:l# my-app-web ;; text:l# shared-contracts ⇄ ;; text:leaves after #m idle
  covers: text:merge ;; text:nova ;; text:npm
  covers: text:orders ;; text:pixel ;; text:pr rack
  covers: text:qc ;; text:s-# sign-in · l#+l# ;; text:s-# webhook · l#
  covers: text:shipments ;; text:shipping ;; text:t#
  covers: text:temp bay ;; text:temp-# ;; text:test
  covers: text:truck waits for all prs ;; text:v#.# ;; text:z
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
  covers: boxes:CODE ;; boxes:ORDER ;; boxes:QC
  regions: R1-9C1-12
D02 | not-built | Boards | - | HQ menu, factory switcher, demo chip and mode strip in the header. The built header is the logo, which goes back to the floor.
  covers: text:# lines ;; text:+ new order ;; text:+# elsewhere
  covers: text:action items · # ;; text:boards ;; text:debug
  covers: text:demo data ;; text:docs · # ;; text:factory
  covers: text:my-app ;; text:preflight · # ✕ ;; text:prs / mrs · #
  covers: text:sandbox cages · running ;; text:settings ;; text:setup · #
  covers: text:terminal ;; text:▾
D03 | not-built | GIT HOSTS | - | GIT HOSTS group (gh and glab sign-in, push access). Preflight has no git host check.
  covers: text:gh signed in (github.com) ;; text:git hosts ;; text:glab signed in (gitlab.com) · l# my-app-api
  covers: text:l# is on gitlab; hq cannot open mrs or read pipelines. ;; text:my-app-web, my-app-api, shared-contracts ;; text:not signed in
  covers: text:push access to all # repos ;; text:winget install glab.glab; glab auth login ;; text:you · repo, workflow scopes
D04 | not-built | Claude Code installed and signed in | - | AGENTS group (Claude Code, Codex, permission prompts). Preflight has no agent check.
  covers: text:#.x · api key from secrets ;; text:agents ;; text:cages are the boundary
  covers: text:claude code installed and signed in ;; text:claude code permission prompts on ;; text:codex cli signed in · pixel, echo
  covers: text:codex login ;; text:open pixel’s shell ;; text:pixel and echo use codex. they wait until you sign in.
  covers: text:warn
D05 | not-built | GITHUB_TOKEN | - | SECRETS group (protected files, tracked credential files, tokens). Preflight has no secret check.
  covers: text:add secret ;; text:agents would see it in git history. remove it, rotate the values, add it to .gitignore. ;; text:anthropic_api_key
  covers: text:clerk_secret_key · byte ;; text:git rm --cached .env.local; echo .env.local >> .gitignore ;; text:github_token
  covers: text:gitlab_token · l# ;; text:missing ;; text:my-app-api/.env.local is committed
  covers: text:needed for the sign-in task (t-#). byte will ask when it gets there. ;; text:no credential files tracked in the # repos ;; text:not mounted · masked in worktrees · # patterns
  covers: text:protected files hidden from agents ;; text:secrets ;; text:settings → sandbox → secrets
  covers: text:•••• set · keychain
D06 | not-built | Docs folders found | - | LINES group (each line test command, docs folders). Preflight has no line check.
  covers: text:./docs · my-app-api/docs · shared-contracts/proto ;; text:add buf to image ;; text:buf is not in the cage image.
  covers: text:buf: command not found ;; text:cloned · main · go test ./... → ok (go #.#) ;; text:cloned · main · pnpm test → # passed in # s
  covers: text:docs folders found ;; text:l# my-app-api · test station ;; text:l# my-app-web · test station
  covers: text:l# shared-contracts · test station ;; text:lines ;; text:settings → stack → toolchains → add buf, then rebuild the image
D07 | not-built | MCP AND LOGS | - | MCP AND LOGS group (ELK, Notion, Postgres).
  covers: text:connected · # linked doc ;; text:connection refused on localhost:# ;; text:elk (read-only) · l#, l# index patterns
  covers: text:logs-my-app-web-* #,# docs · logs-my-app-api-* #,# docs ;; text:mcp and logs ;; text:notion
  covers: text:only nova uses it, for t-# checks. start your database or turn the server off. ;; text:podman start my-app-db ;; text:postgres (local)
D08 | not-built | Firewall proxy | - | Sandbox rows for the firewall proxy self-test, the no-firewall mode and the Build image button, and the artboard wording of the engine, image and krun rows.
  covers: text:agent-works image build ;; text:agents work without a firewall ;; text:build image
  covers: text:cage image agent-works/agent-base:#.# ;; text:every cage starts from this image (about # min to build). ;; text:firewall is on
  covers: text:firewall proxy: allowed site #, other sites # ;; text:linux only · containers are used instead ;; text:not built yet
  covers: text:podman #.# · podman machine (wsl#) running ;; text:ports # (hq) and # (proxy) free ;; text:registry.npmjs.org # · example.com #
D09 | not-built | Shell for terminals | - | Computer rows for the shell, free disk and the proxy port. The shell is named in the detected card instead.
  covers: text:# gb free ;; text:#.#.# ;; text:both free
  covers: text:free disk (# gb or more) ;; text:node.js # or newer ;; text:powershell #.# · x# · wsl# ok · terminals: conpty
  covers: text:pwsh #.# (powershell #) ;; text:shell for terminals ;; text:v#.#.#
  covers: text:windows # pro #h#
D10 | not-built | Design preview only | - | The design-preview switcher for host and run mode. It belongs to the artboard, not the product.
  covers: text:cages · one per worker ;; text:design preview only · see this page as if on ;; text:in mode
  covers: text:linux ;; text:macos ;; text:no sandbox
  covers: text:shared cage ;; text:windows · powershell
D11 | changed | - | - | Intro, summary sentence and footnote say what this build does. The artboard promises checks before each shift and Action items for warnings, which do not exist.
  covers: text:# lines · # factory ;; text:# warning ;; text:agent works runs these checks when you press start, when the run mode or engine changes, and before each new shift. warnings let the line start; the worker that needs the missing piece files an action item when it gets there. nothing here is sent anywhere: checks run on this computer.
  covers: text:factory · # lines · checks everything this factory needs before the line starts
D12 | changed | - | when you press Start | The footnote and the header note are built text. The footnote also states that the button does not stop a ticket sent straight to the HQ API.
  covers: text:checks everything this computer needs before the line starts. ;; text:select the logo to go to the floor. ;; text:these checks run when you open this page, when you ask again and when you press start. they run on this computer and send nothing anywhere. this button does not stop a ticket sent straight to the hq api.
D13 | changed | - | Cage image | Row labels are the doctor checks (Node 22.18, HQ port, HQ home, host reach, cage image). The compare replaces each row detail, which names this machine, with one word.
  covers: text:cage cannot reach the host ;; text:cage image ;; text:detail
  covers: text:hq home folder ;; text:hq port # ;; text:node.js #.# or newer
D14 | changed | DETECTED | no /dev/kvm | The detected card shows what HQ probed (OS label, shell, arch, kvm, engines), not the artboard sample machine. The compare replaces the engine list, which depends on what the lane machine has installed, with one word.
  covers: text:engines ;; text:pwsh · x# · no /dev/kvm ;; text:windows (#.#.#, x#)
D15 | changed | - | Start Docker Desktop and wait | A failing row shows the doctor fix for this OS under a FIX tag. The artboard fix texts belong to rows that are not built.
  covers: text:fix ;; text:start docker desktop and wait until it reports the engine is running, then switch to linux containers.
D16 | changed | - | - | Colours, fonts and element counts. The page uses floor.css panels and buttons with its own status chips.
  covers: font:dom:pixelify sans:10px ;; font:dom:pixelify sans:11px ;; font:dom:pixelify sans:13px
  covers: font:dom:pixelify sans:15px ;; font:dom:press start 2p:13px ;; font:dom:press start 2p:16px
  covers: font:dom:silkscreen:10px ;; font:dom:silkscreen:12px ;; font:dom:vt323:15px
  covers: font:dom:vt323:17px ;; paint:dom:a:bg:#15181c ;; paint:dom:a:bg:#454b55
  covers: paint:dom:a:bg:#ffca28 ;; paint:dom:a:border-bottom:#15181c ;; paint:dom:a:border-bottom:#454b55
  covers: paint:dom:a:border-left:#15181c ;; paint:dom:a:border-left:#454b55 ;; paint:dom:a:border-right:#15181c
  covers: paint:dom:a:border-right:#454b55 ;; paint:dom:a:border-top:#15181c ;; paint:dom:a:border-top:#454b55
  covers: paint:dom:a:color:#15181c ;; paint:dom:a:color:#90caf9 ;; paint:dom:a:color:#f5f3ec
  covers: paint:dom:b:border-bottom:#66bb6a ;; paint:dom:b:border-left:#66bb6a ;; paint:dom:b:border-right:#66bb6a
  covers: paint:dom:b:border-top:#66bb6a ;; paint:dom:b:color:#ffca28 ;; paint:dom:button:bg:#e3e6ea
  covers: paint:dom:button:color:#1f2328 ;; paint:dom:code:bg:#0d1a24 ;; paint:dom:code:color:#d7ffe6
  covers: paint:dom:div:bg:#15181c ;; paint:dom:div:bg:#15181c@72 ;; paint:dom:div:bg:#1f2328
  covers: paint:dom:div:bg:#3a1f22 ;; paint:dom:div:border-bottom:#2f343b ;; paint:dom:div:border-bottom:#454b55
  covers: paint:dom:div:border-bottom:#ef5350 ;; paint:dom:div:border-left:#454b55 ;; paint:dom:div:border-left:#ef5350
  covers: paint:dom:div:border-right:#454b55 ;; paint:dom:div:border-right:#ef5350 ;; paint:dom:div:border-top:#454b55
  covers: paint:dom:div:border-top:#ef5350 ;; paint:dom:div:color:#f5f3ec ;; paint:dom:header:bg:#1f2328@96
  covers: paint:dom:main:bg:#2f343b ;; paint:dom:main:border-bottom:#15181c ;; paint:dom:main:border-left:#15181c
  covers: paint:dom:main:border-right:#15181c ;; paint:dom:main:border-top:#15181c ;; paint:dom:p:color:#9aa1ab
  covers: paint:dom:section:bg:#15181c ;; paint:dom:section:bg:#23272d ;; paint:dom:section:border-bottom:#454b55
  covers: paint:dom:section:border-left:#454b55 ;; paint:dom:section:border-right:#454b55 ;; paint:dom:section:border-top:#454b55
  covers: paint:dom:span:bg:#6b7280 ;; paint:dom:span:bg:#ef5350 ;; paint:dom:span:bg:#ffca28
  covers: paint:dom:span:color:#66bb6a ;; paint:dom:span:color:#9aa1ab ;; paint:dom:span:color:#d7ffe6
  covers: paint:dom:span:color:#ef5350 ;; shape:dom:icon ;; shape:dom:nav
  covers: shape:dom:rect ;; font:dom:silkscreen:11px ;; font:dom:silkscreen:13px
  covers: font:dom:silkscreen:18px ;; font:dom:silkscreen:22px ;; paint:dom:a:color:#ffca28
  covers: paint:dom:b:color:#ff8a80 ;; paint:dom:code:bg:#15181c ;; paint:dom:code:color:#f5f3ec
  covers: paint:dom:h2:color:#f5f3ec ;; paint:dom:header:bg:#2f343b ;; paint:dom:li:border-top:#15181c
  covers: paint:dom:p:color:#c9cdd4 ;; paint:dom:section:bg:#2f343b ;; paint:dom:span:bg:#c9cdd4
  covers: paint:dom:span:bg:#ff8a80 ;; shape:dom:h2 ;; shape:dom:li
  covers: shape:dom:ul ;; shape:dom:a ;; shape:dom:b
  covers: shape:dom:button ;; shape:dom:code ;; shape:dom:div
  covers: shape:dom:section ;; shape:dom:span
D17 | fixed | PREFLIGHT CHECK | PREFLIGHT CHECK | Title, detected-computer card, run mode label, the two group names, the verdict, START, Re-detect and Check again read as on the artboard.
  covers: text:preflight check ;; text:detected ;; text:run mode
  covers: text:this computer ;; text:sandbox ;; text:operating system
  covers: text:container engine running ;; text:check again ;; text:re-detect & run all
  covers: text:▶ start the line ;; text:not ready
