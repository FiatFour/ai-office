import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canStart,
  type DoctorContext,
  exitCodeOf,
  formatChecks,
  GROUPS,
  nodeAtLeast,
  runDoctor,
} from '../preflight/checks.ts';
import { describeHost, type HostProbe, hostProbeFor, shellOf } from '../preflight/host.ts';
import { inspect, preflightService } from '../preflight/report.ts';

const HOSTS: Record<string, HostProbe> = {
  linux: { platform: 'linux', release: '6.8.0', arch: 'x64', env: {}, procVersion: 'Linux version 6.8.0 gcc' },
  wsl2: {
    platform: 'linux',
    release: '6.18.0-microsoft-standard-WSL2',
    arch: 'x64',
    env: {},
    procVersion: 'Linux version 6.18.0-microsoft-standard-WSL2',
  },
  macos: { platform: 'darwin', release: '24.1.0', arch: 'arm64', env: {}, procVersion: '' },
  windows: { platform: 'win32', release: '10.0.26100', arch: 'x64', env: {}, procVersion: '' },
};

const engine = (
  over: Partial<{ version: string | null; ok: boolean; rootless: boolean; error: string; image: boolean }> = {},
) => ({
  version: async () => (over.version === undefined ? 'Docker version 29' : over.version),
  info: async () => ({
    ok: over.ok ?? true,
    version: '29',
    rootless: over.rootless ?? false,
    error: over.ok === false ? (over.error ?? 'daemon down') : null,
  }),
  image: async () => over.image ?? true,
});

const context = (host: HostProbe, over: Partial<DoctorContext> = {}): DoctorContext => ({
  host,
  nodeVersion: 'v24.1.0',
  home: process.cwd(),
  port: 7420,
  image: 'aw-cage:dev',
  engines: { docker: engine(), podman: engine({ version: null }) },
  gitVersion: async () => 'git version 2.50',
  portState: async () => ({ state: 'free' }),
  exists: () => true,
  preferred: undefined,
  ...over,
});

