import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import { AGENT, ALLOWED_HOST, DENIED_HOST, GITHUB_HOST, METADATA_NAME } from './rig.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof import('./rig.mjs').startFirewall>>} Firewall
 * @typedef {{ observed: string[], detail: string } | { notRun: string }} Outcome
 * @typedef {{ firewall: () => Promise<Firewall> }} Ctx
 */

const PUBLIC_V4 = '1.1.1.1';
const CANARY_ZONE = 'canary.agent-works.test';
const HOST_SERVICE = `import { createServer } from 'node:net';
const server = createServer((socket) => socket.on('error', () => {}).end('host\\n'));
server.listen(0, '::', () => console.log(server.address().port));`;

/** @param {(fw: Firewall) => Promise<Outcome> | Outcome} body @returns {(ctx: Ctx) => Promise<Outcome>} */
const withFirewall = (body) => async (ctx) => body(await ctx.firewall());

const POSTINSTALL = `set -e
rm -rf /tmp/pkg /tmp/proj /tmp/pi-out.json /tmp/net-1.0.0.tgz
mkdir -p /tmp/pkg /tmp/proj
cat > /tmp/pkg/hook.mjs <<'JS'
import { execFileSync } from 'node:child_process';
const probe = (...args) => JSON.parse(execFileSync('node', ['/probe/probe.mjs', ...args], { encoding: 'utf8' }));
const out = { proxied: probe('https', 'example.com', '/'), direct: probe('tcp', '1.1.1.1', '443') };
import('node:fs').then((fs) => fs.writeFileSync('/tmp/pi-out.json', JSON.stringify(out)));
JS
cat > /tmp/pkg/package.json <<'JSON'
{"name":"net","version":"1.0.0","scripts":{"postinstall":"node hook.mjs"}}
JSON
cd /tmp/pkg && npm pack --silent --pack-destination /tmp > /dev/null
cd /tmp/proj && npm init -y > /dev/null && npm install --offline --no-audit --no-fund /tmp/net-1.0.0.tgz > /tmp/npm.log 2>&1 || true
cat /tmp/pi-out.json 2>/dev/null; true`;

