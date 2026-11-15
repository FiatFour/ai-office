# P0-5. Cage terminal in the browser

This spike proves that a browser can drive a cage's tmux session on each host. `term-server.mjs` runs `<engine> exec -it <cage> tmux -u attach-session -t aw` under node-pty, ConPTY on Windows, and relays it over a WebSocket to xterm.js in `index.html`.

## Rerun it

```sh
pnpm install --frozen-lockfile
pnpm test spikes/P0-5
pnpm --dir spikes/P0-5 exec playwright install chromium
node spikes/P0-5/lanes.mjs --label <host> --out /tmp/swarm-P0-5/owner
```

`lanes.mjs` builds the cage image from `Containerfile` (Debian trixie slim with tmux), starts `term-server.mjs`, drives each lane through Playwright, saves `<slug>.png` and `lanes-<label>.txt`, and removes the cage. To view the terminal by hand, run `node spikes/P0-5/term-server.mjs --engine docker` and open `http://127.0.0.1:7681/`.

The CI workflow `.github/workflows/p0-5-terminal.yml` runs the same command on `ubuntu-latest`, `windows-latest` and `macos-15-intel`, and uploads the screenshots as artifacts.

## Wire shape

- Client to server, JSON text frames: `{ type: 'input', data }` and `{ type: 'resize', cols, rows }`. The server drops any other frame.
- Server to client: `{ type: 'output', data }` and `{ type: 'exit', code }`, then close code 4000. The page shows a closed state on 4000 and reconnects on any other close.
- Closing the socket kills the pty. The tmux session lives on in the cage, so a reconnect attaches to the same shell.

## Lanes

| Lane | Host | Result | Evidence |
| --- | --- | --- | --- |
| 1. `echo hi` on Linux | `ubuntu-latest`, Docker | PASS | `linux-echo.png` in CI artifact `p0-5-linux` |
| 2. `echo hi` in WSL2 | this machine, WSL2 kernel 6.18, Docker 29.1.3 | PASS | `wsl2-echo.png` |
| 3. `echo hi` on macOS | `macos-latest` | not run | arm64, `kern.hv_support: 0`, no Docker binary (S-49, S-50, S-58). No VM can start, so no Linux engine can run. |
| 3. `echo hi` on macOS | `macos-15-intel`, Colima | PASS | `macos-intel-echo.png` in CI artifact `p0-5-macos-intel` |
| 4. `echo hi` with `docker.exe` under PowerShell 7 | `windows-latest` | see PR | The runner's own daemon runs Windows containers only (S-59). The lane points `docker.exe` at a Linux daemon in WSL 2 Debian (S-60) and mounts with `--mount-style wsl`. |
| 5. Resize | WSL2, Linux, macOS Intel | PASS | `tput cols` went 139 to 82 and matched xterm's cols |
| 6. Drop and reconnect | WSL2, Linux, macOS Intel | PASS | Same shell PID, marker still in tmux scrollback and in the viewer |
| 7. Two tabs | WSL2, Linux, macOS Intel | PASS | Both tabs show the line typed in one |
| 8. Thai | WSL2, Linux, macOS Intel | PASS | `สวัสดีครับ ภาษาไทย` comes back as the same 18 code points, `thai.png` |
| 9. Ctrl-C on `sleep 100` | WSL2, Linux, macOS Intel | PASS | Prompt back in 119 to 153 ms |
| 10. Stop the cage | WSL2, Linux, macOS Intel | PASS | Page shows "closed, terminal exited with code 137". No `exec -it aw-p0-5` process is left on the host. |

A `mount` lane also checks that the read-only bind mount shows `/work/Containerfile` in the cage, so the path conversion runs live as well as in `argv.test.ts`.

## Perf

Metric: time from the browser `keydown` event to the xterm render that shows the echoed character, 200 keys, one at a time. The probe also records the time to the parsed echo, before paint. Trunk has no terminal, so there is no baseline.

| Host | Key to render p50 / p95 / max | Key to parsed echo p50 / p95 | Budget |
| --- | --- | --- | --- |
| WSL2, this machine | 15.7 / 16.1 / 32.9 ms | 1.8 / 2.3 ms | p95 50 ms, PASS |
| `ubuntu-latest` | 16.1 / 16.4 / 33.0 ms | 0.7 / 1.1 ms | p95 50 ms, PASS |
| `macos-15-intel` | 87.6 / 103.2 / 198.9 ms | 11.9 / 15.3 ms | none in the plan, recorded only |

On Linux and WSL2 the round trip through the WebSocket, `docker exec` and tmux takes 1 to 2 ms. The render waits for the next animation frame of headless Chromium, so render latency sits at one 60 Hz frame. On the 2-vCPU Intel macOS runner the echo arrives in about 12 ms, and the rest is paint time in headless Chromium on that runner. The engine path is not the limiter there.

## Findings

- node-pty 1.1.0 ships no `linux-x64` prebuild. It needs node-gyp, a C++ compiler and a pnpm build-script approval. The spike uses `@lydell/node-pty`, the same node-pty code with prebuilt binaries for six targets and no install script (S-57).
- The bind-mount source depends on where the daemon runs, not on the client. `docker.exe` talking to Docker Desktop takes `C:\...`. `docker.exe` talking to a daemon inside WSL needs `/mnt/c/...`. `mountSource` takes a `MountStyle` of `posix`, `windows` or `wsl`.
- tmux needs a UTF-8 locale for Thai. The image sets `LANG=C.UTF-8` and the attach passes `-u`.
- `docker stop` ends the `docker exec` client with code 137. The server forwards that as the exit frame, and the page stops reconnecting.

## Local setup notes

This WSL2 machine has no root access. Headless Chromium needs `libnss3` and `libnspr4`, which were fetched with `apt-get download` into `~/.cache/aw-chromium-libs` and loaded with `LD_LIBRARY_PATH`. The repo does not depend on that.
