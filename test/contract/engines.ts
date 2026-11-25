import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Engine, type EngineName } from '../../server/sandbox/engine.ts';
import { mount } from '../../server/sandbox/export.ts';

export interface Found {
  readonly engine: Engine | null;
  readonly reason: string | null;
}

export const find = async (name: EngineName, env: NodeJS.ProcessEnv = process.env): Promise<Found> => {
  if (env.AGENT_WORKS_NO_LIVE === '1') return { engine: null, reason: 'AGENT_WORKS_NO_LIVE=1 turns real engines off' };
  const engine = new Engine(name, env);
  const version = await engine.version();
  if (version === null)
    return { engine: null, reason: `${name} is not installed on this runner (\`${name} --version\` failed)` };
  const info = await engine.info();
  if (!info.ok)
    return { engine: null, reason: `${name} ${version} is installed and has no usable engine: ${info.error}` };
  const os = await engine.run(['info', '--format', name === 'docker' ? '{{.OSType}}' : '{{.Host.OS}}'], {
    timeoutMs: 20_000,
  });
  const kind = os.out.trim();
  if (os.code !== 0 || kind !== 'linux')
    return {
      engine: null,
      reason: `${name} ${version} runs ${kind === '' ? 'no' : kind} containers, and the cage image is linux`,
    };
  if (process.platform === 'win32') {
    const probe = await engine.run(probeArgs(tmpdir()), { timeoutMs: 60_000 });
    if (mountRefused(`${probe.out}${probe.err}`))
      return {
        engine: null,
        reason: `${name} ${version} answers from a Linux daemon that cannot see Windows paths, and the driver binds the host path as given: ${firstLine(`${probe.out}${probe.err}`)}`,
      };
  }
  if (name === 'podman' && !info.rootless)
    return {
      engine: null,
      reason: `podman ${version} is rootful, and rootful podman is unsupported (fw-rootful-podman)`,
    };
  return { engine, reason: null };
};

/** Creates a container that cannot start, with the bind built by the driver's own builder. Once the driver turns a Windows path
 * into one the daemon accepts, this probe stops being refused and the cases run. */
export const probeArgs = (dir: string): string[] => ['create', ...mount(dir, '/m'), 'aw-no-such-image:0', 'true'];

export const kvmReason = (): string =>
  existsSync('/dev/kvm')
    ? '/dev/kvm is present, but krun cannot exec (fw-krun-exec), so the SandboxDriver contract cannot run on it; the P0-2 krun lanes cover it'
    : 'no /dev/kvm on this runner, so no krun microVM can start';

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

/** The daemon rejects the bind before it looks for the image, so a missing image means the mount was accepted. */
export const mountRefused = (text: string): boolean => /invalid mount|mount path|invalid bind/i.test(text);
