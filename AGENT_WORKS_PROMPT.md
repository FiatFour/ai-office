# Build prompt — Agent Works (Code factory)

Paste everything below the line into Claude Code, run in an empty folder.

---

Build an open-source local tool called **Agent Works**: a CLI plus a web dashboard that runs a team
of AI coding agents on the user's Git repos (GitHub and GitLab) and shows them as workers in a pixel-art **code factory**.
Do not use the name, logo or art of any existing project; everything here is original.

## 1. Core idea

- The user runs `npx agent-works` inside a git repo, or in a parent folder that holds several
  repos. It starts (or reuses) **one local HQ server** (default port 7420) and opens the dashboard.
- A **factory** is one project. It can have **many repos** (production lines), and one repo can
  belong to **many factories**. The HQ runs many factories at once (see §5).
- A **lead** agent ("Captain", in the Dispatch office) plans the sprint and writes work orders.
  Rule: **1 work order = 1 task = 1 branch = 1 PR** (an MR on GitLab).
- **Worker** agents each get their own **cage** (an isolated sandbox), their own copy of the repo,
  and pick up boxes (tasks) from the conveyor. They push a branch and open a PR.
- Every PR goes **Test station → QC gate (peer agent review + optional bots) → Merge → Shipping**.
  HQ follows PRs/MRs on GitHub and GitLab,
  sends review comments back to the author, tells the lead when a PR passes, and closes the task
  when the PR is merged.
- **HQ never merges.** The human merges on GitHub or GitLab. Decisions, API keys and blocked websites appear
  in **Action items** for the human to answer.

## 2. Tech stack

- TypeScript everywhere, pnpm workspace, Node.js 20+. Runs on **Linux, macOS and Windows (PowerShell 7)**;
  no bash-only scripts in the CLI or server (use Node for file and process work).
- `bin/` CLI: `agent-works [open|ls|stop|add-repo|doctor]`. `doctor` runs the preflight check (§4) in the
  terminal; `--json` for scripts, exit code 1 when anything is blocking. Flags: `--factory <name>`, `--port <n>`
  (default 7420), `--mode <cages|subagents-cage|subagents-local>` (see §4), `--engine <id>` (overrides auto-detect), `--no-open`, `--demo`
  (mock data, no agents), `--version`, `--help`.
- `server/`: Node HTTP + WebSocket. One in-memory "snapshot" of the factory, pushed to the UI on
  every change (rev number increments). Global registry in `~/.agent-works/factories.json` and
  `~/.agent-works/repos.json`; per-factory state in `~/.agent-works/factories/<name>/state.json`.
- `src/`: React + Vite. The factory floor is a low-res **480×270 pixel-art scene** (SVG or canvas,
  `image-rendering: pixelated`) scaled to the window, with HUD panels floating on top.
- Terminals: `node-pty` streamed to `xterm.js` (ConPTY on Windows). tmux runs **inside the cage**, so the
  host never needs tmux.
- Agent runtimes: adapter per CLI — **Claude Code** and **OpenAI Codex** to start; easy to add more.
- External tools on the host: git, `gh` (GitHub) and/or `glab` (GitLab), and **one of** the sandbox engines in §4.

## 3. Folder layout

```
bin/  server/  src/  images/  scripts/  docs/  .claude/skills/  .github/workflows/
server/sandbox/   drivers: sbx.ts container.ts (docker + podman) + engine.ts + proxy/
server/modes/     cages.ts subagents.ts (hooks → HQ events)
README.md  CONTRIBUTING.md  SECURITY.md  LICENSE (MIT)
```

## 4. Run modes and sandboxes (Linux, macOS, Windows)

### Run modes (Settings → Sandbox → Run mode, or `--mode`)

| Mode | How workers run | Firewall | Mixed runtimes | Notes |
|---|---|---|---|---|
| `cages` (default) | one cage per worker, each with its own worktree and terminal | yes | Claude Code + Codex | full factory, many factories at once |
| `subagents-cage` | one shared cage; Captain runs Claude Code there and workers are its **subagents** (`.claude/agents/<worker>.md`), each on its own git worktree | yes | Claude only | lighter: one engine container per factory |
| `subagents-local` | Captain runs Claude Code on the host; workers are subagents on git worktrees | **no** | Claude only | needs no engine; for trusted repos only |

- All three modes work on Linux, macOS and Windows. Auto picks `cages` when an engine is found,
  else offers `subagents-local` with a clear NO SANDBOX warning (never silently).
- Subagent modes keep the same rules: 1 task = 1 branch = 1 PR, peer review by another subagent,
  merge brief, human merges. HQ follows subagents through Claude Code **hooks** (subagent start /
  stop, tool use) posted to HQ, plus git and PR/MR state, so the floor still animates.
- `subagents-local`: Claude Code permission prompts stay on (no "skip permissions"), saved secrets
  go only to `gh` / `glab`, never to the agent; one factory at a time; the floor shows workers
  without cages and the FIREWALL zone greyed out with "Off · no sandbox".
