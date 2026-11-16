import { promises as dns } from 'node:dns';
import { once } from 'node:events';
import { connect } from 'node:net';
import { release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';

/** @typedef {{ host: string, port: number, user: string }} Proxy */
/**
 * @typedef {{ ok: true, status: number, connectStatus?: number, tunnelMs?: number, tlsMs: number, ttfbMs: number }
 *   | { ok: false, connectStatus?: number, error: string, ms: number }} HttpsResult
 */

const TIMEOUT_MS = 5000;

/** @param {string | undefined} url @returns {Proxy | null} */
export function proxyFromEnv(url) {
  if (url === undefined || url === '') return null;
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 80), user: decodeURIComponent(parsed.username) };
}

/**
 * @param {import('node:net').Socket} socket
 * @returns {Promise<string>}
 */
function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('end', () => reject(new Error(`closed before headers: ${JSON.stringify(buffer)}`)));
  });
}

/** @param {string} head */
const statusOf = (head) => Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);

/**
 * One HTTPS GET on a fresh connection, through a CONNECT proxy when one is given.
 * Times run from the first socket open: `tunnelMs` to the CONNECT reply, `tlsMs` to the TLS handshake, `ttfbMs` to the
 * first response byte.
 * @param {{ host: string, path: string, proxy: Proxy | null }} request
 * @returns {Promise<HttpsResult>}
 */
export async function httpsGet({ host, path, proxy }) {
  const start = performance.now();
  /** @type {import('node:net').Socket | undefined} */
  let raw;
  /** @type {number | undefined} */
  let connectStatus;
  /** @type {number | undefined} */
  let tunnelMs;
  const timer = setTimeout(() => raw?.destroy(new Error('timeout')), TIMEOUT_MS);
  try {
    /** @type {import('node:tls').ConnectionOptions} */
    let tlsOptions = { host, port: 443, servername: host };
    if (proxy !== null) {
      const socket = connect(proxy.port, proxy.host);
      raw = socket;
      const auth = Buffer.from(`${proxy.user}:x`).toString('base64');
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      connectStatus = statusOf(await readHead(socket));
      tunnelMs = performance.now() - start;
      if (connectStatus !== 200) {
        socket.destroy();
        return { ok: false, connectStatus, error: `CONNECT ${connectStatus}`, ms: tunnelMs };
      }
      tlsOptions = { socket, servername: host };
    }
    const tls = tlsConnect(tlsOptions);
    raw ??= tls;
    await once(tls, 'secureConnect');
    const tlsMs = performance.now() - start;
    tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: agent-works-probe\r\nConnection: close\r\n\r\n`);
    /** @type {Promise<number>} */
    const firstByte = new Promise((resolve) => tls.once('data', () => resolve(performance.now() - start)));
    const status = statusOf(await readHead(tls));
    const ttfbMs = await firstByte;
    tls.destroy();
    return {
      ok: true,
      status,
      ...(connectStatus === undefined ? {} : { connectStatus }),
      ...(tunnelMs === undefined ? {} : { tunnelMs }),
      tlsMs,
      ttfbMs,
    };
  } catch (error) {
    raw?.destroy();
    return {
      ok: false,
      ...(connectStatus === undefined ? {} : { connectStatus }),
      error: String(error),
      ms: performance.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} host @param {number} port */
export function tcpConnect(host, port) {
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: TIMEOUT_MS });
    /** @param {Record<string, unknown>} result */
    const done = (result) => {
      socket.destroy();
      resolve({ ...result, ms: performance.now() - start });
    };
    socket.once('connect', () => done({ connected: true }));
    socket.once('timeout', () => done({ connected: false, error: 'timeout' }));
    socket.once('error', (error) => done({ connected: false, error: String(error) }));
  });
}

/** @param {string} name @param {string | undefined} server */
export async function resolveName(name, server) {
  const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
  if (server !== undefined) resolver.setServers([server]);
  try {
    return { resolved: true, addresses: await resolver.resolve4(name), servers: resolver.getServers() };
  } catch (error) {
    return { resolved: false, error: String(error), servers: resolver.getServers() };
  }
}

const COMMANDS = {
  /** @param {string[]} args */
  https: ([host = '', path = '/', mode = 'proxy']) =>
    httpsGet({ host, path, proxy: mode === 'direct' ? null : proxyFromEnv(process.env.HTTPS_PROXY) }),
  /** @param {string[]} args */
  tcp: ([host = '', port = '443']) => tcpConnect(host, Number(port)),
  /** @param {string[]} args */
  dns: ([name = '', server]) => resolveName(name, server),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command = '', ...args] = process.argv.slice(2);
  if (!(command in COMMANDS)) throw new Error(`usage: probe.mjs ${Object.keys(COMMANDS).join('|')} ...`);
  console.log(
    JSON.stringify({ ...(await COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)](args)), kernel: release() }),
  );
}
