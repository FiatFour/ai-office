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

The CI workflow `.github/workflows/p0-5-terminal.yml` runs the same command on `ubuntu-latest`, `windows-latest` and `macos-15-intel`, and uploads the screenshots as artifacts. It also runs on pushes to `aw/p0-5`, because GitHub does not run `pull_request` workflows while the PR conflicts with its base. The CI evidence below is from [run 43754183740](https://github.com/FiatFour/ai-office/actions/runs/43754183740) at 4e31fa5.

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
| 4. `echo hi` with `docker.exe` under PowerShell 7 | `windows-latest`, ConPTY | PASS | `windows-echo.png` in CI artifact `p0-5-windows`. The runner's own daemon runs Windows containers only (S-59), so the lane points `docker.exe` at a Linux daemon in WSL 2 Debian (S-60) and mounts with `--mount-style wsl`. |
| 5. Resize | WSL2, Linux, macOS Intel, Windows | PASS | `tput cols` matched xterm's cols after 175 ms (Linux), 539 ms (macOS Intel) and 423 ms (Windows). An earlier Windows run read `tput cols` only once, right after the resize, and saw the old width, so the lane now polls for up to 5 s. |
| 6. Drop and reconnect | WSL2, Linux, macOS Intel, Windows | PASS | Same shell PID, marker still in tmux scrollback and in the viewer |
| 7. Two tabs | WSL2, Linux, macOS Intel, Windows | PASS | Both tabs show the line typed in one |
| 8. Thai | WSL2, Linux, macOS Intel, Windows | PASS | `สวัสดีครับ ภาษาไทย` comes back as the same 18 code points, `thai.png` |
| 9. Ctrl-C on `sleep 100` | WSL2, Linux, macOS Intel, Windows | PASS | Prompt back in 124 to 286 ms |
| 10. Stop the cage | WSL2, Linux, macOS Intel, Windows | PASS | Page shows "closed, terminal exited with code 137". No `exec -it aw-p0-5` process is left on the host. |

A `mount` lane also checks that the read-only bind mount shows `/work/Containerfile` in the cage, so the path conversion runs live as well as in `argv.test.ts`.

## Perf

Metric: time from the browser `keydown` event to the xterm render that shows the echoed character, 200 keys, one at a time. The probe also records the time to the parsed echo, before paint. Trunk has no terminal, so there is no baseline.

| Host | Key to render p50 / p95 / max | Key to parsed echo p50 / p95 | Budget |
| --- | --- | --- | --- |
| WSL2, this machine | 15.7 / 16.1 / 32.9 ms | 1.8 / 2.3 ms | p95 50 ms, PASS |
| `ubuntu-latest` | 15.6 / 16.0 / 32.8 ms | 1.1 / 1.7 ms | p95 50 ms, PASS |
| `windows-latest`, ConPTY and `docker.exe` to WSL 2 | 16.0 / 17.3 / 33.1 ms | 3.3 / 3.7 ms | p95 100 ms, PASS |
| `macos-15-intel` | 97.6 / 113.5 / 200.2 ms | 18.6 / 26.0 ms | none in the plan, recorded only |

On Linux, WSL2 and Windows the round trip through the WebSocket, `docker exec` and tmux takes 1 to 4 ms. The render waits for the next animation frame of headless Chromium, so render latency sits at one 60 Hz frame. On the Intel macOS runner the echo arrives in about 19 ms, and the rest is paint time in headless Chromium on that runner. The engine path is not the limiter there.

## Findings

- node-pty 1.1.0 ships no `linux-x64` prebuild. It needs node-gyp, a C++ compiler and a pnpm build-script approval. The spike uses `@lydell/node-pty`, the same node-pty code with prebuilt binaries for six targets and no install script (S-57).
- The bind-mount source depends on where the daemon runs, not on the client. `docker.exe` talking to Docker Desktop takes `C:\...`. `docker.exe` talking to a daemon inside WSL needs `/mnt/c/...`. `mountSource` takes a `MountStyle` of `posix`, `windows` or `wsl`.
- tmux needs a UTF-8 locale for Thai. The image sets `LANG=C.UTF-8` and the attach passes `-u`.
- On Windows and on Colima a resize reaches the cage 400 to 550 ms after xterm sees it, against under 200 ms on Linux. A guess, not measured: `docker.exe` has no SIGWINCH on Windows and polls the console size. HQ should not assume a resize is applied when the WebSocket frame is sent.
- `docker stop` ends the `docker exec` client with code 137. The server forwards that as the exit frame, and the page stops reconnecting.

## Local setup notes

This WSL2 machine has no root access. Headless Chromium needs `libnss3` and `libnspr4`, which were fetched with `apt-get download` into `~/.cache/aw-chromium-libs` and loaded with `LD_LIBRARY_PATH`. The repo does not depend on that.
