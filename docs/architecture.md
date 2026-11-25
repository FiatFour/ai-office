# Architecture

This page says how Agent Works fits together today. It describes code that exists. Each section names the files it comes from. Decisions and their reasons live in `docs/decisions/`. The reducer has its own page, `docs/lifecycle.md`. The threat model is `docs/threat-model.md`.

## Process model

One HQ process owns everything that decides. It is `startHq` in `server/hq.ts`, started by `bin/agent-works.ts` and `server/cli.ts`.

- HQ listens on `127.0.0.1` only. It serves the floor assets, a JSON API and one WebSocket at `/api/ws`. Every HTTP request is refused with 403 unless its Host is a loopback name with HQ's port and any Origin matches it. A WebSocket upgrade that fails the same check, or asks for another path, gets no reply. HQ calls `socket.destroy()`.
- HQ keeps the reducer state, the event log and the command outbox in one SQLite file, `state/hq.db` in the HQ home (ADR 0002). The registry is two small JSON files beside it, `repos.json` and `factories.json`. A second HQ on the same directory is refused with `StoreLockedError`. There is no second store for events or reducer state.
- Workers do not run in HQ. Each worker runs in its own container (a cage) on docker or podman, started through `SandboxDriver` in `server/sandbox/container.ts`.
- One proxy container per HQ carries all cage traffic out. See the firewall section.
- HQ reaches the git host through `gh api` and `glab api`, so it never reads a token (ADR 0004). A guard refuses every write that is not on its list. No merge is on the list.
- A run mode plugs into HQ through `ModeFactory` in `server/modes/cages.ts`. The modes are `cages` and `demo` (`server/modes/demo.ts`). A mode supplies the command executors, the Action items and the `mode` part of the snapshot. `--demo` starts HQ read-only: every non-GET request gets 403 (ADR 0005).
- The floor is a browser page built from `src/floor/`. It holds no state of its own. It draws the last snapshot it received.

```
browser floor  <--- WebSocket /api/ws (GET /api/demo in demo mode) --- HQ (node) --- SQLite state/hq.db
                                                              |  \
                                       docker or podman <-----+   `--- gh api / glab api --> git host
                                              |
                          cage per worker --internal net--> proxy --egress net--> allowlisted hosts
