import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { signatureValid } from '../../server/githost/host.ts';
import { runBinary } from '../../server/sandbox/engine.ts';
import type { Payload } from './githost.contract.ts';

export interface Deliveries {
  readonly payloads: Payload[];
  rejected: number;
  stop(): Promise<void>;
}

const EVENTS = 'push,pull_request,pull_request_review,pull_request_review_comment';

const readyOf = (forwarder: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    const seen = (chunk: Buffer) => {
      if (chunk.toString().includes('Forwarding Webhook events')) resolve();
    };
    forwarder.stdout?.on('data', seen);
    forwarder.stderr?.on('data', seen);
    forwarder.on('exit', (code) => reject(new Error(`gh webhook forward exited ${code}`)));
  });

export const forwardDeliveries = async (repo: string): Promise<Deliveries> => {
  const secret = randomBytes(16).toString('hex');
  const payloads: Payload[] = [];
  const state = { rejected: 0 };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const header = request.headers['x-hub-signature-256'];
      if (!signatureValid(secret, raw, typeof header === 'string' ? header : undefined)) {
        state.rejected += 1;
        response.writeHead(401).end();
        return;
      }
      const event = String(request.headers['x-github-event'] ?? '');
      payloads.push({
        name: `github/live/${payloads.length + 1}-${event}`,
        host: 'github',
        event,
        body: JSON.parse(raw.toString('utf8')) as Record<string, unknown>,
      });
      response.writeHead(202).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const forwarder = spawn(
    'gh',
    [
      'webhook',
      'forward',
      `--repo=${repo}`,
      `--events=${EVENTS}`,
      `--url=http://127.0.0.1:${port}/`,
      `--secret=${secret}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
  );
  const exited = once(forwarder, 'exit');
  await readyOf(forwarder).catch(async (error: unknown) => {
    server.close();
    throw error;
  });
  let stopping: Promise<void> | undefined;
  return {
    payloads,
    get rejected() {
      return state.rejected;
    },
    stop: () => {
      stopping ??= (async () => {
        if (forwarder.exitCode === null && forwarder.signalCode === null) {
          if (forwarder.pid !== undefined && process.platform !== 'win32') process.kill(-forwarder.pid, 'SIGINT');
          else forwarder.kill('SIGINT');
        }
        await exited;
        server.closeAllConnections();
        server.close();
      })();
      return stopping;
    },
  } as Deliveries;
};

export const tidy = async (repo: string, branches: readonly string[]): Promise<string[]> => {
  const left: string[] = [];
  const owner = repo.split('/')[0] ?? '';
  const gh = (args: string[]) => runBinary('gh', ['api', ...args], { timeoutMs: 60_000 });
  for (const branch of branches) {
    const found = await gh([`repos/${repo}/pulls?state=open&head=${owner}:${branch}`, '--jq', '.[].number']);
    for (const number of found.out.split('\n').filter(Boolean)) {
      const closed = await gh([`repos/${repo}/pulls/${number}`, '-X', 'PATCH', '-f', 'state=closed']);
      if (closed.code !== 0) left.push(`PR ${number}: ${closed.err.trim()}`);
    }
    const removed = await gh([`repos/${repo}/git/refs/heads/${branch}`, '-X', 'DELETE']);
    if (removed.code !== 0 && !/Reference does not exist|404/.test(removed.err + removed.out))
      left.push(`${branch}: ${removed.err.trim()}`);
  }
  return left;
};
