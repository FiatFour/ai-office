import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { httpsGet, tcpConnect } from './probe.mjs';
import { parseAllowlist, toSquidConf } from './proxy/allowlist.mjs';

/**
 * @typedef {'docker' | 'podman' | 'krun'} EngineName
 * @typedef {{ bin: string, cageGlobalArgs: string[], hardenInternal: string[], rm: string[], probeBy: 'exec' | 'run' }} Engine
 * @typedef {'node' | 'squid'} ProxyName
 * @typedef {{ args: (setup: ProxySetup) => string[], reload: string[] | null, logFile: string | null }} ProxyKind
 * @typedef {{ dir: string, canaryIp: string, stubIp: string }} ProxySetup
 * @typedef {'PASS' | 'FAIL' | 'NOT-RUN'} Status
 * @typedef {{ status: Status, detail: unknown }} Outcome
 * @typedef {{ id: string, lane: number | 'perf' | 'host', what: string, run: (ctx: Ctx) => Promise<Outcome> | Outcome }} Attempt
 * @typedef {{
 *   engineName: EngineName, engine: Engine, proxyName: ProxyName, proxy: ProxyKind, dir: string, perfCount: number,
 *   hostPort: number, canaryIp: string, stubIp: string, stubIp6: string, proxyIp: string, gateways: string[],
 *   deniedSoFar: number, probe: (...args: string[]) => any, logs: (name: string) => string,
 *   setAllowlist: (text: string) => void,
 * }} Ctx
 */

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const LABEL = 'agent-works.project';
const PROJECT = 'p0-2-spike';
const AGENT = 'nova';
const CANARY_ZONE = 'canary.agent-works.test';
const ALLOWED = { host: 'registry.npmjs.org', path: '/' };
const DENIED_HOST = 'example.com';
const PUBLIC_V4 = '1.1.1.1';
const PUBLIC_V6 = '2606:4700:4700::1111';
const DOCKER0 = '172.17.0.1';
const ALLOWLIST = `${ALLOWED.host}\n*.pythonhosted.org\npypi.org\n`;
const PERF_BUDGET_MS = 50;
const IMAGES = {
  node: 'docker.io/library/node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5',
  squid: 'docker.io/ubuntu/squid:latest@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029',
  coredns: 'docker.io/coredns/coredns:latest@sha256:0a9d8c8ddf34347eb59aad9a8784f0710de88d6d112726d11d271f9bc6daca26',
};
const NAMES = {
  egress: 'aw-p0-2-egress',
  internal: 'aw-p0-2-internal',
  v6: 'aw-p0-2-v6',
  canary: 'aw-p0-2-canary',
  stub: 'aw-p0-2-stub',
  proxy: 'aw-p0-2-proxy',
  cage: 'aw-p0-2-cage',
};
const COREFILE = `${CANARY_ZONE}:53 {\n  log\n  whoami\n}\n.:53 {\n  log\n  forward . /etc/resolv.conf\n}\n`;

/** @type {Record<EngineName, Engine>} */
const ENGINES = {
  docker: {
    bin: 'docker',
    cageGlobalArgs: [],
    hardenInternal: ['-o', 'com.docker.network.bridge.inhibit_ipv4=true'],
    rm: ['rm', '-f'],
    probeBy: 'exec',
  },
  podman: { bin: 'podman', cageGlobalArgs: [], hardenInternal: [], rm: ['rm', '-f', '-t', '0'], probeBy: 'exec' },
  krun: {
    bin: 'podman',
    cageGlobalArgs: ['--runtime=krun'],
    hardenInternal: [],
    rm: ['rm', '-f', '-t', '0'],
    // krun cannot exec into a running microVM, so each probe is a fresh one-shot cage on the same network.
    probeBy: 'run',
  },
};

