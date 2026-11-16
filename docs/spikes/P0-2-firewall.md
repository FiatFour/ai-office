# P0-2. The egress firewall fails closed

This spike tests the firewall the spec describes (`AGENT_WORKS_PROMPT.md`, "Firewall"). A probe cage sits on an `--internal` network. One proxy container joins that network and a normal egress network, and it allows `CONNECT host:port` only for allowlisted hosts. The probe then tries to get out by every route we could think of, not only through the proxy.

The short answer is yes, with one fix and one gap. Traffic that skips the proxy has no route out on docker, rootless podman and krun. A plain docker `--internal` network still lets the cage reach services on the host through the bridge gateway. Turning off the bridge address closes that on docker. Rootful podman has the same gap and no matching option yet.

## Rerun it

```sh
pnpm install --frozen-lockfile
pnpm test spikes/P0-2
node spikes/P0-2/firewall.mjs --engine docker --perf 200 --out /tmp/swarm-p0-2/docker
node spikes/P0-2/firewall.mjs --engine podman --perf 200 --out /tmp/swarm-p0-2/podman
node spikes/P0-2/krun-nested.mjs --out /tmp/swarm-p0-2/krun -- --perf 200
node spikes/P0-2/firewall.mjs --cleanup --engine docker,podman
```

`firewall.mjs` prints one `PASS`, `FAIL` or `NOT-RUN` line per attempt, writes one JSON file per attempt to `--out`, and exits 0 only when no attempt fails. `--proxy node`, `--proxy squid` or the default `node,squid` picks the proxy. `--plain-internal` drops the docker hardening so the host escape below reproduces. `--engine krun` checks for a usable krun first. When it finds none, it records the exact failure and falls back to podman.

`krun-nested.mjs` gives a krun lane on hosts whose podman has no krun, such as `ubuntu-latest` (crun 1.21 there has no `+LIBKRUN`). It starts a privileged Fedora 45 container with `/dev/kvm`, installs podman 6.1.3 and `crun-krun`, and runs `firewall.mjs --engine krun` as an unprivileged user, so the cages run under rootless podman. `--rootful` runs it as root instead.

CI runs all three lanes in `.github/workflows/p0-2-firewall.yml` on `ubuntu-latest` and uploads the JSON results as artifacts.

## What runs

| Container | Network | Role |
| --- | --- | --- |
| `aw-p0-2-cage` | internal only | Node 26 probe (`probe.mjs`), `HTTPS_PROXY=http://nova:x@<proxy>:3128` |
| `aw-p0-2-proxy` | egress and internal | Node CONNECT proxy (`proxy/node-proxy.mjs`) or Squid 6.13 |
| `aw-p0-2-canary` | egress | CoreDNS 1.15.0. Logs every query. The proxy resolves through it, and the cage gets it as `--dns`. |
| `aw-p0-2-stub` | egress and a separate IPv6 network | Stand-in for HQ's `/api/sandbox/deny`, and the IPv6 target |

Every container and network carries `agent-works.project=p0-2-spike`. Cleanup filters on that exact value, because other spikes share the same docker daemon.

The allowlist is one rule per line: `host`, `host:port`, `*.domain`. The port defaults to 443. `*.domain` matches subdomains, not the domain itself. IP literals never match, either as a rule or as a CONNECT target. The Node proxy reads the file on every request. Squid gets the same rules as anchored `dstdom_regex -n` ACLs paired with a port ACL, and reloads with `squid -k reconfigure`.

## Attempts and lanes

| Lane | Attempt | Pass when |
| --- | --- | --- |
| 1 | `allow-registry` | `https://registry.npmjs.org/` through the proxy returns 200 |
| 1 | `deny-host`, `deny-ip-literal` | CONNECT to `example.com:443` and to `1.1.1.1:443` gets 403 |
| 2 (3 on podman) | `raw-tcp` | A direct TCP connect to `1.1.1.1:443` fails |
| host | `host-gateway` | TCP to a listener on the host fails through every bridge gateway and `172.17.0.1` |
| 5 | `dns-embedded` | A unique canary name looked up through the cage's resolver never reaches the canary, while the same lookup from an egress container does |
| 5 | `dns-direct` | A DNS query sent straight to the canary's IP never arrives |
| 5 | `dns-via-proxy` | CONNECT to a unique canary name gets 403, the canary never sees that name, and it does see the proxy's lookup of the allowed host |
| 6 | `ipv6-public`, `ipv6-outside` | TCP over IPv6 fails, to a public address and to a container on an IPv6 network that a container next to it reaches |
| 7 | `deny-event` | One POST to `/api/sandbox/deny` per denial, with `agent: nova` |
| 8 | `live-allowlist` | After `example.com` joins the allowlist, the next request returns 200 and the cage's start time is unchanged |
| perf | `perf` | Added p95 time to first byte is at most 50 ms |
| 9 | `proxy-down` | With the proxy killed, a request from the cage fails |
| 10 | `cleanup` | No container or network with the project label is left |