export const FIREWALL_ROWS = {
  'fw-poisoned-doc-curl': {
    lane: 3,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const doc = fw.inCage(['cat', '/docs/ARCHITECTURE.md']).out;
      const url = /curl (https:\/\/\S+)/.exec(doc)?.[1] ?? '';
      const target = new URL(url);
      const result = fw.probe(['https', target.hostname, `${target.pathname}${target.search}`]);
      const events = await fw.waitDenials(before);
      const event = events.find((e) => e.body.host === target.hostname);
      const stopped = result.connectStatus === 403 && event?.path === '/api/sandbox/deny' && event.body.agent === AGENT;
      return {
        observed: stopped ? ['F2', 'F4'] : [`connect=${result.connectStatus}`],
        detail: `the doc tells the agent to curl ${url}; CONNECT got ${result.connectStatus}, and the stub received ${events.length} deny event(s): ${JSON.stringify(event?.body)}`,
      };
    }),
  },
  'fw-postinstall-net': {
    lane: 4,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const output = fw.script(POSTINSTALL);
      const parsed = JSON.parse(output || '{}');
      const events = await fw.waitDenials(before);
      const proxyDenied = parsed.proxied?.connectStatus === 403 && events.some((e) => e.body.host === DENIED_HOST);
      const noRoute = parsed.direct?.connected === false;
      return {
        observed:
          proxyDenied && noRoute
            ? ['F1', 'F2']
            : [`proxied=${parsed.proxied?.connectStatus}`, `direct=${parsed.direct?.connected}`],
        detail: `npm install of a tarball whose postinstall calls out: through the proxy CONNECT ${parsed.proxied?.connectStatus} for ${DENIED_HOST} (${events.length} deny event), direct TCP to ${PUBLIC_V4}:443 connected=${parsed.direct?.connected}`,
      };
    }),
  },
  'fw-raw-tcp': {
    lane: null,
    run: withFirewall(async (fw) => {
      const { address } = await lookup(ALLOWED_HOST);
      const control = fw.controlOnEgress(['tcp', address, '443']);
      if (control.connected !== true) {
        return {
          notRun: `a container with a route out could not reach ${address}:443 either (${control.error}), so a failure proves nothing`,
        };
      }
      const result = fw.probe(['tcp', address, '443']);
      return {
        observed: result.connected === false ? ['F1'] : ['connected'],
        detail: `raw TCP from the cage to ${ALLOWED_HOST} at ${address}:443 skipping the proxy: connected=${result.connected} (${String(result.error).slice(0, 60)}); the same connect from a container on the egress network: connected=${control.connected}`,
      };
    }),
  },
  'fw-host-gateway': {
    lane: null,
    run: withFirewall(async (fw) => {
      const service = spawn(process.execPath, ['--input-type=module', '-e', HOST_SERVICE], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      try {
        const port = String(Number(String((await once(service.stdout, 'data'))[0]).trim()));
        const addresses = Object.values(networkInterfaces())
          .flat()
          .flatMap((nic) => (nic === undefined || nic.internal || nic.address.startsWith('fe80') ? [] : [nic.address]));
        const targets = [...new Set([...fw.gateways, ...addresses, '172.17.0.1'])];
        const results = targets.map((ip) => ({ ip, connected: fw.probe(['tcp', ip, port]).connected }));
        return {
          observed: results.every((r) => r.connected === false) ? ['F1'] : ['host-reachable'],
          detail: `a host service on :: port ${port}; from the cage ${results.map((r) => `${r.ip}=${r.connected}`).join(' ')}`,
        };
      } finally {
        service.kill();
      }
    }),
  },
  'fw-dns-exfil': {
    lane: 5,
    run: withFirewall(async (fw) => {
      const { sink, defaultGateway } = fw.exfil;
      const sinkControl = `${randomUUID()}-control`;
      fw.controlOnDefaultBridge(['dns', sinkControl, `${defaultGateway}:${sink.port}`]);
      const zoneControl = `${randomUUID()}-control.${CANARY_ZONE}`;
      fw.controlOnEgress(['dns', zoneControl]);
      const hostAddresses = Object.values(networkInterfaces())
        .flat()
        .flatMap((nic) => (nic === undefined || nic.internal || nic.address.startsWith('fe80') ? [] : [nic.address]));
      const targets = [...new Set([...fw.gateways, defaultGateway, ...hostAddresses])];
      const direct = randomUUID();
      fw.script(
        `${targets.map((ip, index) => `node /probe/probe.mjs dns ${direct}-${index} ${ip}:${sink.port} > /dev/null &`).join('\n')}\nwait\n`,
      );
      const viaProxy = `${randomUUID()}.${CANARY_ZONE}`;
      const proxied = fw.probe(['https', viaProxy, '/']);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const log = fw.canaryLog();
      const sinkControlSeen = sink.names.includes(sinkControl);
      const zoneControlSeen = log.includes(zoneControl);
      if (!sinkControlSeen || !zoneControlSeen) {
        return {
          notRun: `a control lookup did not reach its canary (host sink ${sinkControlSeen}, CoreDNS ${zoneControlSeen}), so a missing lookup from the cage proves nothing`,
        };
      }
      const directSeen = sink.names.filter((name) => name.startsWith(direct));
      const leaked = [...directSeen, ...(log.includes(viaProxy) ? [viaProxy] : [])];
      const stopped = leaked.length === 0 && proxied.connectStatus === 403;
      return {
        observed: stopped ? ['F1', 'F2'] : [`canary-saw=${leaked.length}`],
        detail: `controls reached both canaries (a host DNS listener from the default bridge, CoreDNS from the egress network). From the cage: lookups sent straight to the host listener on port ${sink.port} at ${targets.length} host addresses (${targets.join(', ')}), ${directSeen.length} reached it; a CONNECT through the proxy for a name in the CoreDNS zone got ${proxied.connectStatus}, seen=${log.includes(viaProxy)}. The cage's own resolver path is not tested here`,
      };
    }),
  },
  'fw-ssrf-metadata': {
    lane: null,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const result = fw.probe(['tunnel', METADATA_NAME, '443']);
      const reasons = (await fw.waitDenials(before)).map((e) => e.body.reason);
      return {
        observed:
          result.connectStatus === 403 && result.banner === '' && reasons.includes('non-public-address')
            ? ['F2a']
            : [`connect=${result.connectStatus}`],
        detail: `CONNECT to allowlisted ${METADATA_NAME}, which resolves to 169.254.169.254: status ${result.connectStatus}, banner "${result.banner}", deny reasons ${JSON.stringify(reasons)}`,
      };
    }),
  },
  'fw-fronting-sni': {
    lane: null,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const result = fw.probe(['front', ALLOWED_HOST, DENIED_HOST]);
      const reasons = (await fw.waitDenials(before)).map((e) => e.body.reason);
      return {
        observed: result.ok === false && reasons.includes('sni-mismatch') ? ['F2s'] : [`ok=${result.ok}`],
        detail: `CONNECT ${ALLOWED_HOST} then TLS with SNI and Host ${DENIED_HOST}: ok=${result.ok}, deny reasons ${JSON.stringify(reasons)}`,
      };
    }),
  },
  'fw-ech': {
    lane: null,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const result = fw.cageProbe(['ech', ALLOWED_HOST]);
      const reasons = (await fw.waitDenials(before)).map((e) => e.body.reason);
      return {
        observed: result.answered === false && reasons.includes('ech') ? ['F2s'] : [`answered=${result.answered}`],
        detail: `a ClientHello with SNI ${ALLOWED_HOST} and the ECH extension through an allowed CONNECT: ${JSON.stringify(result)}, deny reasons ${JSON.stringify(reasons)}`,
      };
    }),
  },
  'fw-host-header-cdn': {
    lane: null,
    run: withFirewall(async (fw) => {
      const result = fw.cageProbe(['hosthdr', ALLOWED_HOST, DENIED_HOST]);
      const answered = typeof result.status === 'number' && result.status > 0;
      return {
        observed: answered ? [] : ['stopped'],
        detail: `CONNECT ${ALLOWED_HOST}, TLS with its own SNI, then "Host: ${DENIED_HOST}" inside the tunnel: the edge answered ${result.status} (server ${result.server}). The proxy never sees the Host header; whether another tenant answers depends on the CDN`,
      };
    }),
  },
  'fw-allowlisted-exfil': {
    lane: null,
    run: withFirewall(async (fw) => {
      const canary = `CANARY_TOKEN_${randomUUID().slice(0, 8)}`;
      const result = fw.probe(['https', GITHUB_HOST, `/zen?d=${canary}`]);
      return {
        observed: result.ok === true && result.connectStatus === 200 ? [] : ['stopped'],
        detail: `a request to the allowlisted ${GITHUB_HOST} with a canary in the query string reached the host through an allowed CONNECT (${result.connectStatus}) and the host answered ${result.status}, whatever the status; any allowlisted name that accepts data is an exfiltration channel`,
      };
    }),
  },
  'fw-label-spoof': {
    lane: null,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const result = fw.probe(['https', DENIED_HOST, '/'], {
        env: { HTTPS_PROXY: `http://mallory:x@${fw.proxyIp}:3128` },
      });
      const labels = (await fw.waitDenials(before)).map((e) => e.body.agent);
      return {
        observed: result.connectStatus === 403 && labels.includes('mallory') ? [] : ['label-bound'],
        detail: `the cage ${AGENT} sent Proxy-Authorization as "mallory": CONNECT ${result.connectStatus}, and the deny event named agent ${JSON.stringify(labels)}. The proxy takes the agent label from the request`,
      };
    }),
  },
  'fw-proxy-down': {
    lane: null,
    run: withFirewall(async (fw) => {
      const { address } = await lookup(ALLOWED_HOST);
      const control = fw.controlOnEgress(['tcp', address, '443']);
      if (control.connected !== true) {
        return {
          notRun: `a container with a route out could not reach ${address}:443 either (${control.error}), so a failure proves nothing`,
        };
      }
      fw.killProxy();
      /** @type {Record<string, any>} */
      let viaProxy;
      /** @type {Record<string, any>} */
      let direct;
      try {
        viaProxy = fw.probe(['https', ALLOWED_HOST, '/']);
        direct = fw.probe(['tcp', address, '443']);
      } finally {
        await fw.restartProxy();
      }
      return {
        observed:
          viaProxy.ok === false && direct.connected === false
            ? ['F3']
            : [`via-proxy-ok=${viaProxy.ok}`, `direct-connected=${direct.connected}`],
        detail: `with the proxy container killed: an allowlisted HTTPS request from the cage ok=${viaProxy.ok}, and a direct TCP connect to ${ALLOWED_HOST} at ${address}:443 connected=${direct.connected} (${String(direct.error).slice(0, 50)}); the same connect from a container on the egress network connected=${control.connected}; the proxy was restarted after`,
      };
    }),
  },
  'deny-event-flood': {
    lane: null,
    run: withFirewall(async (fw) => {
      const before = fw.denyEvents().length;
      const flood = fw.cageProbe(['flood', '100']);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const delivered = fw.denyEvents().length - before;
      const logged = new Set(fw.proxyLog().match(/flood-\d+\.example\.com/g) ?? []).size;
      const CAP_PER_SECOND = 20;
      return {
        observed:
          flood.denied === 100 && logged === 100 && delivered > 0 && delivered <= 2 * CAP_PER_SECOND
            ? ['F4r']
            : [`denied=${flood.denied}`, `logged=${logged}`, `delivered=${delivered}`],
        detail: `100 denied CONNECTs from the cage in one burst: ${flood.denied} got 403 and ${logged} appear in the proxy's own log, but HQ's deny endpoint received ${delivered} (the proxy posts at most ${CAP_PER_SECOND} a second, so a burst spans at most two windows)`,
      };
    }),
  },
  'fw-local-open': {
    lane: 10,
    run: withFirewall(async (fw) => {
      const container = fw.startOpenCage();
      const result = JSON.parse(
        fw.run(['exec', container, 'node', '/probe/probe.mjs', 'https', DENIED_HOST, '/', 'direct']).out || '{}',
      );
      return {
        observed: result.ok === true ? [] : ['stopped'],
        detail: `stand-in for subagents-local, a container on the default bridge with no proxy: a direct HTTPS request to ${DENIED_HOST} got ${result.status}. Spec: the firewall is off in this mode`,
      };
    }),
  },
};
