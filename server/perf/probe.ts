import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const BIN = fileURLToPath(new URL('../../bin/agent-works.ts', import.meta.url));
const COLD_MEDIAN_LIMIT_MS = 2000;
const PUSH_P95_LIMIT_MS = 100;

export interface Stats {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

export const stats = (samples: readonly number[]): Stats => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? Number.NaN;
  const middle = sorted.length / 2;
  const median =
    sorted.length % 2 === 1
      ? (sorted[Math.floor(middle)] ?? Number.NaN)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, median, p95: at(0.95), max: sorted.at(-1) ?? Number.NaN };
};

const now = (): number => Number(process.hrtime.bigint()) / 1e6;

interface Booted {
  readonly url: string;
  readonly coldMs: number;
  readonly stop: () => Promise<void>;
}

const firstSnapshot = (url: string, deadline: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const attempt = () => {
      if (now() > deadline) return reject(new Error('HQ gave no snapshot in time'));
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/ws`);
      socket.once('message', () => resolve(socket));
      socket.once('error', () => setTimeout(attempt, 10));
    };
    attempt();
  });

const bootHq = async (home: string, port: number): Promise<Booted & { socket: WebSocket }> => {
  const started = now();
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'serve', '--port', String(port), '--home', home], {
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const socket = await firstSnapshot(url, started + 30_000);
  const coldMs = now() - started;
  const stop = async () => {
    socket.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  };
  return { url, coldMs, stop, socket };
};

const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
};

export const coldStarts = async (count: number): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const home = mkdtempSync(join(tmpdir(), 'aw-cold-'));
    const hq = await bootHq(home, await freePort());
    out.push(hq.coldMs);
    await hq.stop();
    rmSync(home, { recursive: true, force: true });
  }
  return out;
};

export const pushLatencies = async (changes: number): Promise<{ client: number[]; server: number[] }> => {
  const home = mkdtempSync(join(tmpdir(), 'aw-push-'));
  const factories = realpathSync(mkdtempSync(join(tmpdir(), 'aw-push-f-')));
  const hq = await bootHq(home, await freePort());
  const client: number[] = [];
  const server: number[] = [];
  let sentAt = 0;
  let wanted = 0;
  let resolveNext: (() => void) | null = null;
  hq.socket.on('message', (data) => {
    const received = now();
    const received_wall = Date.now();
    const snapshot = JSON.parse(String(data)) as { rev: number; pushedAt: number };
    if (snapshot.rev >= wanted && resolveNext !== null) {
      client.push(received - sentAt);
      server.push(Math.max(0, received_wall - snapshot.pushedAt));
      const done = resolveNext;
      resolveNext = null;
      done();
    }
  });
  for (let i = 0; i < changes; i += 1) {
    const root = join(factories, `f${i}`);
    mkdirSync(root);
    const pushed = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    wanted = i + 1;
    sentAt = now();
    const res = await fetch(`${hq.url}/api/factories`, { method: 'POST', body: JSON.stringify({ root }) });
    if (!res.ok) throw new Error(`factory ${i} failed: ${res.status}`);
    await pushed;
  }
  await hq.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(factories, { recursive: true, force: true });
  return { client, server };
};

const fmt = (s: Stats): string =>
  `n=${s.n} min=${s.min.toFixed(1)} median=${s.median.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)} ms`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name: string, fallback: number) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : Number(process.argv[at + 1]);
  };
  const wantedCold = arg('cold', 10);
  const wantedChanges = arg('changes', 500);
  const cold = stats(await coldStarts(wantedCold));
  console.log(`cold start to first snapshot (measured): ${fmt(cold)}`);
  const push = await pushLatencies(wantedChanges);
  const client = stats(push.client);
  console.log(`registry change to pushed revision, client clock (measured): ${fmt(client)}`);
  console.log(`server push to client receive, same host wall clock (measured): ${fmt(stats(push.server))}`);
  console.log('baseline: none, trunk empty');
  const complete = cold.n === wantedCold && client.n === wantedChanges;
  const failed = !complete || !(cold.median <= COLD_MEDIAN_LIMIT_MS) || !(client.p95 <= PUSH_P95_LIMIT_MS);
  console.log(
    `rule: cold median <= ${COLD_MEDIAN_LIMIT_MS} ms and push p95 <= ${PUSH_P95_LIMIT_MS} ms: ${failed ? 'FAIL' : 'PASS'}`,
  );
  process.exit(failed ? 1 : 0);
}