## Results

| Engine | Where | Node proxy | Squid |
| --- | --- | --- | --- |
| docker 29.1.3 | this machine, WSL2 | all PASS | all PASS, lane 7 NOT-RUN |
| docker 29.4.2 | `ubuntu-latest` | all PASS | all PASS, lane 7 NOT-RUN |
| rootless podman 5.7.0, netavark | `ubuntu-latest` | all PASS | all PASS, lane 7 NOT-RUN |
| krun on rootless podman 6.1.3 | Fedora 45 in docker, this machine and `ubuntu-latest` | all PASS | all PASS, lane 7 NOT-RUN |
| krun on the runner's own podman | `ubuntu-latest` | NOT-RUN. `podman --runtime=krun run` exited 125 with `default OCI runtime "krun" not found`, so the lane fell back to podman. | same |
| rootful podman 6.1.3 | Fedora 45 in docker | `host-gateway` FAIL, the rest PASS | not run |

Every krun probe reports the guest kernel `6.12.109` while the host runs `6.18.33`, so the probes ran inside the microVM. On `ubuntu-latest` the nested krun lane passed every attempt with guest kernel `6.12.109` and 4 vCPUs on a `7.0.0-azure` host.

Under krun, lane 8 proves less than on the other engines. Each krun probe is a new one-shot cage, so "without a cage restart" only shows that the long-lived cage was not restarted, not that it kept working across the edit.

## Findings

### A plain `--internal` network does not shut the cage off from the host

On a docker `--internal` network the bridge holds the gateway address, and the host answers on it. The cage connected to a listener on the host's `0.0.0.0` at `172.19.0.1` (`--plain-internal`, `host-escape-plain-internal.txt`). Any host service on a wildcard address is reachable: HQ, a dev database, or a local proxy that would forward the cage straight out.

The fix on docker is `-o com.docker.network.bridge.inhibit_ipv4=true` on the internal network. The bridge then gets no IPv4 address, the cage has only an on-link route, and every gateway attempt fails with `ENETUNREACH`. Containers still get addresses, so the cage still reaches the proxy. The internal network also gets no IPv6, because an IPv6 internal network puts an address on the bridge too. The host answered `ECONNREFUSED` on it, which shows the host is reachable there.

Rootful podman has the same gap. The cage reached the host through the internal network's gateway `10.89.2.1`, with or without krun. Netavark has no option like `inhibit_ipv4` that we found. Rootless podman does not have the gap, because the gateway lives in the rootless network namespace, not on the host. So the spec's rootless podman is fine, and rootful podman needs a host firewall rule or must be unsupported. P0-6 should carry this as an attack path, and HQ should listen on `127.0.0.1` only.

### DNS does not leak, with these limits

The cage cannot get a lookup to the canary. The embedded resolver answers `SERVFAIL` on docker and does not forward, which matches S-41. The canary's IP is unreachable. The proxy checks the allowlist before it resolves anything, so a denied CONNECT to `<secret>.canary.agent-works.test` never becomes a lookup. The control lookup from an egress container did reach the canary in every run, so the canary was listening.

This proves less than a public canary zone would. The canary is a local CoreDNS on the egress network, not an authoritative server for a real zone. It shows that no lookup leaves the cage toward a resolver we control, through the embedded resolver, a direct query, or the proxy. It does not exercise the host's own resolver chain (systemd-resolved, WSL's DNS tunnel) or a real recursive path on the internet, and it does not cover DNS over HTTPS to an allowlisted host. Those need a real zone, which costs money and is left to the operator.

### krun cannot `exec`

`podman exec` into a krun container fails with `the handler does not support exec`. The spike runs each krun probe as a fresh one-shot cage on the same internal network instead. The spec's terminal path, `<engine> exec -it <cage> tmux attach`, cannot work in a krun cage, so P0-3 and P0-5 need the agent's tmux session started by the entrypoint, with a different attach path.

