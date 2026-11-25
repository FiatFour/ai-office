import { existsSync } from 'node:fs';
import { Engine, type EngineName } from '../../server/sandbox/engine.ts';

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
  if (name === 'podman' && !info.rootless)
    return {
      engine: null,
      reason: `podman ${version} is rootful, and rootful podman is unsupported (fw-rootful-podman)`,
    };
  return { engine, reason: null };
};

export const kvmReason = (): string =>
  existsSync('/dev/kvm')
    ? '/dev/kvm is present, but krun cannot exec (fw-krun-exec), so the SandboxDriver contract cannot run on it; the P0-2 krun lanes cover it'
    : 'no /dev/kvm on this runner, so no krun microVM can start';