/** @type {Record<ProxyName, ProxyKind>} */
const PROXIES = {
  node: {
    args: ({ dir, canaryIp, stubIp }) => [
      '--dns',
      canaryIp,
      '-v',
      `${join(SPIKE_DIR, 'proxy')}:/proxy:ro`,
      '-v',
      `${dir}:/etc/agent-works:ro`,
      '-e',
      `DENY_URL=http://${stubIp}:8080/api/sandbox/deny`,
      IMAGES.node,
      'node',
      '/proxy/node-proxy.mjs',
    ],
    reload: null,
    logFile: null,
  },
  squid: {
    args: ({ dir }) => [
      '-v',
      `${dir}:/etc/agent-works:ro`,
      '--entrypoint',
      'squid',
      IMAGES.squid,
      '-N',
      '-f',
      '/etc/agent-works/squid.conf',
    ],
    reload: ['squid', '-k', 'reconfigure', '-f', '/etc/agent-works/squid.conf'],
    logFile: '/var/log/squid/access.log',
  },
};

/**
 * @param {Engine} engine
 * @param {string[]} args
 * @param {{ check?: boolean }} [options]
 */
function sh(engine, args, { check = true } = {}) {
  const result = spawnSync(engine.bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (check && result.status !== 0) {
    throw new Error(`${engine.bin} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.error}`);
  }
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean} ready
 * @param {string} what
 */
async function waitFor(ready, what, timeoutMs = 20000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    if (ready()) return;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** @param {Engine} engine */
function cleanup(engine) {
  const filter = ['--filter', `label=${LABEL}=${PROJECT}`];
  const containers = sh(engine, ['ps', '-aq', ...filter])
    .stdout.split('\n')
    .filter(Boolean);
  const removal = containers.length > 0 ? sh(engine, [...engine.rm, ...containers], { check: false }) : null;
  const networks = sh(engine, ['network', 'ls', '-q', ...filter])
    .stdout.split('\n')
    .filter(Boolean);
  if (networks.length > 0) sh(engine, ['network', 'rm', ...networks], { check: false });
  const left = {
    containers: sh(engine, ['ps', '-a', ...filter, '--format', '{{.Names}}']).stdout.trim(),
    networks: sh(engine, ['network', 'ls', ...filter, '--format', '{{.Name}}']).stdout.trim(),
  };
  return {
    removed: { containers: containers.length, networks: networks.length },
    ...(removal !== null && removal.code !== 0 ? { rmExit: removal.code, rmStderr: removal.stderr.trim() } : {}),
    left,
  };
}

/**
 * @param {Engine} engine
 * @param {string} container
 * @param {string} network
 */
function addressOf(engine, container, network) {
  const [info] = JSON.parse(sh(engine, ['inspect', container]).stdout);
  const net = info.NetworkSettings.Networks[network];
  return { ip: String(net.IPAddress ?? ''), ip6: String(net.GlobalIPv6Address ?? '') };
}

/**
 * Docker reports subnets under IPAM.Config, Podman under subnets.
 * @param {Engine} engine
 * @param {string} network
 * @returns {string[]}
 */
function gatewaysOf(engine, network) {
  const [info] = JSON.parse(sh(engine, ['network', 'inspect', network]).stdout);
  /** @type {Array<Record<string, string>>} */
  const subnets = info.IPAM?.Config ?? info.subnets ?? [];
  return subnets.map((subnet) => subnet.Gateway ?? subnet.gateway ?? '').filter(Boolean);
}

/** @param {string} dir @param {string} text @param {string} canaryIp */
function writeAllowlist(dir, text, canaryIp) {
  writeFileSync(join(dir, 'allowlist.txt'), text);
  writeFileSync(join(dir, 'squid.conf'), toSquidConf(parseAllowlist(text), { dnsServer: canaryIp }));
}

/** @param {boolean} ok @param {unknown} detail @returns {Outcome} */
const verdict = (ok, detail) => ({ status: ok ? 'PASS' : 'FAIL', detail });

/** @param {number[]} values @param {number} q */
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

/** @param {Array<{ ok: boolean, status?: number, ttfbMs?: number, tlsMs?: number, tunnelMs?: number }>} results */
function summarize(results) {
  const good = results.filter((r) => r.ok && r.status === 200);
  /** @param {'ttfbMs' | 'tlsMs' | 'tunnelMs'} key */
  const field = (key) => good.flatMap((r) => (r[key] === undefined ? [] : [r[key]]));
  const ttfb = field('ttfbMs');
  const tunnel = field('tunnelMs');
  return {
    n: results.length,
    errors: results.length - good.length,
    p50: quantile(ttfb, 0.5),
    p95: quantile(ttfb, 0.95),
    min: Math.min(...ttfb),
    max: Math.max(...ttfb),
    tlsP50: quantile(field('tlsMs'), 0.5),
    ...(tunnel.length > 0 ? { tunnelP50: quantile(tunnel, 0.5), tunnelP95: quantile(tunnel, 0.95) } : {}),
  };
}

/** @type {Attempt[]} */
const ATTEMPTS = [
  {
    id: 'allow-registry',
    lane: 1,
    what: `HTTPS to allowed ${ALLOWED.host} through the proxy returns 200`,
    run: (c) => {
      const result = c.probe('https', ALLOWED.host, ALLOWED.path);
      return verdict(result.ok && result.status === 200, result);
    },
  },
  {
    id: 'deny-host',
    lane: 1,
    what: `CONNECT to non-allowed ${DENIED_HOST} gets 403`,
    run: (c) => {
      const result = c.probe('https', DENIED_HOST, '/');
      if (result.connectStatus === 403) c.deniedSoFar += 1;
      return verdict(result.connectStatus === 403, result);
    },
  },
  {
    id: 'deny-ip-literal',
    lane: 1,
    what: `CONNECT to IP literal ${PUBLIC_V4} gets 403`,
    run: (c) => {
      const result = c.probe('https', PUBLIC_V4, '/');
      if (result.connectStatus === 403) c.deniedSoFar += 1;
      return verdict(result.connectStatus === 403, result);
    },
  },
  {
    id: 'raw-tcp',
    lane: 2,
    what: `raw TCP to ${PUBLIC_V4}:443 that skips the proxy fails`,
    run: (c) => {
      const result = c.probe('tcp', PUBLIC_V4, '443');
      return verdict(!result.connected, result);
    },
  },
  {
    id: 'host-gateway',
    lane: 'host',
    what: 'TCP to a host service through any bridge gateway fails',
    run: (c) => {
      const targets = [...new Set([...c.gateways, DOCKER0])];
      const results = targets.map((ip) => ({ ip, ...c.probe('tcp', ip, String(c.hostPort)) }));
      return verdict(
        results.every((r) => !r.connected),
        results,
      );
    },
  },
  {
    id: 'ipv6-public',
    lane: 6,
    what: `TCP over IPv6 to ${PUBLIC_V6}:443 fails`,
    run: async (c) => {
      const cage = c.probe('tcp', PUBLIC_V6, '443');
      const host = await tcpConnect(PUBLIC_V6, 443);
      return verdict(!cage.connected, { cage, hostControl: host });
    },
  },
  {
    id: 'ipv6-outside',
    lane: 6,
    what: 'TCP over IPv6 to a container outside the internal network fails, while a container beside it connects',
    run: (c) => {
      if (c.stubIp6 === '')
        return { status: 'FAIL', detail: 'the v6 network gave no IPv6 address, so the attempt proves nothing' };
      const control = JSON.parse(
        sh(c.engine, [
          'run',
          '--rm',
          '--network',
          NAMES.v6,
          '-v',
          `${SPIKE_DIR}:/probe:ro`,
          IMAGES.node,
          'node',
          '/probe/probe.mjs',
          'tcp',
          c.stubIp6,
          '8080',
        ]).stdout,
      );
      const cage = c.probe('tcp', c.stubIp6, '8080');
      return verdict(control.connected && !cage.connected, { target: c.stubIp6, control, cage });
    },
  },
  {
    id: 'dns-embedded',
    lane: 5,
    what: "lookup of a unique canary name through the cage's resolver never reaches the canary",
    run: (c) => {
      const control = `${randomUUID()}-control.${CANARY_ZONE}`;
      const controlResult = JSON.parse(
        sh(c.engine, [
          'run',
          '--rm',
          '--network',
          NAMES.egress,
          '--dns',
          c.canaryIp,
          '-v',
          `${SPIKE_DIR}:/probe:ro`,
          IMAGES.node,
          'node',
          '/probe/probe.mjs',
          'dns',
          control,
        ]).stdout,
      );
      const name = `${randomUUID()}.${CANARY_ZONE}`;
      const result = c.probe('dns', name);
      const log = c.logs(NAMES.canary);
      const controlSeen = log.includes(control);
      return verdict(controlSeen && !log.includes(name), {
        name,
        cage: result,
        canarySawCage: log.includes(name),
        control: { name: control, result: controlResult, canarySaw: controlSeen },
      });
    },
  },
  {
    id: 'dns-direct',
    lane: 5,
    what: 'a DNS query sent straight to the canary server IP never arrives',
    run: (c) => {
      const name = `${randomUUID()}.${CANARY_ZONE}`;
      const result = c.probe('dns', name, c.canaryIp);
      const seen = c.logs(NAMES.canary).includes(name);
      return verdict(!result.resolved && !seen, { name, cage: result, canarySaw: seen });
    },
  },
  {
    id: 'dns-via-proxy',
    lane: 5,
    what: 'a CONNECT to a unique canary name gets 403 and the proxy never looks it up',
    run: (c) => {
      const name = `${randomUUID()}.${CANARY_ZONE}`;
      const result = c.probe('https', name, '/');
      if (result.connectStatus === 403) c.deniedSoFar += 1;
      const log = c.logs(NAMES.canary);
      const proxyUsesCanary = log.includes(`${ALLOWED.host}.`);
      return verdict(result.connectStatus === 403 && proxyUsesCanary && !log.includes(name), {
        name,
        cage: result,
        canarySaw: log.includes(name),
        proxyUsesCanary,
      });
    },
  },
  {
    id: 'live-allowlist',
    lane: 8,
    what: `adding ${DENIED_HOST} to the allowlist lets the next request through without a cage restart`,
    run: (c) => {
      const startedAt = () => JSON.parse(sh(c.engine, ['inspect', NAMES.cage]).stdout)[0].State.StartedAt;
      const cageStart = startedAt();
      const before = c.probe('https', DENIED_HOST, '/');
      if (before.connectStatus === 403) c.deniedSoFar += 1;
      c.setAllowlist(`${ALLOWLIST}${DENIED_HOST}\n`);
      const reloaded = c.proxy.reload === null ? null : sh(c.engine, ['exec', NAMES.proxy, ...c.proxy.reload]);
      const after = c.probe('https', DENIED_HOST, '/');
      c.setAllowlist(ALLOWLIST);
      if (c.proxy.reload !== null) sh(c.engine, ['exec', NAMES.proxy, ...c.proxy.reload]);
      const sameCage = startedAt() === cageStart;
      return verdict(before.connectStatus === 403 && after.ok && after.status === 200 && sameCage, {
        before,
        after,
        reload: reloaded && { code: reloaded.code },
        sameCage,
      });
    },
  },
  {
    id: 'deny-event',
    lane: 7,
    what: `every denied CONNECT posts one event with agent ${AGENT} to /api/sandbox/deny`,
    run: async (c) => {
      if (c.proxy.reload !== null) {
        return {
          status: 'NOT-RUN',
          detail: 'squid has no deny hook; HQ would tail its access log for TCP_DENIED lines',
        };
      }
      /** @returns {Array<{ path: string, body: { agent: string, host: string } }>} */
      const events = () =>
        c
          .logs(NAMES.stub)
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line));
      await waitFor(() => events().length >= c.deniedSoFar, 'deny events', 5000).catch(() => {});
      const seen = events();
      const ok =
        seen.length === c.deniedSoFar &&
        seen.every((event) => event.path === '/api/sandbox/deny' && event.body.agent === AGENT);
      return verdict(ok, { expected: c.deniedSoFar, events: seen });
    },
  },
  {
    id: 'perf',
    lane: 'perf',
    what: `added p95 time to first byte through the cage is at most ${PERF_BUDGET_MS} ms`,
    run: async (c) => {
      if (c.perfCount === 0) return { status: 'NOT-RUN', detail: 'pass --perf <requests> to run' };
      /** @type {Array<{ ok: boolean, status?: number, ttfbMs?: number, tlsMs?: number }>} */
      const direct = [];
      /** @type {Array<{ ok: boolean, status?: number, ttfbMs?: number, tlsMs?: number, tunnelMs?: number }>} */
      const cage = [];
      for (let i = 0; i < c.perfCount; i += 1) {
        if (i % 2 === 0) direct.push(await httpsGet({ host: ALLOWED.host, path: ALLOWED.path, proxy: null }));
        else cage.push(c.probe('https', ALLOWED.host, ALLOWED.path));
      }
      const host = summarize(direct);
      const through = summarize(cage);
      const added = { p50: through.p50 - host.p50, p95: through.p95 - host.p95 };
      return verdict(added.p95 <= PERF_BUDGET_MS && host.errors === 0 && through.errors === 0, {
        url: `https://${ALLOWED.host}${ALLOWED.path}`,
        direct: host,
        cage: through,
        added,
        budgetMs: PERF_BUDGET_MS,
      });
    },
  },
  {
    id: 'proxy-down',
    lane: 9,
    what: 'with the proxy container killed, a request from the cage fails',
    run: (c) => {
      sh(c.engine, ['kill', NAMES.proxy]);
      const result = c.probe('https', ALLOWED.host, ALLOWED.path);
      return verdict(!result.ok, result);
    },
  },
];