- Floor per mode: `cages` = mesh cage per worker; `subagents-cage` = cages removed, desks labelled
  "SUBAGENT · <name>", one blue SHARED CAGE outline around Dispatch and all worker desks;
  `subagents-local` = desks only, firewall greyed out. The HUD chip shows the mode and count
  ("MODE Cages | Sandbox cages · 6 running", "Shared cage · 1 running · 5 subagents",
  "No sandbox · 5 subagents") and links to Settings → Sandbox.
- In `subagents-local` there is no firewall, so nothing is "blocked": Claude Code **permission
  prompts** (Bash, WebFetch, first use of an MCP tool) become Action items instead, shown as an
  orange "ASKS YOU" box on the belt, with **Allow once / Deny** on the worker card and
  "Answer permission requests" on the control panel. HQ answers them through a
  permission hook. In subagent modes the worker card shows runtime "Claude Code subagent" and
  station "Subagent" instead of a cage number.
- Mode is per factory; switching needs no open boxes in CODE.

### Hosts (detected automatically, never chosen by the user)

On start, and on "Re-detect", HQ fills a `HostInfo`: OS and version from `process.platform` /
`os.release()`; WSL2 when platform is linux and `/proc/version` contains "microsoft" (shown as
"Linux (WSL2 on Windows)"); terminal shell = `pwsh` if found, else `powershell.exe` on Windows, else
`$SHELL`; CPU arch; `/dev/kvm`; every engine's detect result. The shell used to launch the CLI
does not matter. Settings → Sandbox shows it as a read-only **DETECTED** row with Re-detect; the HUD
mode chip carries a short tag (`WIN · PWSH`, `LINUX`, `MACOS`, `WSL2`); Debug lists host, shell,
engine, run mode and preflight state. `--engine` / `--mode` only override detection.

### Preflight check (before the line starts)

A per-factory checklist run when the user presses Start, when the run mode or engine changes,
before each new shift, and by `agent-works doctor`. Each check returns PASS / WARN / FAIL / SKIP
(not needed in this run mode or on this OS), what it found, and — for WARN/FAIL — why it matters and
the fix for **this OS** (e.g. glab: `winget install GLab.GLab` / `sudo apt install glab` /
`brew install glab`), plus an action button where HQ can do it itself and "Check again".
Groups:
- **This computer** — OS, Node 20+, git, terminal shell, free disk (10 GB+), ports 7420 / 7421 free.
- **Sandbox** — engine running, cage image built (button "Build image"), firewall proxy test
  (allowed site 200, other 403), krun (Linux only); in `subagents-local` all SKIP plus a WARN
  "agents work without a firewall".
- **Git hosts** — `gh` / `glab` signed in for every host the factory's repos use, push access per repo.
- **Agents** — Claude Code installed + signed in; Codex signed in when a worker uses it (SKIP in
  subagent modes); permission prompts on (`subagents-local`).
