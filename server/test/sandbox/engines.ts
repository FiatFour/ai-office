import { fileURLToPath } from 'node:url';
import { Engine, type EngineName } from '../../sandbox/engine.ts';

export const CONTEXT = fileURLToPath(new URL('.', import.meta.url));
export const IMAGE = process.env.AGENT_WORKS_TEST_IMAGE ?? 'aw-test-cage:1';
const optedOut = process.env.AGENT_WORKS_NO_LIVE === '1';

const usable = async (name: EngineName): Promise<Engine | null> => {
  if (optedOut || process.platform !== 'linux') return null;
  const engine = new Engine(name);
  if ((await engine.version()) === null) return null;
  const os = await engine.run(['info', '--format', name === 'docker' ? '{{.OSType}}' : '{{.Host.OS}}'], {
    timeoutMs: 20_000,
  });
  if (os.code !== 0 || os.out.trim() !== 'linux') return null;
  const info = await engine.info();
  if (!info.ok || (name === 'podman' && !info.rootless)) return null;
  return engine;
};

export const engines = (await Promise.all((['docker', 'podman'] as const).map(usable))).filter(
  (e): e is Engine => e !== null,
);
