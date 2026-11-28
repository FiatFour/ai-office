import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from '../store/atomic.ts';
import type { Engine } from './engine.ts';
import { mount } from './export.ts';

export const PROXY_PORT = 3128;
export const PROJECT_LABEL = 'agent-works.project';
export const HQ_LABEL = 'agent-works.hq';
export const ROLE_LABEL = 'agent-works.role';

const PROXY_DIR = join(dirname(fileURLToPath(import.meta.url)), 'proxy');

/** Every policy holds the model API, without which no agent in a cage can run. */
const MODEL_API = 'api.anthropic.com';
const REGISTRY = 'registry.npmjs.org';

export const POLICIES = {
  locked: [MODEL_API, REGISTRY],
  balanced: [MODEL_API, 'github.com', 'api.github.com', REGISTRY],
  open: ['*'],
} as const satisfies Record<string, readonly string[]>;

export type PolicyName = keyof typeof POLICIES;

export const DEFAULT_ALLOWLIST: readonly string[] = POLICIES.balanced;

export interface FirewallPolicy {
  /** The rules every cage of the project gets. */
  readonly allowlist: readonly string[];
  /** The extra rules of one worker's cages, by worker name. */
  readonly workers: Readonly<Record<string, readonly string[]>>;
}

export const firewallPolicy = (
  policy: PolicyName = 'balanced',
  allow: readonly string[] = [],
  workers: FirewallPolicy['workers'] = {},
): FirewallPolicy => ({ allowlist: [...new Set([...POLICIES[policy], ...allow])], workers });

/** What the proxy knows of one cage, by its address on the internal network. */
export interface CageIdentity {
  readonly agent: string;
  readonly allow: readonly string[];
}

export const NOT_ALLOWLISTED = 'not-allowlisted';

export interface Denial {
  readonly host: string;
  readonly port: number;
  readonly agent: string;
  readonly reason: string;
  readonly at: string;
}

export interface Firewall {
  readonly internal: string;
  readonly egress: string;
  readonly proxy: string;
  readonly proxyIp: string;
  readonly allowlistPath: string;
  readonly cagesPath: string;
  readonly stop: () => void;
}

export interface FirewallSpec {
  readonly engine: Engine;
  readonly project: string;
  readonly hq: string;
  readonly image: string;
  readonly dir: string;
  readonly allowlist: readonly string[];
  readonly onDenial: (denial: Denial) => void;
}

export const filterArgs = (project: string, hq: string): string[] => [
  '--filter',
  `label=${PROJECT_LABEL}=${project}`,
  '--filter',
  `label=${HQ_LABEL}=${hq}`,
];

export const lines = (text: string): string[] => text.split('\n').filter(Boolean);

export const labelArgs = (project: string, hq: string, role: string): string[] => [
  '--label',
  `${PROJECT_LABEL}=${project}`,
  '--label',
  `${HQ_LABEL}=${hq}`,
  '--label',
  `${ROLE_LABEL}=${role}`,
];

export const hardenedArgs = (): string[] => [
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,size=256m',
];

export const writeAllowlist = (path: string, hosts: readonly string[]): void => {
  writeFileSync(path, `${hosts.join('\n')}\n`);
  chmodSync(path, 0o644);
};

export const writeCages = (path: string, cages: ReadonlyMap<string, CageIdentity>): void => {
  writeAtomic(path, JSON.stringify(Object.fromEntries(cages)));
  chmodSync(path, 0o644);
};

export const addressOn = async (engine: Engine, container: string, network: string): Promise<string> => {
  const inspected = JSON.parse(await engine.ok(['inspect', container])) as Array<{
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }>;
  const address = inspected[0]?.NetworkSettings.Networks[network]?.IPAddress ?? '';
  if (address === '') throw new Error(`${container} has no address on ${network}`);
  return address;
};

export const parseDenialLine = (line: string): Denial | null => {
  if (!line.startsWith('{"deny":')) return null;
  try {
    const { deny } = JSON.parse(line) as { deny: Record<string, unknown> };
    return {
      host: String(deny.host ?? ''),
      port: Number(deny.port ?? 0),
      agent: String(deny.agent ?? 'unknown'),
      reason: String(deny.reason ?? deny.method ?? ''),
      at: String(deny.ts ?? ''),
    };
  } catch {
    return null;
  }
};

const networkNames = (hq: string) => ({
  internal: `aw-${hq}-internal`,
  egress: `aw-${hq}-egress`,
  proxy: `aw-${hq}-proxy`,
});

export const raiseFirewall = async (spec: FirewallSpec): Promise<Firewall> => {
  const { engine, project, hq, image, dir, allowlist } = spec;
  const names = networkNames(hq);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const allowlistPath = join(dir, 'allowlist.txt');
  writeAllowlist(allowlistPath, allowlist);
  const cagesPath = join(dir, 'cages.json');
  writeCages(cagesPath, new Map());
  const labels = labelArgs(project, hq, 'network');
  await engine.ok(['network', 'create', ...labels, names.egress]);
  const harden = engine.name === 'docker' ? ['-o', 'com.docker.network.bridge.inhibit_ipv4=true'] : [];
  await engine.ok(['network', 'create', ...labels, '--internal', ...harden, names.internal]);
  await engine.ok([
    'run',
    '-d',
    '--name',
    names.proxy,
    ...labelArgs(project, hq, 'proxy'),
    '--network',
    names.egress,
    ...hardenedArgs(),
    '--pids-limit',
    '128',
    '--memory',
    '256m',
    ...mount(PROXY_DIR, '/proxy', true),
    ...mount(dir, '/etc/agent-works', true),
    '-e',
    `PORT=${PROXY_PORT}`,
    image,
    'node',
    '/proxy/node-proxy.mjs',
  ]);
  await engine.ok(['network', 'connect', names.internal, names.proxy]);
  const proxyIp = await addressOn(engine, names.proxy, names.internal);
  const follower = engine.follow(['logs', '-f', '--since', '0s', names.proxy], (line) => {
    const denial = parseDenialLine(line);
    if (denial !== null) spec.onDenial(denial);
  });
  return { ...names, proxyIp, allowlistPath, cagesPath, stop: follower.stop };
};

export const lowerFirewall = async (engine: Engine, project: string, hq: string): Promise<void> => {
  const filter = filterArgs(project, hq);
  const containers = lines(await engine.ok(['ps', '-aq', ...filter]));
  if (containers.length > 0) await engine.run(['rm', '-f', ...containers]);
  const networks = lines(await engine.ok(['network', 'ls', '-q', ...filter]));
  if (networks.length > 0) await engine.run(['network', 'rm', ...networks]);
};
