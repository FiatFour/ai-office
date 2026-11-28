import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandKind } from '@agent-works/core';
import { WebSocket, WebSocketServer } from 'ws';
import { type Asset, readAsset } from './assets.ts';
import { BlockedLog, InvalidAttempt, parseAttempt, renderBlocked } from './blocked.ts';
import { clearRuntime, hqIdFor, VERSION, writeRuntime } from './config.ts';
import { InvalidEvent, parseEvent } from './events.ts';
import { Ledger } from './ledger.ts';
import type { HqPort, ModeFactory } from './modes/cages.ts';
import type { Preflight } from './preflight/report.ts';
import { Registry, RegistryError } from './registry.ts';
import type { SandboxDriver } from './sandbox/container.ts';
import { DEFAULT_ALLOWLIST, type Denial as RawDenial } from './sandbox/firewall.ts';
import { firewallCount } from './snapshot/firewall.ts';
import { type Denial, outboxSummary, type Snapshot } from './snapshot.ts';
import type { OutboxEntry } from './store/store.ts';
import { Store, StoreLockedError } from './store/store.ts';

export { StoreLockedError };

export type Executor = (entry: OutboxEntry) => Promise<void>;

export interface HqOptions {
  readonly home: string;
  readonly port: number;
  readonly host?: string;
  readonly makeDriver?: (hq: string, onDenial: (denial: RawDenial) => void) => Promise<SandboxDriver | null>;
  readonly executors?: Partial<Record<CommandKind, Executor>>;
  /** The project allowlist the driver starts with. */
  readonly allowlist?: readonly string[];
  readonly mode?: ModeFactory;
  readonly assets?: string;
  readonly readOnly?: string;
  readonly preflight?: Preflight;
}

export interface RunningHq {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  readonly snapshot: () => Snapshot;
  readonly stopped: Promise<void>;
  readonly close: () => Promise<void>;
}

const MAX_BODY = 1024 * 1024;
const MAX_DENIALS = 50;
const DASHBOARD = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'dashboard.html'));

