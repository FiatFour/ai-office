import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canSpawnTs as canRun, exited, tempDir } from './helpers.ts';

const BIN = fileURLToPath(new URL('../../bin/agent-works.ts', import.meta.url));

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

interface Booted {
  readonly child: ChildProcess;
  readonly port: number;
  readonly stderr: () => string;
  readonly dead: boolean;
}

const boot = async (home: string, port: number): Promise<Booted> => {
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'serve', '--port', String(port), '--home', home], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const booted = { child, port, stderr: () => err, dead: false };
  for (let i = 0; i < 400; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return booted;
    } catch {}
    if (child.exitCode !== null) return { ...booted, dead: true };
    await sleep(25);
  }
  throw new Error(`HQ did not come up: ${err}`);
};

describe.skipIf(!canRun)('kill -9 durability', () => {
  it('loses no acknowledged event, leaves no seq gap, reclaims a stale lock and refuses a second HQ', async () => {
    const home = tempDir('kill9');
    const acked = new Set<string>();
    let next = 0;
    for (let round = 0; round < 6; round += 1) {
      const port = await freePort();
      const hq = await boot(home, port);
      expect(hq.dead, `round ${round} boots over the previous round's stale lock: ${hq.stderr()}`).toBe(false);
      const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as {
        state: { staff: Record<string, unknown> };
      };
      for (const worker of acked) expect(Object.keys(snapshot.state.staff), `round ${round}`).toContain(worker);
      const { events } = (await (await fetch(`http://127.0.0.1:${port}/api/events?after=0`)).json()) as {
        events: Array<{ seq: number }>;
      };
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(events.length).toBeGreaterThanOrEqual(acked.size);
      if (round === 3) {
        const second = await boot(home, await freePort());
        expect(second.dead).toBe(true);
        expect(second.stderr()).toContain('owns this state directory');
      }
      let stop = false;
      const writer = async () => {
        while (!stop) {
          const worker = `w${next++}`;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
              method: 'POST',
              body: JSON.stringify({ source: 'human', kind: 'add_worker', worker }),
            });
            if (res.ok) acked.add(worker);
          } catch {}
        }
      };
      const writers = [writer(), writer(), writer(), writer()];
      await sleep(80 + Math.random() * 200);
      hq.child.kill('SIGKILL');
      stop = true;
      await Promise.all(writers);
      await exited(hq.child);
      expect(existsSync(join(home, 'state', 'hq.lock'))).toBe(true);
      expect(Number(readFileSync(join(home, 'state', 'hq.lock'), 'utf8'))).toBe(hq.child.pid);
    }
    expect(acked.size).toBeGreaterThan(50);
  }, 120_000);
});
