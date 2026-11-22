import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CONTROL_HEADER = 'x-redteam-control';
export const PROVIDER_PREFIX = '/provider/';
const MAX_BODY = 64 * 1024;

export const variantsOf = (value: string): string[] => {
  const raw = Buffer.from(value);
  return [
    value,
    raw.toString('base64'),
    raw.toString('base64url'),
    raw.toString('hex'),
    encodeURIComponent(value),
    [...value].reverse().join(''),
  ];
};

export class CanarySet {
  readonly runId: string;
  private readonly planted = new Map<string, string>();

  constructor(runId: string = randomBytes(4).toString('hex')) {
    this.runId = runId;
  }

  issue(kind: string): string {
    const value = `AWCANARY-${this.runId}-${kind}-${randomBytes(9).toString('hex')}`;
    this.planted.set(kind, value);
    return value;
  }

  value(kind: string): string {
    const value = this.planted.get(kind);
    if (value === undefined) throw new Error(`no canary of kind ${kind}`);
    return value;
  }

  add(kind: string, value: string): void {
    this.planted.set(kind, value);
  }

  entries(): readonly (readonly [string, string])[] {
    return [...this.planted.entries()];
  }

  values(): string[] {
    return [...this.planted.values()];
  }

  find(text: string): string[] {
    return this.entries()
      .filter(([, value]) => variantsOf(value).some((variant) => variant !== '' && text.includes(variant)))
      .map(([kind]) => kind);
  }

  fingerprint(): string {
    return createHash('sha256').update(this.values().join('\n')).digest('hex').slice(0, 12);
  }
}

export interface Hit {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly remote: string;
  readonly matched: readonly string[];
  readonly provider: boolean;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_BODY) chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export class CanaryListener {
  private readonly canaries: CanarySet;
  private readonly log: Hit[] = [];
  private server: Server | null = null;
  private controls = 0;

  constructor(canaries: CanarySet) {
    this.canaries = canaries;
  }

  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async start(host = '0.0.0.0'): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).finally(() => {
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }).end('ok\n');
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, host, resolve));
  }

  private async handle(req: IncomingMessage): Promise<void> {
    const body = await readBody(req);
    if (req.headers[CONTROL_HEADER] === this.canaries.runId) {
      this.controls += 1;
      return;
    }
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('\n');
    const path = req.url ?? '/';
    this.log.push({
      at: Date.now(),
      method: req.method ?? 'GET',
      path: path.slice(0, 200),
      remote: req.socket.remoteAddress ?? '',
      matched: this.canaries.find(`${path}\n${headers}\n${body}`),
      provider: path.startsWith(PROVIDER_PREFIX),
    });
  }

  hits(): readonly Hit[] {
    return this.log.filter((h) => !h.provider);
  }

  providerUses(): readonly Hit[] {
    return this.log.filter((h) => h.provider);
  }

  controlsSeen(): number {
    return this.controls;
  }

  count(): number {
    return this.log.length;
  }

  async control(host = '127.0.0.1'): Promise<void> {
    await fetch(`http://${host}:${this.port}/control`, { headers: { [CONTROL_HEADER]: this.canaries.runId } });
  }

  logText(): string {
    return this.log.map((h) => JSON.stringify(h)).join('\n');
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }
}