```

## Agent state machine

The reducer keeps no per-worker record. A worker is a host login in `state.staff`. The state that moves is the box, one per task. What the floor shows for a worker is derived from the boxes. HQ does hold a little worker-keyed state outside the reducer, and none of it is in `state/hq.db`:

- `BlockedLog` keeps a `held` set and the recent attempt times per worker (`server/blocked.ts`). The held set is `snapshot.paused`.
- Each worker has a home directory on disk, `homes/<homeName>` in the HQ home. `homeName` is a slug of the worker name plus a hash of it (`server/sandbox/container.ts`). `SandboxDriver.startCage` creates it and it stays after the cage is released (`server/sandbox/container.ts`).
- The cage shell of an agent job caches one cage per worker and task, in memory (`server/agents/cage-shell.ts`).

A restart loses the held set, the times and the cage cache. The home directories stay.

### Box stations

The reducer in `packages/core/src/lifecycle.ts` gives each box one station. The set is `STATIONS`:

| Station | Extra fields on the box |
| --- | --- |
| `belt` | none |
| `building` | none |
| `test` | `pr` |
| `qc` | `pr`, `reviewer`, `changesRequested` |
| `merge` | `pr` |
| `shipping` | `pr` |
| `shipped` | `pr` |
| `cancelled` | `reason` (`human` or `closed`) |

Every box also has the fields of `BoxBase` and `state`, listed in the `Box` table below. The reducer derives the station from the facts it holds after each event. It never moves a box because of the event that arrived. A box that is `shipping` or `shipped` is latched. HQ has no command that merges. The rules are in `docs/lifecycle.md`.

### Worker mood

`moodOf` in `src/floor/model.ts` picks one of `MOODS` for each worker, in this order:

1. `needs`: an Action item has this worker as its worker. An owner of a box is any login in `builders` plus the current `worker`, and the floor gives an item to the first owner of the item's task (`actionsOf`). A `website` item has no task, so it never makes a worker `needs`. The floor also makes two items of its own. It adds a `ready_to_merge` item for every box at `merge`, whether or not the server sent one, and a `closed_unmerged` item for a box cancelled with reason `closed`. The server has no `closed_unmerged` kind.
2. `qc`: the worker is the `reviewer` of a box at `qc`.
3. `working`: the worker is the box's current `worker` (not just a past builder) and the box is at `building`, `test` or `qc`.
4. `break`: none of the above.

### Cage

A cage is a container the driver starts for one task and worker.

| Step | Trigger | Code |
| --- | --- | --- |
| started | `POST /api/cages`, or the cage shell an agent job uses (`server/agents/cage-shell.ts`) | `SandboxDriver.startCage` |
| running | listed in `snapshot.cages`; jobs run through `exec` | `SandboxDriver.exec`, `list` |
| released | `DELETE /api/cages/<id>`. The cages mode runs the `release_cage` command as a no-op today | `SandboxDriver.releaseCage` |
| swept | HQ stop and the CLI cleanup | `SandboxDriver.removeAll` |

### Pause

`BlockedLog` in `server/blocked.ts` can hold a worker. The third identical attempt inside 10 minutes pauses it (`REPEAT_LIMIT`, `REPEAT_WINDOW_MS`). The worker name is in `snapshot.paused` until `POST /api/workers/resume` clears it and wakes the mode. A denial of a well-formed host that is only missing from the allowlist does not count toward a pause. The cages mode keeps one `website` Action item per site. A site that is already allowed gives none. `allow` starts `true` and turns `false` for good once any denial of that site has another reason or a malformed host (`server/modes/cages.ts`).

## Snapshot schema

HQ builds one `Snapshot` (`server/snapshot.ts`) and sends it as JSON on every change, over `/api/ws` and at `GET /api/snapshot`. The floor and the dashboard read the snapshot from `/api/ws` only. The floor also asks `GET /api/demo` to learn whether HQ runs in demo mode (`src/floor/useHq.ts`). A test, `server/test/architecture-doc.test.ts`, reads the TypeScript source and fails when a field below does not exist, or when a field in the source is missing here. Each table lists the fields of one type. A type that the snapshot reaches and that has fields needs a table here, or a row in `docs/lifecycle.md`. A dotted name is a field of an inline object.

### Snapshot

Source: `server/snapshot.ts`.

| Field | Meaning |
| --- | --- |
| `rev` | The ledger revision. Rises with every accepted event or command result, with each registry change and when a cage starts or is released. |
| `pushedAt` | Milliseconds since the epoch when HQ built this snapshot. |
| `hq` | Facts about the HQ process. |
| `hq.pid` | Process id. |
| `hq.startedAt` | Start time in milliseconds. |
| `hq.port` | The port HQ is bound to. |
| `hq.version` | HQ version string. |
| `registry` | The factories and repos HQ knows. |
| `state` | The reducer `State`. |
| `outbox` | A summary of the command outbox. |
| `outbox.pending` | Count of commands not yet done. |
| `outbox.failed` | The failed `OutboxEntry` items. |
| `cages` | Running cages, as `CageView`. |
| `denials` | Proxy denials, as `Denial`. |
| `blocked` | Recent blocked attempts, as `BlockedEntry`. |
| `paused` | Names of paused workers. |
| `actions` | Things that need a person, as `ActionItem`. Derived, never stored. |
| `mode` | The run mode view, as `ModeView`, or `null`. |

### State

Source: `packages/core/src/lifecycle.ts`. Plain JSON. Shapes are in `docs/lifecycle.md`.

| Field | Meaning |
| --- | --- |
| `config` | The `Config`. |
| `seq` | The next order number. Only an accepted `order` event raises it, and each new box takes the value as its `seq`. It is not a count of events and not the cursor of `GET /api/events?after=`. That cursor is the `seq` column of the `events` table, which the store assigns to every event. |
| `staff` | Logins that may be hired or draw reviews. `add_worker` and `hire` both add to it. |
| `boxes` | One box per task. |
| `changes` | PRs or MRs, keyed by `repo#number@branch`. |
| `checks` | Check results, keyed by `repo\|head sha`, then by check name. |
| `reviews` | Review verdicts, keyed by `repo#number\|head sha`, then by reviewer login. |
| `shipments` | Groups of boxes that ship together. |

### Config

Source: `packages/core/src/lifecycle.ts`.

