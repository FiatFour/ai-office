import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isAllowed, parseAllowlist, parseConnectTarget } from './allowlist.mjs';

/** @typedef {{ host: string, port: number, agent: string, method: string, ts: string }} DenyEvent */

/** @param {string | undefined} header */
function agentFrom(header) {
  const encoded = /^Basic\s+(\S+)$/i.exec(header ?? '')?.[1];
  const user = encoded === undefined ? '' : Buffer.from(encoded, 'base64').toString().split(':')[0];
  return user || 'unknown';
}

/**
 * Allowlist CONNECT proxy. It re-reads the allowlist file on every request, so an edit takes effect without a restart.
 * It denies every non-CONNECT request, because cages reach the outside only over TLS.
 * @param {{ port: number, allowlistPath: string, denyUrl?: string | undefined, host?: string }} options
 */
export function startProxy({ port, allowlistPath, denyUrl, host = '0.0.0.0' }) {
  /** @param {DenyEvent} event */
  const reportDeny = (event) => {
    console.log(JSON.stringify({ deny: event }));
    if (denyUrl === undefined) return;
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
    const rules = await readFile(allowlistPath, 'utf8')
      .then(parseAllowlist)
      .catch((error) => {
        console.error(`allowlist unreadable, denying all: ${error}`);
        return [];
      });
    if (target === null || !isAllowed(rules, target.host, target.port)) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      reportDeny({
        host: target?.host ?? req.url ?? '',
        port: target?.port ?? 0,
        agent,
        method: 'CONNECT',
        ts: new Date().toISOString(),
      });
      return;
    }
    const upstream = connect(target.port, target.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
    client.on('close', () => upstream.destroy());
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