/**
 * @param {Engine} engine
 * @param {string} name
 * @param {string} network
 * @param {string[]} args
 */
function startContainer(engine, name, network, args, globalArgs = /** @type {string[]} */ ([])) {
  sh(engine, [
    ...globalArgs,
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `${LABEL}=${PROJECT}`,
    '--network',
    network,
    ...args,
  ]);
}

/**
 * @param {EngineName} engineName
 * @param {ProxyName} proxyName
 * @param {{ perfCount: number, plainInternal: boolean, hostPort: number }} options
 * @returns {Ctx}
 */
function setUp(engineName, proxyName, { perfCount, plainInternal, hostPort }) {
  const engine = ENGINES[engineName];
  const proxy = PROXIES[proxyName];
  const dir = mkdtempSync(join(tmpdir(), 'aw-p0-2-'));
  chmodSync(dir, 0o755);
  const labels = ['--label', `${LABEL}=${PROJECT}`];
  sh(engine, ['network', 'create', ...labels, NAMES.egress]);
  sh(engine, ['network', 'create', ...labels, '--ipv6', NAMES.v6]);
  sh(engine, [
    'network',
    'create',
    ...labels,
    '--internal',
    ...(plainInternal ? [] : engine.hardenInternal),
    NAMES.internal,
  ]);

  writeFileSync(join(dir, 'Corefile'), COREFILE);
  startContainer(engine, NAMES.canary, NAMES.egress, [
    '-v',
    `${dir}:/etc/coredns:ro`,
    IMAGES.coredns,
    '-conf',
    '/etc/coredns/Corefile',
  ]);
  startContainer(engine, NAMES.stub, NAMES.egress, [
    '-v',
    `${SPIKE_DIR}:/probe:ro`,
    IMAGES.node,
    'node',
    '/probe/deny-stub.mjs',
  ]);
  /** @param {string} name */
  const logs = (name) => {
    const out = sh(engine, ['logs', name], { check: false });
    return out.stdout + out.stderr;
  };
  const canaryIp = addressOf(engine, NAMES.canary, NAMES.egress).ip;
  sh(engine, ['network', 'connect', NAMES.v6, NAMES.stub]);
  const stub = addressOf(engine, NAMES.stub, NAMES.egress);
  const stubIp6 = addressOf(engine, NAMES.stub, NAMES.v6).ip6;
  writeAllowlist(dir, ALLOWLIST, canaryIp);

  startContainer(engine, NAMES.proxy, NAMES.egress, proxy.args({ dir, canaryIp, stubIp: stub.ip }));
  sh(engine, ['network', 'connect', NAMES.internal, NAMES.proxy]);
  const proxyIp = addressOf(engine, NAMES.proxy, NAMES.internal).ip;

  const cageArgs = [
    '--label',
    `agent-works.agent=${AGENT}`,
    '--dns',
    canaryIp,
    '-e',
    `HTTPS_PROXY=http://${AGENT}:x@${proxyIp}:3128`,
    '-e',
    `HTTP_PROXY=http://${AGENT}:x@${proxyIp}:3128`,
    '-e',
    'NO_PROXY=localhost,127.0.0.1',
    '-v',
    `${SPIKE_DIR}:/probe:ro`,
    IMAGES.node,
  ];
  startContainer(engine, NAMES.cage, NAMES.internal, [...cageArgs, 'sleep', 'infinity'], engine.cageGlobalArgs);

  const probeCommand = {
    exec: () => ['exec', NAMES.cage],
    run: () => [
      ...engine.cageGlobalArgs,
      'run',
      '--rm',
      '--label',
      `${LABEL}=${PROJECT}`,
      '--network',
      NAMES.internal,
      ...cageArgs,
    ],
  }[engine.probeBy];
  /** @param {string[]} args */
  const probe = (...args) => {
    const out = sh(engine, [...probeCommand(), 'node', '/probe/probe.mjs', ...args]);
    return JSON.parse(out.stdout);
  };

  return {
    engineName,
    engine,
    proxyName,
    proxy,
    dir,
    perfCount,
    hostPort,
    canaryIp,
    stubIp: stub.ip,
    stubIp6,
    proxyIp,
    gateways: [NAMES.internal, NAMES.egress, NAMES.v6].flatMap((network) => gatewaysOf(engine, network)),
    deniedSoFar: 0,
    probe,
    logs,
    setAllowlist: (text) => writeAllowlist(dir, text, canaryIp),
  };
}