| Field | Meaning |
| --- | --- |
| `budget` | The most boxes that may be running at once. |
| `approvals` | Approving reviews a change needs before its box reaches `merge`. |

### Box

Source: `packages/core/src/lifecycle.ts`. The union of the fields of every station, with the fields of `BoxBase`. The stations table is under the state machine section.

| Field | Meaning |
| --- | --- |
| `id` | Task id. |
| `shipment` | Shipment id. |
| `seq` | Order number. |
| `worker` | Login of the current session, or `null`. |
| `builders` | Every login ever hired for the box. |
| `cancelled` | True once a human cancelled the box. |
| `state` | The station. |
| `pr` | The change key, from `test` on. |
| `reviewer` | Assigned reviewer, at `qc`. |
| `changesRequested` | Whether a review asked for changes, at `qc`. |
| `reason` | Why a box is `cancelled`. |

### Stamped

Source: `packages/core/src/lifecycle.ts`. The shape of each value in `state.checks` and `state.reviews`.

| Field | Meaning |
| --- | --- |
| `v` | The value. |
| `at` | Host time of the event that set it. |

### RegistryView

Source: `server/registry.ts`.

| Field | Meaning |
| --- | --- |
| `factories` | The `Factory` list. |
| `repos` | The `RepoEntry` list. |

### Factory

Source: `server/registry.ts`.

| Field | Meaning |
| --- | --- |
| `id` | Factory id. |
| `name` | Display name. |
| `root` | Root path of the factory. |
| `repos` | Ids of the repos it uses. |

### RepoEntry

Source: `server/registry.ts`.

| Field | Meaning |
| --- | --- |
| `id` | Repo id, built from the remote by `repoIdFrom`. |
| `remote` | Remote URL, or `null` for a local repo. |
| `path` | Local clone path. |

### CageView

Source: `server/sandbox/container.ts`.

| Field | Meaning |
| --- | --- |
| `id` | Cage id, the task slug plus a random suffix. |
| `task` | Task id. |
| `worker` | Worker login. |
| `container` | Container name, `aw-<hq>-cage-<id>`. |
| `workdir` | Host path of the exported repo mounted at `/work`. |
| `engine` | `docker` or `podman`. |
| `startedAt` | Start time in milliseconds. |

### Denial

Source: `server/snapshot.ts`. Distinct from the raw proxy denial in `server/sandbox/firewall.ts`.

| Field | Meaning |
| --- | --- |
| `host` | Host the cage tried to reach. |
| `port` | Port. |
| `agent` | Worker the proxy saw. |
| `at` | Time of the denial, as the proxy wrote it. The raw denial's own field, copied through. |
| `reason` | Why the proxy refused. |
| `count` | How many times this key was denied. |
| `lastAt` | Time of the last denial. The same value as `at`. |

### BlockedEntry

Source: `server/blocked.ts`. It extends `Attempt`, so the `Attempt` fields are listed here too.

| Field | Meaning |
| --- | --- |
| `worker` | Worker that tried. |
| `task` | Task id, or `null`. |
| `tool` | Tool call, for example `CONNECT host:port`. |
| `detail` | What was refused. |
| `layer` | Layer code from the threat model, such as `F2`. |
| `run` | Run label, `hq` by default. |
| `at` | Time in milliseconds. |
| `seq` | Position in the log. |
| `repeats` | Identical attempts in the window. |

### OutboxEntry

Source: `server/store/store.ts`.

| Field | Meaning |
| --- | --- |
| `id` | `<epoch>.<seq>.<index>`. |
| `command` | The reducer `Command`. |
| `status` | `pending`, `done`, `failed` or `skipped`. |
| `attempts` | Tries so far. A command stops after three. |
| `error` | Last error text, or `null`. |

### ModeView

Source: `server/modes/cages.ts`.

| Field | Meaning |
| --- | --- |
| `rounds` | Fix rounds per task. |
| `usage` | A list per task with one entry for each agent job that ran for it, as `Usage` or `null`. The author job, each fix and each review add one. |
| `jobs` | Keys of the jobs running now. |
| `reviewGap` | Text that says why a review is missing, or `null`. |

### Usage

Source: `server/agents/runtime.ts`.