describe('doctor', () => {
  it('names WSL2 on the host row', async () => {
    const checks = await runDoctor(context(HOSTS.wsl2 as HostProbe));
    expect(checks.find((c) => c.id === 'host')?.detail).toBe('Linux (WSL2 on Windows)');
    expect(describeHost(HOSTS.linux as HostProbe).kind).toBe('linux');
  });

  it('exits 1 when any check fails and 0 otherwise', async () => {
    const down = await runDoctor(
      context(HOSTS.linux as HostProbe, {
        engines: { docker: engine({ ok: false }), podman: engine({ version: null }) },
      }),
    );
    expect(exitCodeOf(down)).toBe(1);
    expect(down.find((c) => c.id === 'engine')?.status).toBe('FAIL');
    expect(exitCodeOf(await runDoctor(context(HOSTS.linux as HostProbe)))).toBe(0);
  });

  it('does not let a WARN or SKIP fail the run', async () => {
    const checks = await runDoctor(
      context(HOSTS.linux as HostProbe, {
        engines: { docker: engine({ image: false }), podman: engine({ version: null }) },
        portState: async () => ({ state: 'busy' }),
        exists: () => false,
      }),
    );
    expect(checks.map((c) => c.status)).toEqual(expect.arrayContaining(['WARN', 'SKIP']));
    expect(exitCodeOf(checks)).toBe(0);
  });

  it.each(['linux', 'wsl2', 'macos', 'windows'])(
    'prints a fix for a stopped engine on %s that names this OS',
    async (os) => {
      const checks = await runDoctor(
        context(HOSTS[os] as HostProbe, {
          engines: { docker: engine({ ok: false }), podman: engine({ version: null }) },
        }),
      );
      const fix = checks.find((c) => c.id === 'engine')?.fix ?? '';
      const expected = {
        linux: 'systemctl',
        wsl2: 'Docker Desktop on Windows',
        macos: 'open -a Docker',
        windows: 'Docker Desktop and wait',
      }[os] as string;
      expect(fix).toContain(expected);
      expect(formatChecks(checks)).toContain(`fix: ${fix}`);
    },
  );

  it.each(['linux', 'wsl2', 'macos', 'windows'])(
    'prints a different install fix for a missing engine on %s',
    async (os) => {
      const checks = await runDoctor(
        context(HOSTS[os] as HostProbe, {
          engines: { docker: engine({ version: null }), podman: engine({ version: null }) },
        }),
      );
      const fixes = new Set<string>();
      for (const name of ['linux', 'wsl2', 'macos', 'windows']) {
        const c = await runDoctor(
          context(HOSTS[name] as HostProbe, {
            engines: { docker: engine({ version: null }), podman: engine({ version: null }) },
          }),
        );
        fixes.add(c.find((x) => x.id === 'engine')?.fix ?? '');
      }
      expect(fixes.size).toBe(4);
      expect(checks.find((c) => c.id === 'engine')?.status).toBe('FAIL');
    },
  );

  it('fails rootful podman and passes rootless podman', async () => {
    const podman = (rootless: boolean) => ({ docker: engine({ version: null }), podman: engine({ rootless }) });
    const rootful = await runDoctor(context(HOSTS.linux as HostProbe, { engines: podman(false) }));
    expect(rootful.find((c) => c.id === 'rootless')?.status).toBe('FAIL');
    expect(exitCodeOf(rootful)).toBe(1);
    const rootless = await runDoctor(context(HOSTS.linux as HostProbe, { engines: podman(true) }));
    expect(rootless.find((c) => c.id === 'rootless')?.status).toBe('PASS');
  });

  it('fails an old Node and a missing git', async () => {
    const checks = await runDoctor(
      context(HOSTS.macos as HostProbe, { nodeVersion: 'v20.19.0', gitVersion: async () => null }),
    );
    expect(checks.filter((c) => c.status === 'FAIL').map((c) => c.id)).toEqual(['node', 'git']);
    expect(nodeAtLeast('v22.17.9')).toBe(false);
    expect(nodeAtLeast('v22.18.0')).toBe(true);
    expect(nodeAtLeast('v24.0.0')).toBe(true);
  });

  it('skips the image and rootless checks when no engine answers', async () => {
    const checks = await runDoctor(
      context(HOSTS.linux as HostProbe, {
        engines: { docker: engine({ ok: false }), podman: engine({ version: null }) },
      }),
    );
    expect(checks.filter((c) => c.status === 'SKIP').map((c) => c.id)).toEqual(
      expect.arrayContaining(['rootless', 'image']),
    );
  });

  it('prints the real host row for this machine', async () => {
    const { realHostProbe } = await import('../preflight/host.ts');
    const checks = await runDoctor(
      context(realHostProbe(), { engines: { docker: engine({ ok: false }), podman: engine({ version: null }) } }),
    );
    console.log(`doctor on ${process.platform}:\n${formatChecks(checks)}`);
    expect(checks[0]?.detail.length).toBeGreaterThan(0);
  });
});

const linux = HOSTS.linux as HostProbe;
const noEngine = { docker: engine({ version: null }), podman: engine({ version: null }) };

describe('what blocks a start', () => {
  const row = (status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP') => ({
    id: 'git' as const,
    group: 'computer' as const,
    label: 'git',
    status,
    detail: '',
    fix: null,
  });

  it('lets PASS, WARN and SKIP start and stops on one FAIL', () => {
    expect(canStart([row('PASS'), row('WARN'), row('SKIP')])).toBe(true);
    expect(canStart([row('PASS'), row('FAIL'), row('PASS')])).toBe(false);
  });

  it('reports a warned machine as startable and a stopped engine as not', async () => {
    const warned = await inspect(
      context(linux, { engines: { docker: engine({ image: false }), podman: engine({ version: null }) } }),
    );
    expect(warned.checks.map((c) => c.status)).toContain('WARN');
    expect(warned.canStart).toBe(true);
    const down = await inspect(
      context(linux, { engines: { docker: engine({ ok: false }), podman: engine({ version: null }) } }),
    );
    expect(down.canStart).toBe(false);
  });

  it('gives every WARN and FAIL row a fix and every row its group', async () => {
    const worst = await runDoctor(
      context(linux, {
        nodeVersion: 'v20.0.0',
        gitVersion: async () => null,
        engines: noEngine,
        portState: async () => ({ state: 'busy' }),
        home: join(process.execPath, 'under-a-file'),
      }),
    );
    const rootful = await runDoctor(
      context(linux, { engines: { docker: engine({ version: null }), podman: engine({ image: false }) } }),
    );
    const bad = [...worst, ...rootful].filter((c) => c.status === 'FAIL' || c.status === 'WARN');
    expect(bad.map((c) => c.id).sort()).toEqual(['engine', 'git', 'home', 'image', 'node', 'port', 'rootless']);
    for (const c of bad) expect(c.fix, c.id).toBeTruthy();
    for (const c of [...worst, ...rootful]) expect(c.group, c.id).toBe(GROUPS[c.id]);
  });
});

