import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canSpawnTs, exited } from '../../server/test/helpers.ts';

const BIN = join(import.meta.dirname, '../../bin/agent-works.ts');

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe.skipIf(!canSpawnTs)('agent-works --demo', () => {
  it('replays the recorded run, answers /api/demo and stops on SIGTERM with exit 0', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [BIN, '--demo', '--no-open', '--port', String(port)], {
      env: { ...process.env, AGENT_WORKS_DEMO_INTERVAL_MS: '20' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    const url = `http://127.0.0.1:${port}`;
    let shipped = false;
    for (let i = 0; i < 300 && !shipped; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      shipped = await fetch(`${url}/api/snapshot`)
        .then((res) => res.json() as Promise<{ state: { boxes: Record<string, { state: string }> } }>)
        .then((snapshot) => snapshot.state.boxes['alpha/p12c']?.state === 'shipped')
        .catch(() => false);
    }
    expect(shipped).toBe(true);
    expect(out).toContain('Demo replay of fixtures/demo/events.jsonl');
    child.kill('SIGTERM');
    await exited(child);
    if (process.platform !== 'win32') expect(child.exitCode).toBe(0);
  }, 30_000);

  it('says so and exits 2 when the port is busy', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const { port } = holder.address() as { port: number };
    const child = spawn(process.execPath, [BIN, '--demo', '--no-open', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    await exited(child);
    holder.close();
    expect(child.exitCode).toBe(2);
    expect(err).toContain('Port');
  }, 30_000);
});