| Field | Meaning |
| --- | --- |
| `inputTokens` | Input tokens. |
| `outputTokens` | Output tokens. |
| `cacheReadTokens` | Cache read tokens. |
| `cacheCreationTokens` | Cache creation tokens. |
| `webRequests` | Web requests made. |

### ActionItem

Source: `server/modes/cages.ts`. A union tagged by `kind`. The kinds are `ready_to_merge`, `round_limit`, `website`, `alert` and `job_failed`. The fields below are the union of all kinds, except `kind`.

| Field | Used by |
| --- | --- |
| `task` | `ready_to_merge`, `round_limit`, `job_failed` |
| `url` | `ready_to_merge`, `round_limit` |
| `brief` | `ready_to_merge`, the first lines of the merge brief |
| `fixRounds` | `round_limit` |
| `site` | `website`, the rule `host` or `host:port`. For a malformed host it is the quoted text `JSON.stringify("host:port")`, quotes included |
| `host` | `website` |
| `port` | `website` |
| `agent` | `website` |
| `count` | `website` |
| `allow` | `website`, true while every denial of the site was a well-formed host only missing from the allowlist. One other reason makes it false for good |
| `reason` | `alert` |
| `subject` | `alert` |
| `job` | `job_failed` |
| `error` | `job_failed` |

## Event flow

An event is one fact or one human order. The path is the same for every source.

1. A source produces an event. The sources are `human` (the CLI and dashboard, `POST /api/events`), `hook`, `webhook` and `poll` (the git host adapters). `--demo` feeds recorded events through `HqPort.ingest`.
2. `parseEvent` in `server/events.ts` checks the shape and throws `InvalidEvent`.
3. `Ledger.ingest` in `server/ledger.ts` runs `reduce(state, event)` from `@agent-works/core`. It gets the next state and a list of commands.
4. `Store` in `server/store/store.ts` writes the event row and the state row in one `BEGIN IMMEDIATE` transaction. The commands go into the outbox inside the state row. HQ acknowledges only after the commit. A failed reduce rolls both back.
5. The events live in the SQLite `events` table, one row per event with a sequence number and a checksum. They are served by `GET /api/events?after=<seq>` as `{ events: [{ seq, event }] }`. They are not stored as a file.
6. `drain` in `server/hq.ts` runs each runnable outbox entry through the executor the mode registered for that command kind. It marks the entry `done`, `failed` or `skipped`. An entry is tried at most three times (`MAX_ATTEMPTS` in `server/ledger.ts`). Delivery is at least once, so executors must be safe to repeat (ADR 0004).
7. HQ pushes a fresh snapshot to every open WebSocket. For `POST /api/events` it pushes right after the commit and before `drain` starts, and again after each executor finishes.

A command is a trigger. The mode computes the job from the current state, and each job checks the host before it writes (ADR 0004). A restart does not replay events, because the state row and the log cannot disagree after a commit.

### The export file

`events.jsonl` is not HQ's record. It is an export. `node server/modes/events-export.ts <hq-url> <file>` calls `GET /api/events?after=` and writes one `{"seq", "event"}` JSON line per event. Lines 1 to 14 of `fixtures/demo/events.jsonl` are such an export of the P1-2 run. Lines 15 and 16 were written by hand (`fixtures/demo/README.md` says why). `--demo` reads that file with `loadDemo` and replays it through the same parser, reducer and ledger as a live event (ADR 0005).

## SandboxDriver contract

`SandboxDriver` in `server/sandbox/container.ts` is the only code that starts or stops a cage. It takes an `Engine` (docker or podman, `server/sandbox/engine.ts`). The test interface is `SandboxLike` in `test/contract/sandbox.contract.ts`.

| Method | Contract |
| --- | --- |
| `startCage({ task, worker, source })` | Refuses a source inside a cage or a worker home. Needs the cage image and names the build command if it is missing. Exports the repo without running its filters on the host, scans it in a throwaway container and refuses on any issue. Raises the firewall, then starts a hardened container on the internal network only. Returns a `CageView`. A failure removes the cage files and leaves `homes/<homeName>`, the worker's home, in place. |
| `exec(id, argv, options)` | Runs `argv` in the cage at `/work`. Throws `CageError` if no such cage runs. |
| `allow(rule)` | Adds one host rule to the allowlist file. Refuses anything that is not a single host rule. |
| `releaseCage(id)` | Removes the container. Returns false for an unknown id, so it is idempotent. |
| `removeAll()` | Stops the firewall and removes every container and network that carries this HQ's labels. Returns `{ containers, networks }`. `containers` is the count found before the sweep. `networks` is the count still listed after `lowerFirewall`, so it is 0 on success. |
| `leftovers()` | Lists the containers and networks still labelled for this HQ. |
| `list()` | The running `CageView` list. |
| `throwaway(args, mounts)` | Runs one command in a container with no network, hardened, 256 processes, 2 GB. |