/** @param {Ctx} ctx */
async function waitReady(ctx) {
  await waitFor(() => ctx.logs(NAMES.canary).includes('CoreDNS-'), 'canary DNS');
  await waitFor(() => ctx.logs(NAMES.stub).includes('deny-stub listening'), 'deny stub');
  await waitFor(() => ctx.probe('tcp', ctx.proxyIp, '3128').connected === true, `proxy on ${ctx.proxyIp}:3128`);
}

/** @returns {string | null} */
function krunDetectFailure() {
  if (!existsSync('/dev/kvm')) return '/dev/kvm does not exist';
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch {
    return `/dev/kvm is not readable and writable by uid ${process.getuid?.()}`;
  }
  const result = spawnSync('podman', ['--runtime=krun', 'run', '--rm', IMAGES.node, 'true'], { encoding: 'utf8' });
  if (result.status !== 0)
    return `podman --runtime=krun run exited ${result.status}: ${(result.stderr || String(result.error)).trim()}`;
  return null;
}

/**
 * @param {string} out
 * @param {Record<string, unknown> & { status: Status }} record
 */
function emit(out, record) {
  writeFileSync(
    join(out, `${record.engine}-${record.proxy}-${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(
    `${record.status} lane ${record.lane} ${record.engine}/${record.proxy} ${record.id}: ${record.what} (${record.ms} ms)`,
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string', default: 'docker' },
      proxy: { type: 'string', default: 'node,squid' },
      perf: { type: 'string', default: '0' },
      out: { type: 'string', default: join(tmpdir(), 'swarm-p0-2', 'results') },
      cleanup: { type: 'boolean', default: false },
      'plain-internal': { type: 'boolean', default: false },
    },
  });
  const out = values.out;
  mkdirSync(out, { recursive: true });
  const engineNames = /** @type {EngineName[]} */ (values.engine.split(','));
  for (const name of engineNames) if (!(name in ENGINES)) throw new Error(`unknown engine ${name}`);
  const proxyNames = /** @type {ProxyName[]} */ (values.proxy.split(','));
  for (const name of proxyNames) if (!(name in PROXIES)) throw new Error(`unknown proxy ${name}`);

  if (values.cleanup) {
    let failed = false;
    for (const engineName of engineNames) {
      const engine = ENGINES[engineName];
      const start = Date.now();
      const found = spawnSync(engine.bin, ['version'], { encoding: 'utf8' });
      /** @type {Record<string, unknown> & { status: Status }} */
      const record =
        found.status === 0
          ? (() => {
              const detail = cleanup(engine);
              return { status: detail.left.containers === '' && detail.left.networks === '' ? 'PASS' : 'FAIL', detail };
            })()
          : { status: 'NOT-RUN', detail: `${engine.bin} is not installed` };
      failed ||= record.status === 'FAIL';
      emit(out, {
        engine: engineName,
        proxy: 'none',
        id: 'cleanup',
        lane: 10,
        what: `nothing labeled ${LABEL}=${PROJECT} is left`,
        ms: Date.now() - start,
        ...record,
      });
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }

  let failed = false;
  for (let engineName of engineNames) {
    if (engineName === 'krun') {
      const failure = krunDetectFailure();
      if (failure !== null) {
        emit(out, {
          engine: 'krun',
          proxy: 'none',
          id: 'krun-detect',
          lane: 4,
          what: 'krun runtime is usable',
          ms: 0,
          status: 'NOT-RUN',
          detail: { failure, fallback: 'podman' },
        });
        engineName = 'podman';
      }
    }
    const engine = ENGINES[engineName];
    for (const image of Object.values(IMAGES)) sh(engine, ['pull', '-q', image]);
    const hostListener = createServer((socket) => socket.on('error', () => {}).end('host\n'));
    await new Promise((resolve) => hostListener.listen(0, '::', () => resolve(null)));
    const address = hostListener.address();
    const hostPort = typeof address === 'object' && address !== null ? address.port : 0;
    for (const proxyName of proxyNames) {
      cleanup(engine);
      /** @type {Ctx | null} */
      let ctx = null;
      try {
        ctx = setUp(engineName, proxyName, {
          perfCount: Number(values.perf),
          plainInternal: values['plain-internal'],
          hostPort,
        });
        await waitReady(ctx);
        for (const attempt of ATTEMPTS) {
          const start = Date.now();
          /** @type {Outcome} */
          let outcome;
          try {
            outcome = await attempt.run(ctx);
          } catch (error) {
            outcome = { status: 'FAIL', detail: { error: String(error) } };
          }
          failed ||= outcome.status === 'FAIL';
          emit(out, {
            engine: engineName,
            proxy: proxyName,
            id: attempt.id,
            lane: attempt.lane,
            what: attempt.what,
            ms: Date.now() - start,
            ...outcome,
          });
        }
      } catch (error) {
        failed = true;
        emit(out, {
          engine: engineName,
          proxy: proxyName,
          id: 'setup',
          lane: 0,
          what: 'cage, proxy and canary start',
          ms: 0,
          status: 'FAIL',
          detail: { error: String(error), proxyLog: ctx?.logs(NAMES.proxy) },
        });
      } finally {
        if (ctx !== null) {
          writeFileSync(
            join(out, `${engineName}-${proxyName}-logs.txt`),
            [NAMES.canary, NAMES.stub, NAMES.proxy, NAMES.cage]
              .map((name) => `== ${name}\n${ctx?.logs(name)}`)
              .join('\n'),
          );
          if (ctx.proxy.logFile !== null) {
            sh(
              engine,
              ['cp', `${NAMES.proxy}:${ctx.proxy.logFile}`, join(out, `${engineName}-${proxyName}-access.log`)],
              { check: false },
            );
          }
          rmSync(ctx.dir, { recursive: true, force: true });
        }
        const start = Date.now();
        const detail = cleanup(engine);
        const clean = detail.left.containers === '' && detail.left.networks === '';
        failed ||= !clean;
        emit(out, {
          engine: engineName,
          proxy: proxyName,
          id: 'cleanup',
          lane: 10,
          what: `nothing labeled ${LABEL}=${PROJECT} is left`,
          ms: Date.now() - start,
          status: clean ? 'PASS' : 'FAIL',
          detail,
        });
      }
    }
    hostListener.close();
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