krun's TSI networking stays inside the container's network namespace. This answers the open question in `docs/sources.md`. Under krun, raw TCP, IPv6, direct DNS and the host on the egress network all fail, as they do without krun.

### IPv6 on the egress network breaks the proxy's connects

With `--ipv6` on the egress network, the proxy got AAAA answers and tried IPv6 first, with no IPv6 route out. Squid then waited its `happy_eyeballs_connect_timeout` of 250 ms on every new host, and added a flat 250 ms in 2 of 3 runs. The egress network must stay IPv4 only unless the host has a working IPv6 route. The spike puts its IPv6 target on a separate network for this reason.

### Agent labels are claims, not proof

The proxy learns the agent from the user name in the proxy URL, sent as `Proxy-Authorization`. A cage can put any name there and borrow another agent's per-agent allowlist entries. G1 should decide between a per-agent secret in that header and mapping the cage's source IP to its agent at HQ.

The deny event carries the denied host name, which the cage chooses. HQ must treat it as untrusted text when it shows an Action item.

## Proxy options for G1

| | Node CONNECT proxy | Squid 6.13 (`ubuntu/squid`) |
| --- | --- | --- |
| Size | about 90 lines, Node built-ins only | Squid plus a generated config |
| Image | `node:26-alpine` (also the cage base) | `ubuntu/squid`, 303 MB |
| Allowlist edit | Next request, no reload | `squid -k reconfigure` |
| Deny event to HQ | Built in, one POST per denial with the agent label | None. HQ would tail `TCP_DENIED/403` lines from `access.log`, which carry no agent label without proxy auth |
| DNS | One lookup per CONNECT, no cache | Own cache |
| Added time to first byte, docker, this machine, 3 runs | p50 11.9 to 12.6 ms, p95 12.3 to 13.6 ms | p50 -1.7 to -1.3 ms, p95 -5.4 to -3.2 ms |
| Added, docker, `ubuntu-latest`, 2 runs | p50 9.1 and 9.7 ms, p95 14.2 and 0.4 ms | p50 6.6 and 8.1 ms, p95 9.1 and 11.1 ms |
| Added, rootless podman, `ubuntu-latest` | p50 8.8 and 15.2 ms, p95 9.7 and 9.7 ms (2 runs) | p50 11.7 ms, p95 15.5 ms (1 run) |
| Added, krun on rootless podman, this machine, 1 run | p50 25.9 ms, p95 39.2 ms | p50 9.8 ms, p95 -1.4 ms |

Both stay inside the 50 ms budget on every engine. krun with the Node proxy comes closest, at 39.2 ms p95 in one run. Each run is 200 requests to `https://registry.npmjs.org/`, alternating 100 direct from the host and 100 from the cage, each on a fresh connection. The probe times from the first socket open to the first response byte, inside the cage, so `exec` and VM start are not counted. No request failed.

The Node proxy's 12 ms is DNS. It looks the host up again on every CONNECT, and the canary logged 202 lookups (A and AAAA) in a 100-request run, at a median of 10.3 ms each, because the canary forwards to docker's resolver and then the host's. Squid made 2 lookups in the same run. Without the canary, production has one hop less, and a small cache in the Node proxy would close most of the gap. Squid's negative numbers mean its cached lookup beat the host's own uncached lookup through the WSL resolver. On `ubuntu-latest`, where the host's lookups are fast, Squid adds 7 to 12 ms at p50. That is the extra hop through the proxy. The direct side's p95 is noisy on this machine (51 to 124 ms across runs), so a p95 difference under about 10 ms is not a real difference.

The recommendation for G1 is the Node proxy plus a DNS cache. It is the only option that sends HQ a labeled deny event and picks up allowlist edits without a reload, and it adds about 12 ms before a cache. Squid is the fallback if a hardened, widely used proxy matters more than the deny event.

## Sources this spike checked

- S-40 holds only with `inhibit_ipv4`. A plain `--internal` network still reaches the host (above).
- S-41 holds on docker 29.1.3 and 29.4.2. The embedded resolver answered `SERVFAIL` to an internal-only container.
- S-43 holds on rootless podman 5.7.0. The cage had no route out.
- S-46: TSI traffic stays in the container's internal network namespace.
- S-48 is out of date. The `ubuntu-latest` run reported docker 29.4.2, podman 5.7.0 with netavark, and crun 1.21 without `+LIBKRUN`.