Every container gets the labels `agent-works.project`, `agent-works.hq` and `agent-works.role`. Cleanup (`removeAll`, `leftovers`) finds containers by those labels. `releaseCage` is the exception. It removes one cage by its container name.

The contract has 15 cases in `test/contract/sandbox.contract.ts`. They run against real docker, real rootless podman (CI) and an in-memory fake. `docs/contract-tests.md` has the commands and the table of what does not run.

## Firewall

Spec section 4 names the rules F1 to F5. The codes are in `docs/threat-model.md`. The proxy choice is ADR 0001.

- **Networks.** `raiseFirewall` in `server/sandbox/firewall.ts` creates an `--internal` network and an egress network per HQ. On docker the internal network also sets `inhibit_ipv4`, so there is no host gateway. Cages join only the internal network (F1, F3).
- **Proxy.** One container runs the Node CONNECT proxy from `server/sandbox/proxy/`. It joins both networks. Cages get `HTTPS_PROXY` and `HTTP_PROXY` that point at it, with the worker name as the proxy user so a denial names the worker.
- **Rules.** The proxy allows `CONNECT host:port` only for hosts in the allowlist file and answers 403 otherwise (F2). It resolves once, refuses non-public addresses and dials the address it checked (F2a). It reads the ClientHello and closes the tunnel unless the SNI equals the CONNECT host (F2s). It reads the allowlist file on every request. `DEFAULT_ALLOWLIST` is `api.anthropic.com`, `github.com`, `api.github.com` and `registry.npmjs.org`.
- **Denials.** The proxy logs one JSON line per denial, `{deny: event}`, with no cap. The cap of 20 a second (F4r) applies only to the POST to a `denyUrl`, and `raiseFirewall` never sets one. HQ follows the log: `engine.follow` feeds each line to `parseDenialLine`, which gives a raw denial. So the path HQ uses is uncapped, and F4r speaks of a path HQ does not use. That gap is issue #44. Caveat: `docs/threat-model.md` still says in F4 that every denied request is POSTed to `/api/sandbox/deny`, and in F4r that the proxy posts at most 20 a second. HQ has no such route and reads the log instead. Both rows are false until issue #44 is settled. `noteDenial` in `server/hq.ts` does three things for each line. It tells the mode, which may raise a `website` Action item. It records a blocked attempt with layer `F2`. It updates the `denials` map.
- **Bounds.** Some of what HQ holds is capped. Snapshot pushes for denials are throttled to one per 250 ms. The `denials` map in `server/hq.ts` holds at most 50 keys, and the oldest goes first. `BlockedLog` keeps at most 500 entries. Two maps are not capped, and each grows with every distinct host a cage tries. The cages mode keeps its own `denials` map, one entry per site, and never evicts. Its `actions()` returns every entry, so the snapshot and every push grow with it. `BlockedLog.times` keeps one list per attempt key (worker, layer, tool, detail) and drops keys only when `resume` runs for that worker. Memory is therefore not bounded under a flood of distinct hosts. Issue #27 tracks these two maps and issue #44 has the correction.
- **Pause.** `BlockedLog` pauses a worker on the third identical attempt in 10 minutes and keeps at most 500 entries. See the state machine section.
- **Allow.** A person approves a `website` item with `POST /api/actions/allow`. That calls `SandboxDriver.allow`. The worker's own retry then passes. Only a single host rule is accepted.
- **Cage flags.** `hardenedArgs` drops all capabilities, sets `no-new-privileges`, makes the root read-only and gives a 256 MB `/tmp`. A cage has a 1024 process limit and 4 GB of memory. No cage is privileged, mounts the docker socket or mounts a named volume (CG).
- **Fail closed.** If the proxy dies, a cage has no route out. A failed firewall start tears down what it built.
