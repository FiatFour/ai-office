import { promises as dns } from 'node:dns';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isPublicAddress } from './address.mjs';
import { isAllowed, normalizeHost, parseAllowlist, parseConnectTarget } from './allowlist.mjs';
import { parseClientHello } from './tls-hello.mjs';

/** @typedef {{ host: string, port: number, agent: string, method: string, reason?: string, ts: string }} DenyEvent */

/** @param {string | undefined} header */
function agentFrom(header) {
  const encoded = /^Basic\s+(\S+)$/i.exec(header ?? '')?.[1];
  const user = encoded === undefined ? '' : Buffer.from(encoded, 'base64').toString().split(':')[0];
  return user || 'unknown';
}

const CONNECT_TIMEOUT_MS = 5000;
const HELLO_TIMEOUT_MS = 5000;
const MAX_HELLO_BYTES = 70000;
const DENY_EVENTS_PER_SECOND = 20;

/** @param {import('node:stream').Duplex} client @param {Buffer} head */
function readClientHello(client, head) {
  return new Promise((resolve) => {
    let buffered = head;
    /** @param {{ kind: string, sni?: string | null, ech?: boolean }} result */
    const finish = (result) => {
      clearTimeout(timer);
      client.off('data', onData);
      client.off('close', onClose);
      client.pause();
      resolve({ ...result, buffered });
    };
    const check = () => {
      const parsed = parseClientHello(buffered);
      if (parsed.kind !== 'need-more') finish(parsed);
      else if (buffered.length > MAX_HELLO_BYTES) finish({ kind: 'invalid' });
    };
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      check();
    };
    const onClose = () => finish({ kind: 'closed' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), HELLO_TIMEOUT_MS);
    client.on('data', onData);
    client.once('close', onClose);
    if (buffered.length > 0) check();
  });
}

/**
 * Why a ClientHello may not go through a tunnel opened for `host`, or null when it may.
 * Missing SNI and ECH are refused: without a readable SNI the name the cage reaches is unverifiable.
 * @param {{ kind: string, sni?: string | null, ech?: boolean }} hello
 * @param {string} host
 */
function helloDenial(hello, host) {
  if (hello.kind === 'timeout') return { reason: 'no-client-hello' };
  if (hello.kind !== 'hello') return { reason: 'not-tls' };
  if (hello.ech) return { reason: 'ech' };
  if (hello.sni === null || hello.sni === undefined) return { reason: 'no-sni' };
  const sni = normalizeHost(hello.sni);
  return sni === host ? null : { reason: 'sni-mismatch', host: sni };
}

/**
 * Allowlist CONNECT proxy. It re-reads the allowlist file on every request, so an edit takes effect without a restart.
 * It denies every non-CONNECT request, because cages reach the outside only over TLS.
 * Before it answers 200 it resolves the name once, refuses any non-public address, and dials the address it checked.
 * After the 200 it reads the first TLS record and closes unless the ClientHello's SNI equals the CONNECT host.
 * @param {{
 *   port: number, allowlistPath: string, denyUrl?: string | undefined, host?: string,
 *   lookup?: (host: string) => Promise<Array<{ address: string, family: number }>>,
 *   dial?: (options: { host: string, port: number, family: number }) => import('node:net').Socket,
 *   denyEventsPerSecond?: number,
 *   connectTimeoutMs?: number,
 * }} options
 */
export function startProxy({
  port,
  allowlistPath,
  denyUrl,
  host = '0.0.0.0',
  lookup = (name) => dns.lookup(name, { all: true }),
  dial = connect,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  denyEventsPerSecond = DENY_EVENTS_PER_SECOND,
}) {
  let windowStart = 0;
  let posted = 0;
  /** @param {DenyEvent} event */
  const reportDeny = (event) => {
    console.log(JSON.stringify({ deny: event }));
    if (denyUrl === undefined) return;
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      posted = 0;
    }
    if (posted >= denyEventsPerSecond) return;
    posted += 1;
    fetch(denyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }).catch((error) => console.error(`deny report failed: ${error}`));
  };

  const server = createServer((req, res) => {
    const target = URL.canParse(req.url ?? '') ? new URL(req.url ?? '') : null;
    reportDeny({
      host: target?.hostname ?? '',
      port: Number(target?.port || 80),
      agent: agentFrom(req.headers['proxy-authorization']),
      method: req.method ?? '',
      ts: new Date().toISOString(),
    });
    res.writeHead(403).end();
  });

  server.on('connect', async (req, client, head) => {
    client.on('error', () => client.destroy());
    const target = parseConnectTarget(req.url ?? '');
    const agent = agentFrom(req.headers['proxy-authorization']);
    /** @param {string} deniedHost @param {number} deniedPort @param {string} reason */
    const deny = (deniedHost, deniedPort, reason) =>
      reportDeny({
        host: deniedHost,
        port: deniedPort,
        agent,
        method: 'CONNECT',
        reason,
        ts: new Date().toISOString(),
      });
    const rules = await readFile(allowlistPath, 'utf8')
      .then(parseAllowlist)
      .catch((error) => {
        console.error(`allowlist unreadable, denying all: ${error}`);
        return [];
      });
    if (target === null || !isAllowed(rules, target.host, target.port)) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      deny(target?.host ?? req.url ?? '', target?.port ?? 0, 'not-allowlisted');
      return;
    }
    const addresses = (await lookup(target.host).catch(() => [])).sort((a, b) => a.family - b.family);
    const [first] = addresses;
    if (first === undefined) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!addresses.every(({ address }) => isPublicAddress(address))) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      deny(target.host, target.port, 'non-public-address');
      return;
    }
    const upstream = dial({ host: first.address, port: target.port, family: first.family });
    let established = false;
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('connect timeout')));
    upstream.on('error', () => {
      if (established) client.destroy();
      else client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    client.on('close', () => upstream.destroy());
    upstream.once('connect', async () => {
      upstream.setTimeout(0);
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const hello = await readClientHello(client, head);
      const denial = helloDenial(hello, target.host);
      if (hello.kind === 'closed') return;
      if (denial !== null) {
        deny(denial.host ?? target.host, target.port, denial.reason);
        client.destroy();
        return;
      }
      upstream.write(hello.buffered);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  /** @type {Promise<import('node:http').Server>} */
  const listening = new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  return listening;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startProxy({
    port: Number(process.env.PORT ?? 3128),
    allowlistPath: process.env.ALLOWLIST ?? '/etc/agent-works/allowlist.txt',
    denyUrl: process.env.DENY_URL,
  });
  console.log('node-proxy listening');
}