describe('the host HQ reports', () => {
  it('lists installed engines, running or not, and asks each question once', async () => {
    const asked: string[] = [];
    const counted = (name: string, over: Parameters<typeof engine>[0]) => {
      const base = engine(over);
      return {
        ...base,
        version: async () => {
          asked.push(`${name} version`);
          return base.version();
        },
        info: async () => {
          asked.push(`${name} info`);
          return base.info();
        },
      };
    };
    const report = await inspect(
      context(linux, { engines: { docker: counted('docker', { ok: false }), podman: counted('podman', {}) } }),
    );
    expect(report.host.engines).toEqual([
      { name: 'docker', running: false },
      { name: 'podman', running: true, version: '29', rootless: false },
    ]);
    expect(asked.sort()).toEqual(['docker info', 'docker version', 'podman info', 'podman version']);
    expect((await inspect(context(linux, { engines: noEngine }))).host.engines).toEqual([]);
  });

  it('names the OS, arch, shell and kvm, and only Linux and WSL2 can have kvm', async () => {
    const wsl = await inspect(context({ ...(HOSTS.wsl2 as HostProbe), env: { SHELL: '/usr/bin/zsh' } }));
    expect(wsl.host).toMatchObject({
      os: 'wsl2',
      label: 'Linux (WSL2 on Windows)',
      arch: 'x64',
      shell: 'zsh',
      kvm: true,
    });
    expect((await inspect(context(HOSTS.windows as HostProbe))).host.kvm).toBe(false);
    expect((await inspect(context(linux, { exists: () => false }))).host.kvm).toBe(false);
  });

  it('reads the shell from SHELL, then from the Windows variables', () => {
    const windows = (env: NodeJS.ProcessEnv) => shellOf({ platform: 'win32', env });
    expect(windows({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' })).toBe('bash');
    expect(windows({ PSModulePath: 'C:\\Users\\a\\Documents\\PowerShell\\Modules' })).toBe('pwsh');
    expect(windows({ PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' })).toBe('cmd');
    expect(windows({ ComSpec: 'C:\\Windows\\System32\\CMD.EXE' })).toBe('cmd');
    expect(shellOf({ platform: 'linux', env: {} })).toBe('sh');
  });

  it('describes another computer only when AGENT_WORKS_HOST names one', () => {
    expect(describeHost(hostProbeFor({ AGENT_WORKS_HOST: 'windows' })).kind).toBe('windows');
    expect(describeHost(hostProbeFor({ AGENT_WORKS_HOST: 'macos' })).kind).toBe('macos');
    expect(hostProbeFor({}).platform).toBe(process.platform);
    expect(hostProbeFor({ AGENT_WORKS_HOST: 'amiga' }).platform).toBe(process.platform);
  });

  it('shares one run between callers that arrive together and asks again afterwards', async () => {
    let runs = 0;
    const service = preflightService((port) =>
      context(linux, {
        port,
        gitVersion: async () => {
          runs += 1;
          return 'git version 2.50';
        },
      }),
    );
    expect(service.host().engines).toBeNull();
    const [first, second] = await Promise.all([service.run(7420), service.run(7420)]);
    expect(second).toBe(first);
    expect(runs).toBe(1);
    expect(service.host().engines).toEqual(first.host.engines);
    await service.run(7420);
    expect(runs).toBe(2);
  });
});
