import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from './engine.ts';

export const PROXY_PORT = 3128;
export const PROJECT_LABEL = 'agent-works.project';
export const HQ_LABEL = 'agent-works.hq';
export const ROLE_LABEL = 'agent-works.role';

const PROXY_DIR = join(dirname(fileURLToPath(import.meta.url)), 'proxy');

export const DEFAULT_ALLOWLIST: readonly string[] = [
  'api.anthropic.com',
  'github.com',
  'api.github.com',
  'registry.npmjs.org',
];

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

export const networkNames = (hq: string) => ({
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
    '-v',
    `${PROXY_DIR}:/proxy:ro`,
    '-v',
    `${dir}:/etc/agent-works:ro`,
    '-e',
    `PORT=${PROXY_PORT}`,
    image,
    'node',
    '/proxy/node-proxy.mjs',
  ]);
  await engine.ok(['network', 'connect', names.internal, names.proxy]);
  const inspected = JSON.parse(await engine.ok(['inspect', names.proxy])) as Array<{
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }>;
  const proxyIp = inspected[0]?.NetworkSettings.Networks[names.internal]?.IPAddress ?? '';
  if (proxyIp === '') throw new Error(`the proxy has no address on ${names.internal}`);
  const follower = engine.follow(['logs', '-f', '--since', '0s', names.proxy], (line) => {
    const denial = parseDenialLine(line);
    if (denial !== null) spec.onDenial(denial);
  });
  return { ...names, proxyIp, allowlistPath, stop: follower.stop };
};

export const lowerFirewall = async (engine: Engine, project: string, hq: string): Promise<void> => {
  const filter = ['--filter', `label=${PROJECT_LABEL}=${project}`, '--filter', `label=${HQ_LABEL}=${hq}`];
  const containers = (await engine.ok(['ps', '-aq', ...filter])).split('\n').filter(Boolean);
  if (containers.length > 0) await engine.run(['rm', '-f', ...containers]);
  const networks = (await engine.ok(['network', 'ls', '-q', ...filter])).split('\n').filter(Boolean);
  if (networks.length > 0) await engine.run(['network', 'rm', ...networks]);
};