- **Secrets** — every secret a worker, line or MCP server declares; missing = WARN, or FAIL if marked required.
- **Lines** — repo cloned, base branch exists, test-station command runs once (in the cage, or on the
  host in `subagents-local`), toolchain present (e.g. `buf` → add to the image's toolchains), docs folders found.
- **MCP and logs** — each granted MCP server answers; log index patterns return docs.
FAIL blocks ▶ START THE LINE; WARN does not (the worker files an Action item when it needs the
missing piece). The menu shows "Preflight · N ✕" while anything is blocking. Checks run locally only.

- **Linux**: all engines; `podman-krun` needs `/dev/kvm`.
- **macOS**: Docker / Podman through their Linux VM (`podman machine`, Docker Desktop, Colima); no krun.
- **Windows (PowerShell 7)**: Docker Desktop or Podman (`podman machine`), both on WSL2; no krun.
  Call the `docker.exe` / `podman.exe` CLIs from Node. Terminals use node-pty (ConPTY) to run
  `<engine> exec -it <cage> tmux attach -t aw`. State lives in `%USERPROFILE%\.agent-works`;
  secrets in Windows Credential Manager (use a cross-platform keychain library). Use `path` APIs,
  never hard-coded `/`; convert Windows paths for bind mounts. Clone repos inside the WSL2 file
  system when the user allows it (much faster mounts); otherwise mount from `C:\` and warn.
  Test-station commands run inside the cage (Linux), so `pnpm test`, `go test` work unchanged; in
  `subagents-local` they run in `pwsh`.
- Running the whole app inside WSL2 (`wsl npx agent-works`) is also supported and behaves like Linux.

### Sandbox drivers: support Docker AND Podman

Put every sandbox operation behind one interface so the rest of the app never knows which engine
is running.

```ts
interface SandboxDriver {
  id: 'docker' | 'podman' | 'podman-krun' | 'sbx';
  detect(): Promise<{ ok: boolean; version?: string; reason?: string; fix?: string }>;
  ensureImage(): Promise<void>;                     // build/pull images/agent-base
  ensureNetwork(project: string): Promise<void>;    // internal net + egress proxy
  create(agent: AgentSpec): Promise<CageId>;
  start(id: CageId): Promise<void>;
  stop(id: CageId): Promise<void>;
  remove(id: CageId): Promise<void>;
  execArgs(id: CageId, cmd: string[]): string[];    // argv used by tmux/node-pty
  stats(id: CageId): Promise<{ cpu: number; memMb: number }>;
}
```

Drivers:

| id | What it runs | Isolation |
|---|---|---|
| `docker` | `docker` CLI, plain containers | namespaces, shared kernel |
| `podman` | `podman` CLI, **rootless** containers | namespaces, shared kernel |
| `podman-krun` | `podman run --runtime=krun` (crun-krun / libkrun) | microVM per cage |
| `sbx` | Docker Sandboxes CLI (`sbx`) | microVM per cage, own network policy |

**Auto-detect order** (first that passes wins, user can override in Settings → Sandbox or with
`--engine`): `sbx` → `podman-krun` → `podman` → `docker`; if none is found, offer the `subagents-local` run mode. Show every engine's detect
result in the Safety check screen with a one-line fix.

Implement Docker and Podman with **one shared container driver** that shells out to the engine CLI
(`docker` or `podman` binary chosen at runtime). Do not use the Docker socket. Handle the
differences explicitly:

- **Rootless Podman file ownership:** add `--userns=keep-id` so files written in the bind-mounted
  repo belong to the host user. For Docker, pass `--user $(id -u):$(id -g)`.
- **SELinux (Fedora/RHEL):** append `:Z` to bind mounts when SELinux is enforcing.
- **krun:** it ignores the image `USER`, so the entrypoint must drop to the `agent` user itself.
  Pass CPU/memory with `--cpus/--memory` (krun reads them); verify networking works on startup.
  If a test `podman run --runtime=krun` fails (e.g. no `/dev/kvm`, or macOS), mark
  `podman-krun` unavailable and fall back to `podman`.
- **macOS:** both engines run inside a VM (`podman machine` / Docker Desktop / Colima). Detect a
  stopped VM and show "Start the Podman machine" / "Start Docker" as the fix.
- **Image:** one `images/agent-base/Containerfile` that builds on both engines: Debian slim, Node 20,
  git, gh, tmux, ripgrep, Claude Code CLI, Codex CLI, plus optional toolchains from the stack
  (Go, etc.). Tag `agent-works/agent-base:<version>`.
- **Labels:** every cage and network carries `agent-works.project=<name>` and
  `agent-works.agent=<id>` so cleanup works on both engines.

### Firewall (same behaviour on every container engine)

`sbx` has its own network policy; for `docker`, `podman` and `podman-krun` build it yourself:

1. Create an **internal network** per project (`--internal`, no route out).
2. Run one **egress proxy** container on both the internal network and the normal one. It allows
   `CONNECT host:port` only for hosts on the allowlist, everything else gets 403.
3. Agent cages join only the internal network and get `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`.
   Traffic that ignores the proxy has no route out, so it fails closed.
4. Every denied request is POSTed to HQ (`/api/sandbox/deny`), becomes an **Action item**
   ("Nova wants to reach api.stripe.com — Allow / Dismiss"), and lights a red box in the
   FIREWALL zone on the factory floor.
5. Policies: **Locked** (package registries only), **Balanced** (registries, GitHub, docs of
   stocked skills), **Open** (anything). Allowlist is per project with per-agent additions.

### Secrets and agent sign-in

- Secrets (`GITHUB_TOKEN`, `CLERK_SECRET_KEY`, …) live in the OS keychain when available, else
  `~/.agent-works/<project>/secrets.json` with mode 0600. Inject as env vars at cage start.
  The UI never shows a saved value again.
- Missing secrets an agent asks for become **API KEY** action items with a password field.
- Claude Code / Codex sign-in: support an API key secret, or a one-time interactive login from the
  worker's Shell tab; persist that CLI's config in a per-agent volume, never the host's home dir.

### Protected files (agents never read or write credentials)

Always on, in every run mode, for every worker and Captain; there is no "allow once". Agents get
secrets **only** as env vars from the Secrets list.

- **Built-in patterns (locked):** `.env`, `.env.*`; `*.pem *.key *.p12 *.pfx *.jks`; `~/.ssh/**`,
  `id_rsa*`, `id_ed25519*`; `~/.aws/**`, `~/.azure/**`, `~/.config/gcloud/**`;
  `~/.config/gh/hosts.yml`, `~/.config/glab-cli/**`; `~/.docker/config.json`, `~/.kube/config`,
  `kubeconfig*`; `.npmrc .pypirc .netrc .git-credentials`; `credentials*.json *secret*.json *.tfvars`;
  Agent Works' own `secrets.json` and the OS keychain. **Allowed:** `.env.example .env.sample
  .env.template *.pub`. Users can add patterns per factory (`protected:` in `agent-works.yaml`), not remove built-ins.
- **Enforcement, layered:**
  1. *Not mounted* — the host home dir is never mounted; cages get only the worktree and `/docs`.
  2. *Masked in worktrees* (`cages`, `subagents-cage`) — every matching file inside a mounted repo
     is covered with an empty read-only bind / tmpfs at cage start (re-scanned on pull).
  3. *Agent deny rules* — generate Claude Code `permissions.deny` entries (`Read(**/.env)`,
     `Edit(**/.env)`, `Read(~/.ssh/**)`, …) in each worker's managed settings, and the equivalent
     Codex sandbox config.
  4. *PreToolUse hook* — blocks Bash / tool calls whose arguments touch a protected path (`cat`,
     `cp`, `grep -r` over it, redirects). Needed most in `subagents-local`, where it is **best
     effort**: the UI says so, and Preflight warns.
  5. *Pre-commit / pre-push guard* in every worktree — refuses commits that add a protected file or
     a detected secret (gitleaks-style scan); QC also scans the PR diff.
- Every blocked attempt is logged (worker, tool call, which layer stopped it) and becomes an Action
  item; repeated attempts by one worker pause it.
- Preflight checks: rules active for the run mode, and **no credential file is tracked in any line's
  repo** (FAIL with `git rm --cached …` + rotate the values).
- Settings → Sandbox shows a PROTECTED FILES section: ALWAYS ON banner with the layers used in the
  current mode, the pattern list (BUILT-IN / YOU, locked or removable), "Protect pattern" input, the
  ALLOWED templates, and BLOCKED ATTEMPTS.

## 5. Factories and repos (many-to-many)

Data model:

```
Factory  1──*  Line  *──1  Repo          (a Line = one repo inside one factory)
Factory  1──*  Worker, Board, Task, Shipment, Secret, Allowlist, MCP grant
Task     *──1  Line                       (1 task = 1 branch = 1 PR in one repo)
Shipment 1──*  Task                       (a feature that spans several repos)
```

- **Repo depot**: every repo is registered once (`repos.json`) with its remote, default branch and
  one clone at `~/.agent-works/repos/<repo>`. Factories reference repos; they never copy them.
- **Lines** (per factory): base branch, test-station command, which workers may take boxes from
  that line, and display order. Optional per-factory `agent-works.yaml` in the factory folder:
  ```yaml
  factory: my-app
  lines:
    - repo: ./my-app-web
    - repo: ./my-app-api
      test: go test ./...
    - repo: ../shared-contracts        # shared with other factories
  integration: ./compose.test.yaml     # stack the test station starts for cross-repo tests
  docs:
    - path: ./docs                     # factory-wide, cross-repo (requirements, architecture)
    - path: ./my-app-api/docs          # docs that version with one repo
      line: my-app-api
    - link: https://www.notion.so/billing-spec   # stays in Notion, synced through MCP
      line: my-app-api
    - path: ~/private/runbook.pdf      # outside Git
      send_to_ai: false
  ```
  Where docs live: (1) a repo's own `docs/` for docs that belong to that service and version with
  its code (auto-scoped to that line); (2) the factory's `./docs` for cross-repo docs; shared specs
  (proto, Avro, XSD) go in a shared repo such as `shared-contracts`; (3) files dropped into the
  Blueprint room are stored outside Git in `~/.agent-works/factories/<f>/docs/`; (4) links to
  Notion / Confluence / Google Docs stay at the source and are snapshotted on a schedule.
  Settings → Lines shows a "Docs folder" per line and a "Factory docs" list that edit this block.
- **Logs per line** (optional, used for merge-brief evidence):
  ```yaml
    - repo: ./my-app-api
      logs:
        source: elk                       # MCP server id from Settings → MCP
        index: logs-my-app-api-*          # production
        preview_index: logs-my-app-api-staging-*
        kql: service.name:"my-app-api" and not log.level:"debug"   # always ANDed into every query
  ```
  Settings → Lines has a LOGS row per line (source, two index patterns, base KQL, "Test query"
  that runs a read-only count for the last 24 h). Workers may only query the index patterns of the
  line their box is on. A line with `source: none` gets "logs not collected" in its briefs.
- **Branch prefix per factory**: `aw/<factory>/<task>`. A shared repo has one GitHub watcher that
  routes PR events to the owning factory by prefix (and a `agent-works:<factory>` label). Each
  factory sees only its own PRs. If two factories touch the same files, QC shows the conflict.
- **Worktrees**: each worker gets a worktree per line it works on at
  `~/.agent-works/factories/<f>/<agent>/<repo>`, and a cage mounts only the repos its current box
  needs. The lead gets read-only views of every line.
- **Shipments**: the lead groups cross-repo work into a shipment, orders it provider/contract
  first, consumers after, and the truck leaves only when every PR in the shipment is merged.
- **Many factories in one HQ**: URLs `/f/<factory>/…`; a factory switcher in the top bar (with
  "needs you elsewhere" counts and ⌘K search); factories keep running in the background.
  Secrets, allowlists, MCP grants, docs and boards are per factory; the cage image and skill files are shared.

### Running many factories at the same time

- **Machine budget**: one cap on running cages across all factories (default 8, user-set). Extra
  cages wait in a queue; **priority** (High / Normal / Low) decides who gets the next free cage.
- **Per-factory cage quota** (stepper on each factory card).
- **Focus mode**: one factory runs at full quota; every other running factory drops to 1 worker
  and takes no new boxes until focus ends.
- **Model usage meter** per factory per day (tokens or requests as the runtime reports them), with
  a warning before the account limit is near. All factories share one Claude / Codex account.
- **Global Inbox**: every Action item from every factory in one list, tagged and filterable by
  factory. The factory switcher shows "+N elsewhere".
- **Shared-repo file locks**: when a factory opens a box that touches files in a shared repo, those
  paths are reserved; another factory that wants them gets a "SHARED REPO" Action item to decide
  who goes first.

### Hiring policy (Settings → Team)

Three modes per factory:

- **Manual**: the user hires every worker. When boxes outnumber free workers they wait on the belt.
- **Ask me** (default): when a trigger fires (boxes waiting longer than N min, or N+ boxes on one
  line), Captain files a **HIRE** Action item ("L2 has 3 boxes waiting 12 min — hire 1 temp?").
  Hiring happens only after the user approves.
- **Auto**: Captain hires temps on its own.

In every mode a hire never goes past the factory's cage quota or the machine budget, and never past
"Max temp workers" (default 2). Temps are created from the **line template** (runtime, skills,
docs, cage size), wear an orange hard hat with a TEMP tag on the floor, sit in a TEMP bay cage on
their line, and are let go after an idle timeout (default 15 min; "Never" allowed). "Keep on team"
turns a temp into a permanent worker. Every hire and release goes to the Shift log.

### Docs (Blueprint room)

- Per factory, a docs library. Sources: uploaded files (Markdown, PDF, Word, images), machine specs
  (OpenAPI, proto, Avro, XSD, SQL), a repo's `docs/` folder (auto-synced on pull), links snapshotted
  through the firewall proxy, and Notion / Confluence / Google Docs through MCP.
- Scope per doc: whole factory, one line, or shared with other factories (many-to-many, like repos).
- Store under `~/.agent-works/factories/<f>/docs/` with a JSON index (title, type, scope, source,
  synced_at, flags). Convert PDF/Word to text for search; keep the original.
- Flags: **Pin for lead** (Captain reads it before every sprint and work order), **Rules** (merged
  into every cage's `AGENTS.md` / `CLAUDE.md`), **Do not send to AI** (never mounted, never quoted).
- Workers get only the docs for the line of their current box, read-only at `/docs` in the cage,
  plus a local full-text index they can query. Work orders cite doc sections ("spec.md §3.2"); the
  UI shows which work orders use each doc. Captain writes a short summary for long docs.

## 6. Git hosts, peer review, terminals

### GitHub and GitLab

Put every host call behind one interface; each repo picks its driver from its remote URL
(github.com → GitHub; gitlab.com or any URL marked as GitLab in the repo depot → GitLab,
self-hosted base URL allowed). The UI says "PR #14" for GitHub and "MR !8" for GitLab.

```ts
interface GitHost {
  id: 'github' | 'gitlab';
  detect(remote: string): boolean;
  auth(): Promise<{ ok: boolean; user?: string; fix?: string }>;   // gh auth status / glab auth status
  openChange(repo, branch, title, body, draft): Promise<ChangeRef>; // PR or MR
  listOpen(repo, branchPrefix): Promise<Change[]>;
  checks(ref): Promise<Check[]>;                                    // Actions / GitLab CI pipelines
  comments(ref): Promise<Comment[]>;
  postReview(ref, verdict: 'approve' | 'changes', comments: Comment[]): Promise<void>;
  mergedOrClosed(ref): Promise<'open' | 'merged' | 'closed'>;
}
```

- GitHub via `gh` / REST; GitLab via `glab` / REST v4 (works with self-hosted). Tokens:
  `GITHUB_TOKEN`, `GITLAB_TOKEN` per factory, scoped per line if needed.
- Webhooks when HQ is reachable, polling otherwise; one watcher per repo, routed by branch prefix.
- Firewall Balanced policy allows github.com / gitlab.com plus any self-hosted GitLab host in the depot.
- Safety check shows `gh` and `glab` sign-in for every host the factory's repos use.

### Peer review (agents review each other)

- "Peer agent" is a QC inspector next to CodeRabbit / Greptile / Copilot / You (Settings → Workflow).
- **The author never reviews its own work.** Reviewer choice: any free worker on the same line, a
  worker on a different runtime (Claude reviews Codex, Codex reviews Claude — the default), or a
  dedicated worker with the Reviewer role.
- The reviewer gets the work order, the diff, the line's docs and the test results, and posts a
  real review on the PR/MR (approve or request changes with line comments) through `GitHost.postReview`.
- The author fixes and pushes; the reviewer re-reviews. After N rounds (default 3) with comments
  still open, it becomes an Action item for the human.
- Peer approvals count toward "approvals needed before ready to merge". Merging stays human.

### Tickets: features, defects, chores, spikes

- **New order** form (top menu "+ New order", control panel Q, key `N`, "+ New order" on Boards):
  type Feature / Defect / Chore / Spike, title, what and why, line(s) or "let Captain decide",
  docs to attach, due date, **Rush** switch.
- Defect adds: steps to reproduce, expected vs actual, severity **S1–S4** (S1 = down, money or data
  at risk; turns Rush on), **Found in** (environment + release + one version row per repo it
  touches), caused by (pick a merged PR/MR), attachments (logs, screenshots, HAR).
- **Release manifests** (multi-repo versions): every time a shipment or merge ships, record a factory
  release (`v0.1.3`) as `{ repo: tag-or-sha }` for every line, optionally tagging each repo.
  Store in `~/.agent-works/factories/<f>/releases.json`. Picking a release in the defect form fills
  the version of every repo; each row can be overridden (tag, branch or SHA) or left unknown. With no
  release, Captain bisects from the last good release to find the breaking commit per repo.
- Tickets land in ORDER (IDs F-, D-, C-, S-). Captain splits them into boxes per line, or asks the
  human first through a Decision Action item when details are missing. Spikes produce a findings doc
  in the Blueprint room instead of a PR.
- Defect flow: reproduce → failing test → fix → peer review → merge brief with **root cause** and
  **the test that now guards it**.
- **Rush / HOTFIX**: a red HOTFIX box goes to the front of its line's queue; the first free worker on
  that line takes it.
- **Ticket sources** (Settings → Workflow): GitHub Issues and GitLab Issues with label `agent-works`
  (bug label → Defect), Jira through MCP (project + JQL). Imported tickets keep a link to the source;
  on merge Agent Works comments on the issue and closes it.

### Merge brief (before the human merges)

When a PR/MR passes the test station and QC (approvals met, checks green), Captain writes a
**merge brief** and only then files the "ready to merge" Action item. The brief is stored with the
change, shown in the QC gate, summarised on the Action item, and posted as a PR/MR comment
(switchable in Settings → Workflow). Fields:

- **Summary** — one or two sentences on what this change does and why.
- **What changed** — files or areas, one line each.
- **Tests** — what ran and the result (unit, build, e2e, contract), and what did not run.
- **Review** — who reviewed (peer agent, bots, people), how many rounds, what was asked and fixed.
- **Risk** — LOW / MEDIUM / HIGH with the reason (data, migrations, auth, money, shared contracts).
- **Before merge** — anything the human must do first: secrets, migrations, feature flags, merge order.
- **How to check** — a short manual check after merging.
- **Roll back** — how to undo it.
- **Based on** — the work order and the doc sections it followed.
- **Evidence** — proof that the change works (see below).
- **Root cause** (defects only) — what caused it and which PR introduced it.

**Evidence** (Settings → Workflow → "Attach evidence to the brief", on by default):

- **Screenshots** — for UI changes the worker takes before/after shots inside its cage with a
  headless browser (Playwright is in the cage image). "Before" is the released version or the
  version from the ticket's FOUND IN; "after" is the preview build of this branch. Each shot names
  the locale, viewport and URL. Images are uploaded to the PR/MR comment and stored with the brief.
- **CI runs** — links and status from `GitHost.checks()` (GitHub Actions run / GitLab pipeline).
- **Test output** — for defects, the new test that fails on the old version and passes on this
  branch, with both outputs saved.
- **Logs (ELK through MCP)** — if an ELK / Kibana MCP server is set up (Settings → MCP), the worker
  runs **read-only** queries scoped to the line's index pattern (set per line, e.g.
  `logs-my-app-web-*`). It records the KQL query, the time range, the hit count before the fix
  (production) and after (preview or staging), a small histogram and a "Open in Kibana" Discover
  link. Other log backends (Loki, Datadog, CloudWatch) use the same shape via their MCP server.
- **Masking** — before any log line is shown or posted, user ids, emails, phone numbers, card and
  account numbers and tokens are masked (`u_****21`). Raw lines never leave the cage.
- A missing piece of evidence is listed as "not collected" with the reason; it never blocks the
  brief, but HIGH risk changes with no evidence are flagged.

For a **shipment**, Captain also writes a shipment brief: every PR/MR in it, the merge order
(contracts / providers first), and what breaks if only some are merged.
Drafts, changes-requested and scrapped changes get no brief.

**Merge brief page** (its own screen, opened from the "ready to merge" Action item and from the QC
gate): READY banner with risk, stat tiles (files, tests, approvals, review rounds, open comments),
summary, files with +/− counts, tests list, an **Evidence** section (screenshot pairs, then cards
for CI, ELK, LOG and TEST with an open ↗ link, hit counts and a mini histogram), review timeline
per round, risk, a **"Before you merge"
checklist** the human ticks (the merge button shows n/N checked), how to check after merge, roll
back, and "Based on" links to the work order and docs. A tab per shipment shows the merge order,
the state of each PR/MR, and what breaks if only part of it is merged.

### Repo copies and terminals


- One tmux session per agent **inside its cage** (`aw`); the server attaches with node-pty running the
  engine's exec argv (ConPTY on Windows) and streams it over WebSocket. In subagent modes there is one
  terminal for Captain's Claude Code session, and worker rows show their latest hook events instead. The **Terminal** screen opens a host shell in the repo, any agent's
  folder, or any folder.
- Agents talk to each other through HQ (small HTTP API or an MCP server exposed to each cage).
- Review loop: forward review comments from peers, people and bots to the author; report passing
  PRs/MRs to the lead; mark the task done when merged.

## 7. Screens (Code factory design)

Palette: steel panels `#2f343b` / `#15181c`, cream `#f5f3ec`, safety yellow `#ffca28` with
yellow-black hazard stripes, green `#66bb6a`, red `#ef5350`, blue `#42a5f5`, orange `#ffa726`.
Fonts: Silkscreen (labels), Press Start 2P (big numbers), Pixelify Sans (UI), VT323 (terminal).
Workers are small human sprites with **hard hats** (lead = white hat + clipboard) and hi-vis vests.
States: Working (bob + typing arms + "…" bubble), Needs you (jumping + yellow "!"),
At QC (walking a box to QC), On break (eyes closed, "z Z").

1. **Title screen** — big AGENT WORKS logo, crew lineup, ▶ NEW SHIFT / CONTINUE / SETTINGS,
   blinking PRESS START.
1a. **Industrial park** — every factory as a pixel building (smoke = running, "!" = needs you,
   dark = stopped), factory cards with lines, sprint progress and Start/Pause, machine budget
   meter, New factory form.
1b. **Repo depot** — every repo × every factory as a checkbox matrix, host column (GitHub /
   GitLab / GitLab self-hosted), shared repos marked,
   details panel (branch prefix per factory, open PRs), Add to depot.
1c. **Inbox** — Action items from all factories, filter by factory, colour stripe per factory.
   The Industrial park cards also carry: cage quota stepper, priority, model usage meter,
   Focus here, Start/Pause, and a machine budget bar coloured by factory.
2. **Factory floor (HQ)** — the pixel scene: Dispatch office with ORDERS board,
   break room, FIREWALL zone (laser gate, red blocked boxes, green allowed boxes, counter), PR rack,
   **one conveyor belt per line** (labelled L1, L2, …; shared repos marked ⇄) with that line's
   cages on its left, shared TEST → QC → MERGE gantries across all belts, then SHIPPING (truck
   shows "4 / 9 loaded" and a Shipments board). Boxes carry a coloured tag per shipment, so a
   cross-repo feature shows the same tag on several belts. Cage gate light: green ok / red blocked.
   HUD: top menu bar (factory switcher, Setup · Action items · Boards · Docs · PRs · Terminal · Settings · Debug, plus
   order-board select, line speed 1x/2x/4x, zoom, "Sandbox cages · N running"), left Factory
   level + Crew roster (energy = context left, station) + Shift log, right factory map + shift
   clock + Production order counts per station + selected worker card, bottom control panel
   (Q order, W QC, E unlock, R stop line, T terminal, Y hire), "Shipment delivered" toasts.
   Keys 1–9 open workers, D toggles Debug.
3. **Worker file** — portrait, level, energy/XP, tool belt (skills), tabs: Terminal, Shell,
   Work order, Sandbox (sites tried, allow/block), Messages.
4. **Staff your factory (setup)** — name the factory, choose lead runtime, hire 1–6 workers with
   Claude Code/Codex per worker, stock the skill store, Safety check (engine detect results), ▶ START THE LINE (opens the Preflight check first if it has blocking items).
4b. **Preflight check** — DETECTED host row with run mode and Re-detect, summary (passed /
   warnings / blocking / not needed) with ▶ START THE LINE disabled until nothing blocks, then the
   groups above as cards with status chips, found value, OS-specific fix command and Check again.
4a. **Blueprint room** — docs list (type icon, scope, source, synced, LEAD / RULES / LOCKED
   badges), filters, drop zone + add link, viewer with Captain's summary, scope select, the three
   flags as switches, "Used in work orders" chips.
5. **Action items** — punched tickets filtered by Hiring / Websites / Decisions / API keys / Reviews;
   a "ready to merge" ticket carries the short merge brief and links to the full one.
6. **Production boards** — columns ORDER, CODE, TEST, QC, SHIPPED; switch boards; progress bar;
   "+ New order"; cards show DEFECT Sx and HOTFIX chips.
6a. **New order** — Feature / Defect / Chore / Spike form with defect fields, severity, lines,
   docs, due, Rush; after sending, shows Captain's plan for it.
6b. **Merge brief** — the full summary page described in §6 (PR tab and shipment tab).
7. **QC gate · PRs and MRs** — list with `#n` (GitHub) or `!n` (GitLab) and stamps (SHIPPED,
   READY, CHANGES, AT QC, DRAFT, SCRAPPED); details: repo and host, checks, approvals row (peer agent,
   bots, you), review comments, the **merge brief** (risk chip + all fields), "Open on GitHub/GitLab
   to merge" (never merge from HQ).
8. **Terminal** — target chips: Repo, each worker, Any folder.
9. **Settings** — Team (hiring policy Manual / Ask me / Auto with trigger, max temps, idle
   timeout, temp runtime; crew cards with role, runtime, **Cage vs Floor** = sandbox vs local, TEMP badge + Keep on team), Workflow (QC
   inspectors incl. Peer agent, who reviews, review rounds, approvals, line rules, deploy), Stack (skill store), MCP (servers × workers grants; e.g. GitHub, Notion, Postgres, **ELK / Kibana read-only** for log evidence), **Sandbox (Run mode: Cages / Subagents in one cage / Subagents with no sandbox; host shown as Linux / macOS / Windows with the terminal type; engine picker: Auto /
   Docker / Podman / Podman + krun / Docker Sandboxes, with live detect status and a
   "Test engine" button; firewall policy; allowlist; secrets)**, Boards, **Lines (repos in this
   factory: order, base branch, test command, docs folder, log source + index patterns + base KQL with Test query, workers per line, shared badge, add from depot; plus a Factory docs list)**,
   Project.
10. **Debug** — WebSocket status, UI language, snapshot rev, host (OS, shell, WSL2), engine + version, run mode, preflight state, per-agent cage id / tmux / pid /
    state, live event stream.

Every screen except the floor opens as a drawer or modal over the dimmed factory scene.
Accessible as drawn: real buttons and links, labels on inputs, 4.5:1 text contrast,
`prefers-reduced-motion` turns off animation.

### Language: TH / EN

- The switch lives in **Settings → Project → Language**: "Screen language" TH / EN segmented
  button, "Agent language" select, and a preview of sample messages. No switch in the top menu
  bar. One click swaps the whole UI with no reload; the choice is
  saved per user in `~/.agent-works/config.json` (`"lang": "th" | "en"`), not per factory.
- First run: pick the language from the OS locale (`Intl.DateTimeFormat().resolvedOptions().locale`
  / `LANG`), `th*` → TH, everything else → EN. CLI flag `--lang th|en`; `agent-works doctor` follows it.
- Use an i18n library (e.g. `i18next` + `react-i18next`) with `src/locales/en.json` and
  `src/locales/th.json`, keys by screen (`floor.hud.lineSpeed`, `preflight.summary.blocking`,
  `mergeBrief.section.rootCause`, …). No string is hard-coded in components; a CI check fails on a
  key missing from either file. Plurals and numbers through the library (`{{count}} boxes`).
- **Keep technical terms in English** inside Thai text, as Thai developers say them: PR / MR, merge,
  branch, commit, worktree, sandbox, cage, firewall, worker, subagent, Action items, QC, HOTFIX,
  run mode, token, MCP, log, KQL, preflight. Thai example: "รอคุณ merge PR #14",
  "Nova ขอเปิด api.stripe.com ใน sandbox", "เหลือ 3 ข้อที่ต้องแก้ก่อนเริ่ม".
  Status stamps and pixel labels on the floor stay English in both languages (SHIPPED, READY,
  BLOCKED, ASKS YOU, CAGE 1, L1…) so the art never changes size.
- Fonts: the pixel fonts have no Thai glyphs, so Thai text uses a Thai-capable fallback
  (e.g. `"Pixelify Sans", "Sarabun", "Noto Sans Thai", sans-serif`); buttons and chips must fit
  Thai text (Thai is often longer and taller: allow wrapping, no fixed-width labels, line-height ≥ 1.4).
- Dates and times follow the language (`th-TH` shows Buddhist-era years only where the user
  chooses it in Settings → Project; default Gregorian), numbers stay Arabic digits.
- **What is not translated:** code, terminal output, commands, file paths, log lines, git messages,
  PR/MR titles and bodies, and work orders written by agents. Agents write in the factory's
  **agent language** (Settings → Project: English default, or Thai), separate from the UI language,
  so PRs stay readable by the whole team. The merge brief can be shown in the UI language
  (Captain writes it in both when the UI is TH and the agent language is EN).

## 8. Stack-aware skills

The skill store offers: Next.js, Go, Kafka, IBM MQ, Oracle, Clerk, Supabase, Stripe, Tailwind,
Prisma (make the list data-driven). Stocking a skill copies its instruction files into each
worker's `.claude/skills/` / `AGENTS.md` and adds its docs domains to the Balanced allowlist.

## 9. Build order

1. `docs/architecture.md`: process model, agent state machine, snapshot schema, event flow,
   SandboxDriver contract and the firewall design.
2. CLI + server + `--demo` mode with mock data, so the UI can be built without agents.
   Build the factory/repo registry and the many-to-many model from day one, even if the first
   demo factory has a single line.
3. Host detection + preflight check framework + `agent-works doctor`, then the container driver
   for **Docker and Podman** + engine detection + Safety check and Preflight screens.
   Integration tests that run the same suite against `docker` and `podman`
   (GitHub Actions `ubuntu-latest` has both); skip `podman-krun` when `/dev/kvm` is missing.
4. Egress proxy + allowlist + deny → Action items.
5. One worker in a cage with its worktree, terminal streamed to the UI.
6. GitHost drivers (GitHub + GitLab, same contract tests against both), lead planning loop,
   work orders, PR/MR creation, peer review loop, follow-up watcher per repo routed by branch
   prefix, then shipments across lines.
7. `sbx` driver, then the two subagent modes (hooks → HQ events), then Windows: CI matrix
   `ubuntu-latest`, `macos-latest`, `windows-latest` (Docker on Windows runners; mark krun and
   Podman jobs as Linux-only where runners lack them).
8. Docs library + indexing + mounts, then machine budget / quotas / focus / global inbox.
9. Factory floor pixel scene (one belt per line), Industrial park, Repo depot, Inbox, Blueprint room, then the other screens, then README with quick start and a
   troubleshooting table per engine.

Work in small commits. Ask me before choosing anything hard to change later (proxy
implementation, message protocol between agents, state storage).
