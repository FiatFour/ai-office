# ADR 0001. The cage egress proxy is the Node CONNECT proxy

Status: accepted at gate G1, 2026-11-17. The operator took the recommended option.

## Context

Every cage sits on an `--internal` network. One proxy container joins that network and an egress network and allows `CONNECT host:port` only for allowlisted hosts. P0-2 built two proxies behind the same allowlist and ran every attempt against both (`docs/spikes/P0-2-firewall.md`, "Proxy options for G1").

## Decision

HQ's sandbox driver runs the Node CONNECT proxy from `spikes/P0-2/proxy/` (`node-proxy.mjs`, `allowlist.mjs`, `address.mjs`, `tls-hello.mjs`), now under `server/sandbox/proxy/`. Squid is not built.

## Evidence

| Property | Node proxy | Squid 6.13 (`ubuntu/squid`) | Source |
| --- | --- | --- | --- |
| SNI fronting through an allowlisted CONNECT (`deny-fronting`) | closed, the tunnel dies unless the ClientHello SNI equals the CONNECT host | open, the build is `--with-gnutls`, has no `ssl::server_name` ACL, and rejects `ssl-bump` on `http_port` (S-65) | measured, P0-2 round 2, red then green |
| Names that resolve to host, metadata or private addresses (`ssrf-*`) | refused before dial, dials the address it checked | denied by ACL | measured |
| Deny event to HQ with the agent label | built in, capped at 20 per second | none, HQ would tail `access.log` | measured |
| Allowlist edit | read on every request | `squid -k reconfigure` | measured |
| Added time to first byte, p95, docker, 200 requests | 11.3 ms after the round 2 fixes, under the 50 ms budget on docker, podman and krun | -3.0 ms | measured |

## Consequences

- The proxy fails closed on no SNI, ECH, two server names and a ClientHello that never finishes. A cage whose TLS stack turns ECH on stops working. Accepted.
- It resolves once per CONNECT with no cache, which costs about 12 ms. A cache must keep the rule that the dialed address is the checked one. Not built, not measured.
- Residuals accepted at G1 and carried by `docs/threat-model.md`: CDN fronting through the Host header, ECH on a CDN edge that is allowlisted, DNS over HTTPS to an allowlisted resolver, multi-tenant allowlisted hosts, rootful podman unsupported, krun has no `exec`.
- The agent label comes from the proxy user name and is a claim. HQ treats the deny event's host text as untrusted.
- The docker internal network is created with `com.docker.network.bridge.inhibit_ipv4=true` and no IPv6, and HQ listens on `127.0.0.1` only (P0-2 "A plain --internal network does not shut the cage off from the host").