const sha256 = (text: string): string => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const inlineOf = (tag: string): string =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(DASHBOARD.toString('utf8'))?.[1] ?? '';
const SOCKETS = 'ws://127.0.0.1:* ws://localhost:*';
const POLICY = (script: string, style: string): string =>
  `default-src 'self'; script-src ${script}; style-src ${style}; img-src 'self' data:; font-src 'self'; connect-src 'self' ${SOCKETS}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const FLOOR_POLICY = POLICY("'self'", "'self'");
const DASHBOARD_POLICY = POLICY(`'self' ${sha256(inlineOf('script'))}`, `'self' ${sha256(inlineOf('style'))}`);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'expected an object');
  return value as Record<string, unknown>;
};

const field = (o: Record<string, unknown>, key: string): string => {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `${key} must be a non-empty string`);
  return v;
};

export const startHq = async (options: HqOptions): Promise<RunningHq> => {
  const { home, port: wantedPort } = options;
  const host = options.host ?? '127.0.0.1';
  const startedAt = Date.now();
  const store = Store.open(join(home, 'state'));
  const ledger = new Ledger(store);
  const registry = new Registry(home);
  const hqId = hqIdFor(home);
  const denials = new Map<string, Denial>();
  const blocked = new BlockedLog();
  let denialPush: NodeJS.Timeout | null = null;
  let mode: ReturnType<ModeFactory> | null = null;

  const noteDenial = (raw: RawDenial): void => {
    mode?.noteDenial(raw);
    try {
      const attempt = parseAttempt(
        {
          worker: raw.agent,
          tool: `CONNECT ${raw.host}:${raw.port}`,
          detail: raw.reason === '' ? 'denied by the egress proxy' : raw.reason,
          layer: 'F2',
        },
        Date.now(),
      );
      blocked.record(attempt);
    } catch (error) {
      if (!(error instanceof InvalidAttempt)) throw error;
    }
    const key = `${raw.agent}|${raw.host}|${raw.port}|${raw.reason}`;
    const seen = denials.get(key);
    denials.set(key, { ...raw, count: (seen?.count ?? 0) + 1, lastAt: raw.at });
    if (denials.size > MAX_DENIALS) denials.delete(denials.keys().next().value as string);
    // At most one push in 250 ms, sent at its end, so the last denial of a burst is never left unsent.
    denialPush ??= setTimeout(() => {
      denialPush = null;
      push();
    }, 250);
  };
  let driver: SandboxDriver | null = null;
  let driverReady: Promise<SandboxDriver | null> | null = null;
  const getDriver = (): Promise<SandboxDriver | null> => {
    driverReady ??= (options.makeDriver?.(hqId, noteDenial) ?? Promise.resolve(null)).then((made) => {
      driver = made;
      return made;
    });
    return driverReady;
  };

  let boundPort = wantedPort;
  const sockets = new Set<WebSocket>();

  const snapshot = (): Snapshot => ({
    rev: ledger.rev,
    pushedAt: Date.now(),
    hq: { pid: process.pid, startedAt, port: boundPort, version: VERSION },
    registry: registry.view(),
    state: ledger.state,
    outbox: outboxSummary(ledger.outbox),
    cages: driver?.list() ?? [],
    denials: [...denials.values()],
    blocked: blocked.entries(),
    firewall:
      options.makeDriver === undefined
        ? null
        : firewallCount(denials.values(), driver?.rules() ?? options.allowlist ?? DEFAULT_ALLOWLIST),
    paused: blocked.paused(),
    actions: mode?.actions() ?? [],
    mode: mode?.view() ?? null,
    host: options.preflight?.host() ?? null,
  });

  const push = (): void => {
    if (sockets.size === 0) return;
    const message = JSON.stringify(snapshot());
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
  };

  const run = async (entry: OutboxEntry): Promise<void> => {
    const executor = mode?.executors[entry.command.kind] ?? options.executors?.[entry.command.kind];
    if (executor === undefined) {
      ledger.mark(entry.id, 'skipped', 'no executor is wired for this command yet');
    } else {
      ledger.begin(entry.id);
      try {
        await executor(entry);
        ledger.mark(entry.id, 'done');
      } catch (error) {
        ledger.mark(entry.id, 'failed', (error as Error).message);
      }
    }
    push();
  };

  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      const tried = new Set<string>();
      for (;;) {
        const batch = ledger.runnable().filter((entry) => !tried.has(entry.id));
        if (batch.length === 0) break;
        for (const entry of batch) {
          tried.add(entry.id);
          await run(entry);
        }
      }
    } finally {
      draining = false;
    }
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${host}:${boundPort}`);
    const method = req.method ?? 'GET';
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const asset: Asset | null =
      method === 'GET' && options.assets !== undefined && !url.pathname.startsWith('/api/')
        ? readAsset(options.assets, url.pathname)
        : null;
    if (asset !== null) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (method === 'GET' && url.pathname === '/') {
      res.setHeader('content-security-policy', DASHBOARD_POLICY);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(DASHBOARD);
      return;
    }
    if (method === 'GET' && url.pathname === '/blocked') {
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderBlocked(blocked.entries(), blocked.paused()));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/health') {
      send(200, { ok: true, service: 'agent-works', pid: process.pid, startedAt, version: VERSION, rev: ledger.rev });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/snapshot') return send(200, snapshot());
    if (method === 'GET' && url.pathname === '/api/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return send(200, { events: store.events(Number.isFinite(after) ? after : 0) });
    }
    if (method === 'GET' && url.pathname === '/api/preflight' && options.preflight !== undefined) {
      const report = await options.preflight.run(boundPort);
      push();
      return send(200, report);
    }
    if (method === 'GET') {
      const read = mode?.route(method, url.pathname, () => readBody(req));
      if (read !== undefined) return send(200, await read);
    }
    if (options.readOnly !== undefined && method !== 'GET') throw new HttpError(403, options.readOnly);
    if (method !== 'POST' && method !== 'DELETE') throw new HttpError(404, 'not found');

    if (method === 'POST' && url.pathname === '/api/sandbox/blocked') {
      const { entry, paused } = blocked.record(parseAttempt(await readBody(req), Date.now()));
      push();
      send(200, { seq: entry.seq, repeats: entry.repeats, paused: blocked.isPaused(entry.worker), justPaused: paused });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/workers/resume') {
      const resumed = blocked.resume(field(asRecord(await readBody(req)), 'worker'));
      if (resumed) mode?.wake();
      push();
      send(200, { resumed });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/events') {
      const { rev, commands } = ledger.ingest(parseEvent(await readBody(req)));
      push();
      send(200, { rev, commands: commands.map((entry) => entry.id) });
      void drain();
      return;
    }
    if (method === 'POST' && url.pathname === '/api/factories') {
      const body = asRecord(await readBody(req));
      const name = typeof body.name === 'string' ? body.name : undefined;
      const { factory, created } = registry.addFactory(field(body, 'root'), name);
      if (created) ledger.bump();
      push();
      send(200, { factory, created, rev: ledger.rev });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/repos') {
      const body = asRecord(await readBody(req));
      const remote = typeof body.remote === 'string' ? body.remote : null;
      const { repo, changed } = registry.addRepo(field(body, 'factory'), { path: field(body, 'path'), remote });
      if (changed) ledger.bump();
      push();
      send(200, { repo, changed, rev: ledger.rev });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/cages') {
      const body = asRecord(await readBody(req));
      const active = await getDriver();
      if (active === null) throw new HttpError(503, 'no container engine is available, run agent-works doctor');
      const cage = await active.startCage({
        task: field(body, 'task'),
        worker: field(body, 'worker'),
        source: field(body, 'source'),
      });
      ledger.bump();
      push();
      send(200, cage);
      return;
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/cages/')) {
      const active = await getDriver();
      if (active === null) throw new HttpError(503, 'no container engine is available');
      const removed = await active.releaseCage(decodeURIComponent(url.pathname.slice('/api/cages/'.length)));
      if (removed) ledger.bump();
      push();
      send(removed ? 200 : 404, { removed });
      return;
    }
    const handled = mode?.route(method, url.pathname, () => readBody(req));
    if (handled !== undefined) return send(200, await handled);
    if (method === 'POST' && url.pathname === '/api/stop') {
      send(200, { stopping: true });
      setImmediate(() => void close());
      return;
    }
    throw new HttpError(404, 'not found');
  };

  const allowedHosts = (): Set<string> =>
    new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
  const sameOrigin = (req: IncomingMessage): boolean => {
    if (!allowedHosts().has(req.headers.host ?? '')) return false;
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${req.headers.host}`;
  };

  const server: Server = createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', FLOOR_POLICY);
    if (!sameOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden host or origin"}');
      return;
    }
    route(req, res).catch((error: unknown) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof InvalidEvent || error instanceof InvalidAttempt || error instanceof RegistryError
            ? 400
            : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!sameOrigin(req) || new URL(req.url ?? '/', 'http://x').pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
      ws.send(JSON.stringify(snapshot()));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wantedPort, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  boundPort = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${boundPort}`;
  writeRuntime(home, { pid: process.pid, port: boundPort, startedAt, url });

  const port: HqPort = {
    state: () => ledger.state,
    ingest: (event) => {
      ledger.ingest(parseEvent(JSON.parse(JSON.stringify(event))));
      push();
      void drain();
    },
    outbox: () => ledger.outbox,
    events: (after) => store.events(after),
    changed: push,
    paused: (worker) => blocked.isPaused(worker),
  };
  mode = options.mode?.(port) ?? null;

  let closing: Promise<void> | null = null;
  let finish: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await mode?.close();
      if (denialPush !== null) clearTimeout(denialPush);
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await (await getDriver().catch(() => null))?.removeAll().catch(() => undefined);
      clearRuntime(home, process.pid);
      store.close();
      finish();
    })();
    return closing;
  };

  if (mode !== null) {
    void getDriver().catch(() => null);
    mode.start();
  }
  void drain();
  return { url, port: boundPort, pid: process.pid, snapshot, stopped, close };
};
