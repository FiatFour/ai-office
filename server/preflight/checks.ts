import { accessSync, constants, mkdirSync } from 'node:fs';
import { ENGINE_NAMES, type Engine, type EngineInfo, type EngineName } from '../sandbox/engine.ts';
import { describeHost, FIXES, type HostProbe, type OsKind } from './host.ts';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface Check {
  readonly id: string;
  readonly label: string;
  readonly status: Status;
  readonly detail: string;
  readonly fix: string | null;
}

export type PortState =
  | { readonly state: 'free' }
  | { readonly state: 'hq'; readonly pid: number }
  | { readonly state: 'busy' };

export interface DoctorContext {
  readonly host: HostProbe;
  readonly nodeVersion: string;
  readonly home: string;
  readonly port: number;
  readonly image: string;
  readonly engines: Readonly<
    Record<EngineName, Pick<Engine, 'version' | 'info'> & { image: (name: string) => Promise<boolean> }>
  >;
  readonly gitVersion: () => Promise<string | null>;
  readonly portState: (port: number) => Promise<PortState>;
  readonly exists: (path: string) => boolean;
  readonly preferred: string | undefined;
}

const MIN_NODE: readonly [number, number] = [22, 18];

export const nodeAtLeast = (version: string, min: readonly [number, number] = MIN_NODE): boolean => {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
};

const check = (id: string, label: string, status: Status, detail: string, fix: string | null = null): Check => ({
  id,
  label,
  status,
  detail,
  fix,
});

interface EngineProbeResult {
  readonly name: EngineName;
  readonly version: string | null;
  readonly info: EngineInfo | null;
}

export const runDoctor = async (ctx: DoctorContext): Promise<Check[]> => {
  const host = describeHost(ctx.host);
  const kind: OsKind = host.kind;
  const checks: Check[] = [check('host', 'Host', 'PASS', host.label)];

  checks.push(
    nodeAtLeast(ctx.nodeVersion)
      ? check('node', 'Node.js', 'PASS', ctx.nodeVersion)
      : check(
          'node',
          'Node.js',
          'FAIL',
          `${ctx.nodeVersion} cannot run HQ, which needs 22.18 or newer`,
          FIXES.nodeOld(kind),
        ),
  );

  const git = await ctx.gitVersion();
  checks.push(
    git === null
      ? check('git', 'git', 'FAIL', 'git is not on PATH', FIXES.gitMissing(kind))
      : check('git', 'git', 'PASS', git),
  );

  const order: readonly EngineName[] =
    ctx.preferred === 'docker' || ctx.preferred === 'podman' ? [ctx.preferred] : ENGINE_NAMES;
  const probed: EngineProbeResult[] = await Promise.all(
    order.map(async (name) => {
      const version = await ctx.engines[name].version();
      return { name, version, info: version === null ? null : await ctx.engines[name].info() };
    }),
  );
  const usable = probed.find((p) => p.info?.ok === true);
  if (usable !== undefined) {
    checks.push(check('engine', 'Container engine', 'PASS', `${usable.name} ${usable.info?.version ?? ''}`.trim()));
    if (usable.name === 'podman' && usable.info?.rootless !== true) {
      checks.push(
        check(
          'rootless',
          'Rootless engine',
          'FAIL',
          'rootful podman lets a cage reach the host through the bridge gateway (P0-2 host-gateway)',
          'Use rootless podman (run it as your own user, not with sudo) or docker.',
        ),
      );
    } else {
      checks.push(
        check(
          'rootless',
          'Rootless engine',
          'PASS',
          usable.info?.rootless === true ? 'rootless' : `${usable.name} with a host-closed internal network`,
        ),
      );
    }
    const hasImage = await ctx.engines[usable.name].image(ctx.image);
    checks.push(
      hasImage
        ? check('image', 'Cage image', 'PASS', ctx.image)
        : check(
            'image',
            'Cage image',
            'WARN',
            `${ctx.image} is not built on ${usable.name}`,
            `${usable.name} build -t ${ctx.image} -f server/sandbox/Containerfile server/sandbox`,
          ),
    );
  } else {
    const installed = probed.filter((p) => p.version !== null);
    checks.push(
      installed.length === 0
        ? check(
            'engine',
            'Container engine',
            'FAIL',
            'neither docker nor podman is installed',
            FIXES.engineMissing(kind),
          )
        : check(
            'engine',
            'Container engine',
            'FAIL',
            installed.map((p) => `${p.name} is installed but not answering: ${p.info?.error ?? 'unknown'}`).join('; '),
            FIXES.engineDown(kind),
          ),
    );
    checks.push(check('rootless', 'Rootless engine', 'SKIP', 'no engine answered'));
    checks.push(check('image', 'Cage image', 'SKIP', 'no engine answered'));
  }

  const kvm = kind === 'linux' || kind === 'wsl2';
  checks.push(
    kvm && ctx.exists('/dev/kvm')
      ? check('kvm', 'krun (/dev/kvm)', 'PASS', '/dev/kvm present')
      : check('kvm', 'krun (/dev/kvm)', 'SKIP', 'only needed for the krun runtime', FIXES.kvm(kind)),
  );

  const port = await ctx.portState(ctx.port);
  checks.push(
    port.state === 'free'
      ? check('port', `Port ${ctx.port}`, 'PASS', 'free')
      : port.state === 'hq'
        ? check('port', `Port ${ctx.port}`, 'PASS', `HQ is serving it (pid ${port.pid})`)
        : check(
            'port',
            `Port ${ctx.port}`,
            'WARN',
            'held by another program',
            'Free it, or start HQ with --port <number>.',
          ),
  );

  try {
    mkdirSync(ctx.home, { recursive: true });
    accessSync(ctx.home, constants.W_OK);
    checks.push(check('home', 'HQ home', 'PASS', ctx.home));
  } catch (error) {
    checks.push(
      check(
        'home',
        'HQ home',
        'FAIL',
        `${ctx.home} is not writable: ${(error as Error).message}`,
        'Set AGENT_WORKS_HOME to a writable folder.',
      ),
    );
  }
  return checks;
};

export const exitCodeOf = (checks: readonly Check[]): number => (checks.some((c) => c.status === 'FAIL') ? 1 : 0);

export const formatChecks = (checks: readonly Check[]): string =>
  checks
    .map((c) =>
      [
        `${c.status.padEnd(4)}  ${c.label}: ${c.detail}`,
        ...(c.fix !== null && c.status !== 'PASS' ? [`      fix: ${c.fix}`] : []),
      ].join('\n'),
    )
    .join('\n');
