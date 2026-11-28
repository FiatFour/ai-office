import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readRuntime } from '../config.ts';
import { parseEvent } from '../events.ts';
import { type RunningHq, startHq } from '../hq.ts';
import { Ledger, MAX_ATTEMPTS } from '../ledger.ts';
import type { Preflight, PreflightReport } from '../preflight/report.ts';
import type { Snapshot } from '../snapshot.ts';
import { Store } from '../store/store.ts';
import { change, folder, hasSqlite, human, tempDir } from './helpers.ts';

const running: RunningHq[] = [];
const boot = async (
  home = tempDir('hq'),
  extra: Parameters<typeof startHq>[0] extends infer O ? Partial<O> : never = {},
) => {
  const hq = await startHq({ home, port: 0, ...extra });
  running.push(hq);
  return { hq, home };
};
afterEach(async () => {
  await Promise.all(running.splice(0).map((hq) => hq.close()));
});

interface Json {
  rev: number;
  events: Array<{ seq: number }>;
}

const call = async <T = Json>(hq: RunningHq, path: string, body?: unknown, init: RequestInit = {}) => {
  const res = await fetch(`${hq.url}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    ...init,
  });
  return { status: res.status, json: (await res.json()) as T };
};

const watch = (hq: RunningHq) =>
  new Promise<{ revs: number[]; socket: WebSocket; next: (rev: number) => Promise<Snapshot> }>((resolve) => {
    const socket = new WebSocket(`${hq.url.replace('http', 'ws')}/api/ws`);
    const revs: number[] = [];
    const waiting: Array<{ rev: number; done: (s: Snapshot) => void }> = [];
    socket.on('message', (data) => {
      const snap = JSON.parse(String(data)) as Snapshot;
      revs.push(snap.rev);
      for (const w of waiting.filter((x) => snap.rev >= x.rev)) w.done(snap);
    });
    socket.on('open', () =>
      resolve({
        revs,
        socket,
        next: (rev) =>
          new Promise((done) => ((revs.at(-1) ?? -1) >= rev ? done({} as Snapshot) : waiting.push({ rev, done }))),
      }),
    );
  });

describe.skipIf(!hasSqlite)('HQ', () => {
  it('answers health, snapshot and the dashboard on loopback', async () => {
    const { hq } = await boot();
    expect((await call(hq, '/api/health')).json).toMatchObject({ ok: true, service: 'agent-works', pid: process.pid });
    expect((await call(hq, '/api/snapshot')).json.rev).toBe(0);
    const page = await fetch(`${hq.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Agent Works HQ');
  });

  it('pushes a higher revision over the WebSocket after each registry change', async () => {
    const { hq } = await boot();
    const root = tempDir('hq-ws');
    const ws = await watch(hq);
    await ws.next(0);
    const seen: number[] = [];
    for (const name of ['one', 'two', 'three']) {
      const before = ws.revs.at(-1) ?? 0;
      const added = await call(hq, '/api/factories', { root: folder(root, name) });
      expect(added.status).toBe(200);
      await ws.next(before + 1);
      seen.push(ws.revs.at(-1) ?? 0);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(ws.revs).toEqual([0, 1, 2, 3]);
    ws.socket.close();
  });

  it('does not bump the revision when a registry change changes nothing', async () => {
    const { hq } = await boot();
    const root = folder(tempDir('hq-same'), 'f');
    await call(hq, '/api/factories', { root });
    const again = await call(hq, '/api/factories', { root });
    expect(again.json).toMatchObject({ created: false, rev: 1 });
  });

  it('reduces a valid event, rejects an invalid one and never advances on a rejection', async () => {
    const { hq } = await boot();
    const ok = await call(hq, '/api/events', human.order('acme/t1'));
    expect(ok.status).toBe(200);
    const rev = ok.json.rev as number;
    for (const bad of [
      { source: 'webhook', kind: 'change' },
      { source: 'nope' },
      [],
      { ...change(), at: 'later' },
      { ...change(), state: 'weird' },
    ]) {
      const res = await call(hq, '/api/events', bad);
      expect(res.status).toBe(400);
    }
    expect((await call(hq, '/api/snapshot')).json.rev).toBe(rev);
    const snap = (await call<Snapshot>(hq, '/api/snapshot')).json;
    expect(snap.state.boxes['acme/t1']?.state).toBe('belt');
  });

  it('refuses a webhook fact without the host time', async () => {
    const { hq } = await boot();
    const { at: _at, ...noTime } = change();
    expect((await call(hq, '/api/events', noTime)).status).toBe(400);
  });

  it('refuses a foreign Host or Origin header', async () => {
    const { hq } = await boot();
    const port = new URL(hq.url).port;
    const evil = await fetch(`${hq.url}/api/snapshot`, { headers: { origin: 'http://evil.example' } });
    expect(evil.status).toBe(403);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/snapshot', headers: { host: 'rebind.example' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(status).toBe(403);
    const refused = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${hq.url.replace('http', 'ws')}/api/ws`, {
        headers: { origin: 'http://evil.example' },
      });
      socket.on('open', () => resolve('open'));
      socket.on('error', () => resolve('refused'));
      socket.on('unexpected-response', () => resolve('refused'));
    });
    expect(refused).toBe('refused');
  });

  it('refuses a Host header with a port other than the one HQ is bound to', async () => {
    const { hq } = await boot();
    const { request } = await import('node:http');
    const statusFor = (host: string) =>
      new Promise<number>((resolve) => {
        const req = request(
          { host: '127.0.0.1', port: new URL(hq.url).port, path: '/api/snapshot', headers: { host } },
          (res) => resolve(res.statusCode ?? 0),
        );
        req.end();
      });
    expect(await statusFor(`127.0.0.1:${hq.port}`)).toBe(200);
    expect(await statusFor(`localhost:${hq.port}`)).toBe(200);
    expect(await statusFor('127.0.0.1:1')).toBe(403);
    expect(await statusFor('localhost')).toBe(403);
    expect(await statusFor(`127.0.0.1:${hq.port + 1}`)).toBe(403);
  });

  const outside = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address;

  it('serves a preflight run, puts the host it saw in the snapshot and pushes it', async () => {
    const before = { os: 'linux', label: 'Linux', shell: 'sh', arch: 'x64', kvm: false, engines: null } as const;
    let host: ReturnType<Preflight['host']> = before;
    const ports: number[] = [];
    const preflight: Preflight = {
      host: () => host,
      run: async (port) => {
        ports.push(port);
        host = { ...before, engines: [{ name: 'docker', running: false }] };
        return { checkedAt: 1, host, checks: [], canStart: false };
      },
    };
    const { hq } = await boot(tempDir('hq'), { preflight, readOnly: 'read-only' });
    expect(hq.snapshot().host).toEqual(before);
    const socket = new WebSocket(`${hq.url.replace('http', 'ws')}/api/ws`);
    const pushed: Snapshot[] = [];
    socket.on('message', (data) => pushed.push(JSON.parse(String(data)) as Snapshot));
    await expect.poll(() => pushed.length).toBe(1);
    const res = await call<PreflightReport>(hq, '/api/preflight');
    expect(res.status).toBe(200);
    expect(res.json.canStart).toBe(false);
    expect(ports).toEqual([hq.port]);
    await expect.poll(() => pushed.at(-1)?.host?.engines).toEqual([{ name: 'docker', running: false }]);
    socket.close();
    const bare = await boot();
    expect(bare.hq.snapshot().host).toBeNull();
    expect((await call(bare.hq, '/api/preflight')).status).toBe(404);
  });

  it.skipIf(outside === undefined)('listens on loopback only, so another machine cannot reach it', async () => {
    const { hq } = await boot();
    const reached = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: outside as string, port: hq.port, timeout: 2000 });
      socket.once('connect', () => resolve(true));
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => resolve(false));
      socket.on('connect', () => socket.destroy());
    });
    expect(reached).toBe(false);
  });

  it('pushes a higher revision over the WebSocket when a repo is registered', async () => {
    const { hq } = await boot();
    const root = tempDir('hq-ws-repo');
    const ws = await watch(hq);
    await ws.next(0);
    const factory = folder(root, 'f');
    await call(hq, '/api/factories', { root: factory });
    await ws.next(1);
    const added = await call(hq, '/api/repos', { factory, path: folder(root, 'clone'), remote: null });
    expect(added.json).toMatchObject({ changed: true, rev: 2 });
    await Promise.race([ws.next(2), new Promise((_, reject) => setTimeout(() => reject(new Error('no push')), 2000))]);
    expect(ws.revs.at(-1)).toBe(2);
    ws.socket.close();
  });

  it('marks commands skipped when no executor is wired and failed when one throws', async () => {
    const calls: string[] = [];
    const { hq } = await boot(undefined, {
      executors: {
        start_cage: async (entry) => {
          calls.push(entry.id);
          throw new Error('no image');
        },
      },
    });
    await call(hq, '/api/events', human.addWorker('nova'));
    await call(hq, '/api/events', human.order('acme/t1'));
    await call(hq, '/api/events', human.hire('acme/t1', 'nova'));
    await new Promise((r) => setTimeout(r, 100));
    const snap = (await call<Snapshot>(hq, '/api/snapshot')).json;
    expect(calls).toHaveLength(1);
    expect(snap.outbox.failed.map((e) => e.error)).toEqual(['no image']);
  });

  it('writes hq.json for the running HQ and clears it on close', async () => {
    const { hq, home } = await boot();
    expect(readRuntime(home)).toMatchObject({ pid: process.pid, port: hq.port });
    await hq.close();
    expect(existsSync(join(home, 'hq.json'))).toBe(false);
  });

  it('serves the event log for replay', async () => {
    const { hq } = await boot();
    await call(hq, '/api/events', human.order('acme/t1'));
    await call(hq, '/api/events', human.order('acme/t2'));
    const log = (await call(hq, '/api/events?after=1')).json.events as Array<{ seq: number }>;
    expect(log.map((e) => e.seq)).toEqual([2]);
  });

  it('keeps its revision across a restart', async () => {
    const { hq, home } = await boot();
    await call(hq, '/api/events', human.order('acme/t1'));
    const rev = hq.snapshot().rev;
    await hq.close();
    const again = await startHq({ home, port: 0 });
    running.push(again);
    expect(again.snapshot().rev).toBeGreaterThanOrEqual(rev);
    expect(again.snapshot().state.boxes['acme/t1']?.state).toBe('belt');
  });

  it('pushes an ingested event to every open socket, not only the first', async () => {
    const { hq } = await boot();
    const sockets = [await watch(hq), await watch(hq), await watch(hq)];
    for (const ws of sockets) await ws.next(0);
    const posted = await call(hq, '/api/events', human.order('acme/t1'));
    expect(posted.status).toBe(200);
    const rev = posted.json.rev as number;
    for (const ws of sockets)
      await Promise.race([
        ws.next(rev),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no push')), 2000)),
      ]);
    for (const ws of sockets) {
      expect(ws.revs.at(-1)).toBe(rev);
      ws.socket.close();
    }
  });

  it('upgrades only /api/ws', async () => {
    const { hq } = await boot();
    const verdict = (path: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`${hq.url.replace('http', 'ws')}${path}`);
        socket.on('open', () => {
          socket.close();
          resolve('open');
        });
        socket.on('error', () => resolve('refused'));
        socket.on('unexpected-response', () => resolve('refused'));
      });
    expect(await verdict('/api/ws')).toBe('open');
    expect(await verdict('/')).toBe('refused');
    expect(await verdict('/api/other')).toBe('refused');
    expect(await verdict('/api/ws/extra')).toBe('refused');
  });

  it('runs the commands a crash left pending as soon as it boots, with no new event', async () => {
    const home = tempDir('hq-boot-drain');
    const store = Store.open(join(home, 'state'));
    const ledger = new Ledger(store);
    for (const event of [human.addWorker('nova'), human.order('acme/t1'), human.hire('acme/t1', 'nova')])
      ledger.ingest(parseEvent(event));
    const [left] = ledger.pending();
    expect(left?.command.kind).toBe('start_cage');
    store.close();
    const seen: string[] = [];
    const { hq } = await boot(home, {
      executors: {
        start_cage: async (entry) => {
          seen.push(entry.id);
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([left?.id]);
    expect(hq.snapshot().outbox.pending).toBe(0);
  });

  it('retries a failed command on later drains, then stops and keeps the reason', async () => {
    const calls: string[] = [];
    const { hq } = await boot(undefined, {
      executors: {
        start_cage: async (entry) => {
          calls.push(entry.id);
          throw new Error('no image');
        },
      },
    });
    await call(hq, '/api/events', human.addWorker('nova'));
    await call(hq, '/api/events', human.order('acme/t1'));
    await call(hq, '/api/events', human.hire('acme/t1', 'nova'));
    for (let round = 0; round < MAX_ATTEMPTS + 2; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await call(hq, '/api/events', human.addWorker(`filler${round}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    const failed = hq.snapshot().outbox.failed;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ attempts: MAX_ATTEMPTS });
    expect(failed[0]?.error).toContain('gave up after');
  });
});
