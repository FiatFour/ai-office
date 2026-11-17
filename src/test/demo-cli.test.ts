import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canSpawnTs, exited, tempDir } from '../../server/test/helpers.ts';

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

  const cleanEnv = (extra: Record<string, string>) => {
    const { AGENT_WORKS_HOME: _home, ...rest } = process.env;
    const tmp = tempDir('demo-tmp');
    const home = tempDir('demo-home');
    return { tmp, home, env: { ...rest, TMPDIR: tmp, TEMP: tmp, TMP: tmp, HOME: home, USERPROFILE: home, ...extra } };
  };
  const demoDirs = (tmp: string) => readdirSync(tmp).filter((name) => name.startsWith('aw-demo-'));
  const started = async (child: ChildProcess): Promise<void> => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    for (let i = 0; i < 300 && !out.includes('Demo replay of'); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(out).toContain('Demo replay of');
  };

  it('refuses every write with 403 while it replays', async () => {
    const port = await freePort();
    const { env } = cleanEnv({ AGENT_WORKS_DEMO_INTERVAL_MS: '20' });
    const child = spawn(process.execPath, [BIN, '--demo', '--no-open', '--port', String(port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await started(child);
    const url = `http://127.0.0.1:${port}`;
    const post = (path: string) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'human', kind: 'add_worker', worker: 'mallory' }),
      });
    for (const path of ['/api/events', '/api/factories', '/api/stop', '/api/cages']) {
      const res = await post(path);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('demo mode is read-only');
    }
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    child.kill('SIGTERM');
    await exited(child);
  }, 30_000);

  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
  it.each(signals)(
    'on %s it removes its throw-away home and never touches the real one',
    async (signal) => {
      const port = await freePort();
      const { tmp, home, env } = cleanEnv({});
      const child = spawn(process.execPath, [BIN, '--demo', '--no-open', '--port', String(port)], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await started(child);
      expect(demoDirs(tmp)).toHaveLength(1);
      child.kill(signal);
      await exited(child);
      expect(demoDirs(tmp)).toEqual([]);
      expect(existsSync(join(home, '.agent-works'))).toBe(false);
      if (process.platform !== 'win32') expect(child.exitCode).toBe(0);
    },
    30_000,
  );

  it('says which line of the events file is bad and exits 2, with no stack trace and no home left behind', async () => {
    const { tmp, env } = cleanEnv({});
    const file = join(tmp, 'bad.jsonl');
    writeFileSync(file, '{"seq":1,"event":{"source":"human","kind":"add_worker","worker":"nova"}}\nnot json\n');
    const child = spawn(process.execPath, [BIN, '--demo', '--no-open', '--port', String(await freePort())], {
      env: { ...env, AGENT_WORKS_DEMO_EVENTS: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    await exited(child);
    expect(child.exitCode).toBe(2);
    expect(err).toContain('bad.jsonl line 2');
    expect(err).not.toMatch(/\n\s+at /);
    expect(demoDirs(tmp)).toEqual([]);
  }, 30_000);
});
