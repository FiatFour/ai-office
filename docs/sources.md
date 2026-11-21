# Sources

This page lists every outside fact the Agent Works design depends on. Each row links the primary page that states the fact, the version of the tool or document checked, and the date it was checked. Phase 0 spikes cite rows by id, and a spike that disproves a row updates it in the same PR.

`node scripts/check-sources.mjs` fails when a row has no link, no checked version, no valid check date, or a plan PR id that is not a heading in `docs/plans/agent-works-plan.md`, or when a spike from P0-2 to P0-5 has no row. It also fails on a duplicate id, a row with the wrong number of cells, a table header it does not know, a table row outside a table, and a page with no source table. `pnpm test` runs it.

Versions come from the page itself when it states one. When it does not, the version is the latest release of the tool on the check date, read from npm or the project's release list.

## Claude Code

| Id | Area | Fact | Link | Version checked | Date checked | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | Claude Code hooks | The hook events include `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop` and `Stop`. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-7 |
| S-02 | Claude Code hooks | An `http` hook sends the event JSON as a POST body with `Content-Type: application/json` to its URL, so hooks can report straight to HQ. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-03 | Claude Code hooks | A `PreToolUse` hook blocks a call by exiting 2 or by returning `permissionDecision: "deny"`. Exit 2 wins even over an `"allow"` decision. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-04 | Claude Code hooks | By default a failed hook does not block. A non-2xx response, a connection failure and a timeout of an `http` hook are non-blocking errors, and the tool call goes ahead. `onFailure: "block"` (v2.1.295 or later) makes the failure block. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-6 |
| S-05 | Claude Code hooks | A `PermissionRequest` hook answers a permission prompt with `hookSpecificOutput.decision.behavior` set to `allow` or `deny`. Exit code 2 is not honored for this event. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-06 | Claude Code hooks | Hook input carries `agent_id` and `agent_type` when the hook fires inside a subagent, so HQ can tell workers apart. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-7 |
| S-07 | Claude Code hooks | Managed settings can set `allowManagedHooksOnly`, which blocks user, project, local and plugin hooks. | [Hooks reference](https://code.claude.com/docs/en/hooks) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-6 |
| S-08 | Claude Code permissions | Rules are evaluated deny, then ask, then allow. The first match wins, and an allow rule cannot carve an exception out of a deny rule. | [Configure permissions](https://code.claude.com/docs/en/permissions) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-09 | Claude Code permissions | Read and Edit rules use gitignore patterns. `~/path` anchors at home, `//path` at the filesystem root, and a bare name such as `.env` matches at any depth, so `Read(.env)` equals `Read(**/.env)`. | [Configure permissions](https://code.claude.com/docs/en/permissions) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-10 | Claude Code permissions | Read and Edit deny rules also cover Bash file commands Claude Code recognizes (`cat`, `head`, `tail`, `sed`, `tee`) and redirection targets. They do not cover `grep -r pattern .` or a script that opens files itself. | [Configure permissions](https://code.claude.com/docs/en/permissions) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-6 |
| S-11 | Claude Code permissions | A PreToolUse hook's `allow` does not bypass deny or ask rules. A hook that exits 2 blocks before rules are evaluated. | [Configure permissions](https://code.claude.com/docs/en/permissions) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-12 | Claude Code permissions | `permissions.disableBypassPermissionsMode: "disable"` prevents `bypassPermissions` mode. It is most useful in managed settings, where it cannot be overridden. | [Configure permissions](https://code.claude.com/docs/en/permissions) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-6 |
| S-13 | Claude Code settings | Precedence, highest first, is managed settings, `--settings` on the command line, `.claude/settings.local.json`, `.claude/settings.json`, then `~/.claude/settings.json`. | [Settings files and precedence](https://code.claude.com/docs/en/settings) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-14 | Claude Code settings | List keys such as `permissions.deny` merge across files instead of replacing each other. | [Settings files and precedence](https://code.claude.com/docs/en/settings) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-15 | Claude Code settings | `CLAUDE_CONFIG_DIR` moves the home-directory files, so Claude Code stores settings, session history and plugins there instead of `~/.claude`. | [Settings files and precedence](https://code.claude.com/docs/en/settings) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-16 | Claude Code settings | The managed settings file is `/etc/claude-code/managed-settings.json` on Linux and WSL, `/Library/Application Support/ClaudeCode/` on macOS and `C:\Program Files\ClaudeCode\` on Windows. A `managed-settings.d/` drop-in directory sits next to it. On WSL, `/etc/claude-code` is user-writable. | [Deploy managed settings](https://code.claude.com/docs/en/managed-settings) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-6 |
| S-17 | Claude Code subagents | Project subagents are Markdown files with YAML frontmatter in `.claude/agents/`. Only `name` and `description` are required. `tools`, `model`, `permissionMode` and `hooks` are optional. | [Subagents](https://code.claude.com/docs/en/sub-agents) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-18 | Claude Code subagents | By default a subagent can spawn its own subagents, up to three layers below the main conversation. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` changes the limit. | [Subagents](https://code.claude.com/docs/en/sub-agents) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P0-7 |
| S-19 | Claude Code headless | `claude -p --output-format stream-json --verbose` prints newline-delimited JSON events. The first event is `system/init` unless startup hook events precede it, and the last is a `result` message with cost and session metadata. Subagent messages carry `parent_tool_use_id`. | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3, P1-2 |
| S-20 | Claude Code headless | `--bare` skips hooks, including hooks passed with `--settings`. A run that needs hooks must not use bare mode. | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |
| S-21 | Claude Code headless | In a Manual mode `claude -p` run, a call that needs approval is denied unless a `PermissionRequest` hook or `--permission-prompt-tool` approves it. | [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) | Claude Code 2.1.325 (npm latest) | 2026-11-16 | P0-3 |

## Codex CLI

| Id | Area | Fact | Link | Version checked | Date checked | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| S-22 | Codex config | User config lives in `~/.codex/config.toml`. `sandbox_mode` takes `read-only`, `workspace-write` or `danger-full-access`. | [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) | Codex CLI 0.169.0 (npm latest) | 2026-11-16 | P0-3 |
| S-23 | Codex config | `sandbox_workspace_write.network_access` turns outbound network on or off inside the `workspace-write` sandbox, and `writable_roots` adds writable paths. | [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) | Codex CLI 0.169.0 (npm latest) | 2026-11-16 | P0-3 |
| S-24 | Codex config | Read denial needs a permissions profile. `permissions.<name>.filesystem.<path-or-glob> = "deny"` denies reads, globs such as `**/*.env` work, and `default_permissions` selects the profile. Profiles are beta and are not combined with `sandbox_mode`. | [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) | Codex CLI 0.169.0 (npm latest) | 2026-11-16 | P0-3, P0-6 |
| S-25 | Codex sandbox | On Linux the sandbox uses bubblewrap with `--unshare-user` and seccomp. It needs user namespaces, and when bubblewrap cannot create them Codex shows a startup warning. | [codex-linux-sandbox README](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/linux-sandbox/README.md) | rust-v0.169.0 | 2026-11-16 | P0-3 |

## GitHub

| Id | Area | Fact | Link | Version checked | Date checked | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| S-26 | GitHub REST | `POST /repos/{owner}/{repo}/pulls` opens a PR. `head` and `base` are required, `title` is required unless `issue` is passed, and `draft` is optional. | [REST pulls](https://docs.github.com/en/rest/pulls/pulls) | REST API 2026-03-10 | 2026-11-16 | P0-4 |
| S-27 | GitHub REST | `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` merges a PR. `GET` on the same path returns 204 when merged and 404 when not, so HQ can poll merge state without the merge call. | [REST pulls](https://docs.github.com/en/rest/pulls/pulls) | REST API 2026-03-10 | 2026-11-16 | P0-4, P0-7 |
| S-28 | GitHub REST | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` posts a review with `event` `APPROVE`, `REQUEST_CHANGES` or `COMMENT`. Each comment needs `path` and `body` and takes `line` and `side`. `position` counts lines in the diff, not in the file. | [REST pull reviews](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) | REST API 2026-03-10 | 2026-11-16 | P0-4 |
| S-29 | GitHub REST | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` lists check runs for a ref. Classic tokens need the `repo` scope for a private repo. | [REST check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference) | REST API 2026-03-10 | 2026-11-16 | P0-4 |
| S-30 | GitHub REST | An authenticated user gets 5,000 requests per hour. `GITHUB_TOKEN` in Actions gets 1,000 per repository per hour. Secondary limits allow 100 concurrent requests, 900 REST points per minute, and about 80 content-creating requests per minute and 500 per hour. | [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) | REST API 2026-03-10 | 2026-11-16 | P0-4, P2-1 |
| S-31 | GitHub webhooks | Deliveries carry `X-GitHub-Event`, `X-GitHub-Delivery`, and `X-Hub-Signature-256`, an HMAC-SHA256 of the body sent only when a secret is set. | [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) | GitHub docs, checked live | 2026-11-16 | P0-4 |
| S-32 | GitHub webhooks | A `pull_request` event with action `closed` and `merged: true` means the PR merged. `pull_request_review` actions are `submitted`, `edited` and `dismissed`. `check_suite` and `check_run` report CI state. | [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) | GitHub docs, checked live | 2026-11-16 | P0-4, P0-7 |

## GitLab

| Id | Area | Fact | Link | Version checked | Date checked | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| S-33 | GitLab REST v4 | `POST /projects/:id/merge_requests` opens an MR with source branch, target branch and title. `PUT /projects/:id/merge_requests/:merge_request_iid/merge` merges it. MR `state` is `opened`, `closed`, `merged` or `locked`. | [Merge requests API](https://docs.gitlab.com/api/merge_requests/) | GitLab docs, history up to 19.5 | 2026-11-16 | P0-4, P0-7 |
| S-34 | GitLab REST v4 | `GET /projects/:id/merge_requests/:merge_request_iid/pipelines` lists the pipelines of an MR. | [Merge requests API](https://docs.gitlab.com/api/merge_requests/) | GitLab docs, history up to 19.5 | 2026-11-16 | P0-4 |
| S-35 | GitLab REST v4 | A line comment is a discussion created with `POST /projects/:id/merge_requests/:merge_request_iid/discussions` and a `position` that needs `base_sha`, `start_sha`, `head_sha`, `position_type`, the paths and `new_line` or `old_line`. The SHAs come from the latest entry of the MR `versions` endpoint. | [Discussions API](https://docs.gitlab.com/api/discussions/) | GitLab docs, checked live | 2026-11-16 | P0-4 |
| S-36 | GitLab webhooks | `X-Gitlab-Event` is `Merge Request Hook`, `Push Hook`, `Pipeline Hook` or `Note Hook` for MR comments. MR `object_attributes.action` includes `open`, `update`, `approved`, `close` and `merge`. | [Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/) | GitLab docs, checked live | 2026-11-16 | P0-4, P0-7 |
| S-37 | GitLab webhooks | The secret token arrives in plain text in `X-Gitlab-Token`. A signing token adds a `webhook-signature` HMAC-SHA256 header. Four failures in a row disable a webhook for a while, and 40 disable it for good. | [Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/) | GitLab docs, checked live | 2026-11-16 | P0-4 |
| S-38 | GitLab REST v4 | On GitLab.com Free, authenticated API traffic is limited to 5,000 requests per hour per user with a burst of 100 per minute. | [GitLab.com rate limits](https://docs.gitlab.com/user/gitlab_com/rate_limits/) | GitLab.com, checked live | 2026-11-16 | P0-4, P2-1 |
| S-39 | GitLab CLI | `glab mr create` takes `--source-branch`, `--target-branch`, `--title` and `--draft`. | [glab mr create](https://docs.gitlab.com/cli/mr/create/) | glab v1.130.0 | 2026-11-16 | P0-4 |

## Docker and Podman

| Id | Area | Fact | Link | Version checked | Date checked | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| S-40 | Docker networks | `docker network create --internal` restricts external access. Containers on it can reach each other but no other network. | [docker network create](https://docs.docker.com/reference/cli/docker/network/create/) | Docker Engine 29.9.3 (moby latest) | 2026-11-16 | P0-2 |
| S-41 | Docker networks | Since Engine 26.0 (CVE-2024-29018), the embedded DNS server does not forward requests to external DNS servers for a container that is only on an internal network. | [Docker Engine 26.0 release notes](https://docs.docker.com/engine/release-notes/26.0/) | Docker Engine 26.0 | 2026-11-16 | P0-2, P0-6 |
| S-42 | Docker networks | For other networks the embedded DNS server at 127.0.0.11 forwards external lookups to the DNS servers configured on the host. | [Networking overview](https://docs.docker.com/engine/network/) | Docker Engine 29.9.3 (moby latest) | 2026-11-16 | P0-2 |
| S-43 | Podman networks | `podman network create --internal` gives bridge containers no default route and turns off IP forwarding on the bridge. aardvark-dns then resolves only container names and answers other queries with `NXDOMAIN`. | [podman-network-create](https://docs.podman.io/en/latest/markdown/podman-network-create.1.html) | Podman v6.2.0 (docs latest) | 2026-11-16 | P0-2, P0-6 |
| S-44 | Podman rootless | `--userns=keep-id` creates a user namespace where the current user's UID and GID map to the same values in the container. | [podman-run](https://docs.podman.io/en/latest/markdown/podman-run.1.html) | Podman v6.2.0 (docs latest) | 2026-11-16 | P0-3, P0-5 |
| S-45 | krun | krun is crun in a mode that runs the container workload in a libkrun KVM microVM. crun still sets up the namespaces and cgroups first. | [krun(1)](https://github.com/containers/crun/blob/1.31/krun.1.md) | crun 1.31 | 2026-11-16 | P0-2, P0-3 |
| S-46 | krun | The default network mode is TSI. libkrun proxies guest sockets in the VMM's network context, with no guest network interface, and listening on guest UDP sockets is not supported. | [krun(1)](https://github.com/containers/crun/blob/1.31/krun.1.md) | crun 1.31 | 2026-11-16 | P0-2 |
| S-47 | krun | `krun.ram_mib` defaults to the OCI memory limit, else 1024 MiB. `krun.cpus` defaults to the CPUs in the process CPU affinity, up to 16. | [krun(1)](https://github.com/containers/crun/blob/1.31/krun.1.md) | crun 1.31 | 2026-11-16 | P0-2, P0-3 |

## Hosts, runners and runtimes

| Id | Area | Fact | Link | Version checked | Date checked | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| S-48 | GitHub runners | This PR's `ubuntu-latest` jobs ran on image `ubuntu-26.04` 20261111.196.1, which is Ubuntu 26.04.1 with Docker 29.4.2, Podman 5.7.0 and PowerShell 7.6.10. | [Ubuntu 26.04 runner image](https://github.com/actions/runner-images/blob/ubuntu26/20261111.196/images/ubuntu/Ubuntu2604-Readme.md) | image 20261111.196.1 | 2026-11-16 | P0-2, P0-3, P2-3 |
| S-49 | GitHub runners | `macos-latest` is macOS 26 on arm64. The image lists no Docker, Podman or Colima. | [runner-images README](https://github.com/actions/runner-images/blob/main/README.md) | macOS 26 arm64 image 20261102.0473.1 | 2026-11-16 | P0-5, P2-3 |
| S-50 | GitHub runners | Nested virtualization is not supported on arm64 macOS runners, because of a limit in Apple's Virtualization Framework. | [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | GitHub docs, checked live | 2026-11-16 | P0-5, P2-3 |
| S-51 | GitHub runners | `windows-latest` is Windows Server 2025 with Docker 29.7.2 and WSL 2. | [Windows 2025 runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-VS2026-Readme.md) | image 20261103.298.1 | 2026-11-16 | P0-5, P2-3 |
| S-52 | GitHub runners | GitHub-hosted Linux runners support hardware acceleration for Android SDK tools. The page does not name KVM. | [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | GitHub docs, checked live | 2026-11-16 | P0-2 |
| S-53 | Node.js | Node.js 20 is end-of-life. Node.js 22, 24 and 26 are LTS, and 26 is the latest LTS. | [Node.js releases](https://nodejs.org/en/about/previous-releases) | Node.js 26 LTS | 2026-11-16 | P0-1, P0-3 |
| S-54 | Terminal | node-pty uses the Windows ConPTY API and needs Windows 10 1809 or later. winpty support is removed. | [node-pty README](https://github.com/microsoft/node-pty/blob/main/README.md) | README on main, release v1.1.0 | 2026-11-16 | P0-5 |
| S-55 | GitHub runners | The `ubuntu-latest` label moves from Ubuntu 24.04 to Ubuntu 26.04 over several weeks from October 19, 2026, with the migration planned to finish by November 19, 2026. Until then a job can land on either image. | [runner-images#14748](https://github.com/actions/runner-images/issues/14748) | issue open on the check date | 2026-11-16 | P0-2, P0-3, P2-3 |
| S-56 | GitHub runners | The Ubuntu 24.04 image is Ubuntu 24.04.5 with Docker 28.0.4, Podman 4.9.3 and PowerShell 7.6.10. | [Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) | image 20261111.370.1 | 2026-11-16 | P0-2, P2-3 |
| S-57 | Terminal | `@lydell/node-pty` repackages node-pty with prebuilt binaries for Linux, macOS and Windows on x64 and arm64 as optional dependencies, with no install script. node-pty 1.1.0 itself has prebuilds only for darwin and win32. | [npm @lydell/node-pty](https://www.npmjs.com/package/@lydell/node-pty) | 1.2.0-beta.18 (npm view), node-pty 1.1.0 tarball | 2026-11-16 | P0-5 |
| S-58 | GitHub runners | Measured: `macos-latest` reports `kern.hv_support: 0` and has no `docker`. `macos-15-intel` reports `kern.hv_support: 1`, and Colima starts a Linux VM with Docker there. | [probe run 43751166025](https://github.com/FiatFour/ai-office/actions/runs/43751166025), [Colima run 43751312726](https://github.com/FiatFour/ai-office/actions/runs/43751312726) | macOS 26.7.2 arm64, macOS 15.7.9 x86_64 | 2026-11-16 | P0-5 |
| S-59 | GitHub runners | Measured: the Docker daemon on `windows-latest` reports `OSType: windows`, so it cannot run Linux images. | [probe run 43751166025](https://github.com/FiatFour/ai-office/actions/runs/43751166025) | Windows Server 2025, Docker 29 | 2026-11-16 | P0-5 |
| S-60 | GitHub runners | Measured: `wsl --install -d Debian` works on `windows-latest`, and the distro runs as WSL 2 on kernel 6.18.54.1-microsoft-standard-WSL2. | [probe run 43751312726](https://github.com/FiatFour/ai-office/actions/runs/43751312726) | Windows Server 2025 image 20261103.298.1 | 2026-11-16 | P0-5 |

## Spec assumptions the sources contradict

Each entry quotes the spec line and the source line. A spike or a G1 decision resolves each one.

### C-1. Node 20 is end-of-life

- Spec, `AGENT_WORKS_PROMPT.md` §4: "Debian slim, Node 20, git, gh, tmux, ripgrep, Claude Code CLI, Codex CLI". Preflight also checks "Node 20+".
- Source, S-53: the Node.js releases page lists "Node.js 20 (Iron)" as end-of-life and Node.js 26 as the latest LTS.
- Effect. The cage image should use a supported LTS. This PR's CI still runs Node 20, as the plan asks, next to `lts/*`. P0-3 picks the image's Node line.

### C-2. krun does not read `--cpus`

- Spec, `AGENT_WORKS_PROMPT.md` §4: "Pass CPU/memory with `--cpus/--memory` (krun reads them)".
- Source, S-47: "`krun.ram_mib` ... If not set, defaults to the OCI memory limit if present, otherwise 1024 MiB." and "`krun.cpus` ... If not set, defaults to the number of CPUs available via the process CPU affinity."
- Effect. `--memory` reaches the microVM. `--cpus` sets a CFS quota, not CPU affinity, so it does not set the vCPU count. P0-2 and P0-3 pass `--annotation krun.cpus=<n>` or `--cpuset-cpus` and record what the VM sees.

### C-3. The CI runners cannot run every terminal lane the plan names

- Plan, P0-5 lane 3: "Run lane 1 on a `macos-latest` runner with Colima or Docker."
- Spec, `AGENT_WORKS_PROMPT.md` §9: "CI matrix `ubuntu-latest`, `macos-latest`, `windows-latest` (Docker on Windows runners; mark krun and Podman jobs as Linux-only where runners lack them)."
- Source, S-49 and S-50: `macos-latest` is arm64 and its image lists no Docker. The runner docs say "Nested-virtualization is not supported due to the limitation of Apple's Virtualization Framework."
- Effect. Colima and Docker Desktop need a VM, so the macOS terminal lane cannot run on `macos-latest`. P0-5 marks it as not runnable there, or the operator names a macOS machine. The Windows image has Docker 29.7.2 and WSL 2 (S-51), but whether it runs Linux containers is not stated, so P0-5 lane 4 records `docker version` OS type first.
- Resolved by P0-5. The `macos-latest` lane stays not runnable (S-58). P0-5 runs the macOS lane on `macos-15-intel` with Colima instead. The Windows daemon is Windows-only (S-59), so the Windows lane points `docker.exe` at a Linux daemon inside WSL 2 (S-60).

### C-4. Hooks that report to HQ fail open by default

- Spec, `AGENT_WORKS_PROMPT.md` §4: "*PreToolUse hook* — blocks Bash / tool calls whose arguments touch a protected path".
- Source, S-04: for an HTTP hook, "Connection failure: non-blocking error", and on `PreToolUse` a timed-out hook "doesn't block the tool call, except for hooks whose failure blocks the action".
- Effect. If HQ is down or slow, an HTTP PreToolUse hook lets the call through. P0-3 sets `onFailure: "block"` on every guard hook, or runs the guard as a local command hook that exits 2, and tests HQ-down as an attack path in P0-6.

### C-5. Codex has no equivalent of Claude Code deny rules in `sandbox_mode`

- Spec, `AGENT_WORKS_PROMPT.md` §4 layer 3: "and the equivalent Codex sandbox config".
- Source, S-22 and S-24: `sandbox_mode` takes only `read-only`, `workspace-write` or `danger-full-access`. Read denial needs a beta permissions profile, "`"deny"` to deny reads for matching paths", which is not combined with `sandbox_mode`. S-25: on Linux the sandbox needs user namespaces through bubblewrap.
- Effect. The Codex layer 3 is a beta permissions profile, not `sandbox_mode`. Inside a cage the bubblewrap sandbox may not start if the engine blocks user namespaces. P0-3 lane 7 records whether the profile denies `.env` inside a docker and a podman cage, and falls back to layer 2 masking when it does not.

### C-6. `ubuntu-latest` is moving to Ubuntu 26.04

- Plan, P2-3 lane 3: "Run the SandboxDriver suite on podman on `ubuntu-latest`." The first version of S-48 on this page said `ubuntu-latest` is Ubuntu 24.04 with Podman 4.9.3.
- Source, S-55: "This change will be rolled out over a period of several weeks beginning October 19, 2026. We plan to complete the migration by November 19, 2026." S-48: every `ubuntu-latest` job of this PR ran on image `ubuntu-26.04` 20261111.196.1, with Docker 29.4.2 and Podman 5.7.0. The runner-images README linked from S-49 still lists `ubuntu-latest` next to Ubuntu 24.04, whose image is S-56.
- Effect. Until the migration ends, one `ubuntu-latest` job can get Podman 4.9.3 and the next Podman 5.7.0. Each Linux lane prints `docker version` and `podman version` first. A lane whose result depends on the version pins `ubuntu-26.04`.

## Spec assumptions the sources narrow

These agree with the spec but limit how far a layer can be trusted.

### N-1. Deny rules alone do not stop `grep -r`

- Spec, `AGENT_WORKS_PROMPT.md` §4 layer 3 lists "Claude Code `permissions.deny` entries (`Read(**/.env)`, `Edit(**/.env)`, `Read(~/.ssh/**)`, …)", and layer 4 adds the hook for "`cat`, `cp`, `grep -r` over it, redirects".
- Source, S-10: deny rules "don't apply to a command that reads files without naming them, such as `grep -r pattern .` run from the directory that holds the file, or to arbitrary subprocesses that read or write files indirectly".
- Effect. This agrees with the spec's layering. It does mean layer 4 is only as good as its parser, since a script that opens `.env` itself passes both layers. In `subagents-local`, which has no layer 2 mask, the threat model in P0-6 must rate this best effort.

## Unverified spec assumptions

These assumptions have no primary source yet. The named spike tests each one directly.

- "krun: it ignores the image `USER`, so the entrypoint must drop to the `agent` user itself." The krun man page at crun 1.31 does not mention it. P0-3 tests it.
- TSI networking under krun (S-46) proxies guest sockets "in the VMM's network context". The man page does not say whether that context is the container's internal network namespace. P0-2 lane 4 tests the bypass under krun.
- The runner's Podman behaves like the Podman docs checked. Those docs are v6.2.0, while `ubuntu-latest` gives Podman 5.7.0 on Ubuntu 26.04 (S-48) or Podman 4.9.3 on Ubuntu 24.04 (S-56) until the migration ends (C-6). P0-2 records `podman version` and the internal-network and DNS behavior the runner's Podman shows.
