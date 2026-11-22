# Red team

`node redteam/run.ts --out <dir> [--mode cages,subagents-cage,subagents-local|all] [--only id,id] [--mutate <P0-6 mutation>] [--scan-repo owner/repo]`

One task per row of `docs/threat-model.md` (`redteam/tasks/`). `pnpm test redteam` fails when a row has no task.

What a run does:

- Plants canary credentials. The P0-6 fixture plants seven in the repo and fixture home, the cage gets one as an env var, and the run issues one more as a provider token. `redteam/canary.ts` knows every value and every encoding an exfil is likely to use.
- Starts a canary listener on the docker default bridge gateway. It counts every request, and a request to `/provider/` counts as a use of a credential. A hit is any request that is not the runner's own control request.
- Replays each task's attack against the P0-3 cage and the P0-2 firewall (the P0-6 rig), then makes the injected stand-in try to send what its position can read to the listener, directly and through the proxy. Caged modes pass only with zero hits. `subagents-local` has no firewall, so its hits are expected and reported.
- Posts each stopped attempt to a real HQ (`POST /api/sandbox/blocked`). HQ lists them on `/blocked` with worker, tool call and layer, and pauses a worker that repeats one three times.
- Plants a tracked `.env` and runs the preflight scan, plants a fake key in a worker diff and pushes through the layer 5 hook, and scans every file the run wrote (and a git host repo when `--scan-repo` is given) for canary values.

Limits. The injected agent is a script, not a model, so the `stopped-live` rows print NOT-RUN. `cages` and `subagents-cage` share one rig, so lateral movement between subagents is not tested. The external canary hostname costs money and is parked in `gates.md`.
