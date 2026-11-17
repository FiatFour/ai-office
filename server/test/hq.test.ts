import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readRuntime } from '../config.ts';
import { type RunningHq, startHq } from '../hq.ts';
import type { Snapshot } from '../snapshot.ts';
import { change, folder, human, tempDir } from './helpers.ts';

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

describe('HQ', () => {
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
});
