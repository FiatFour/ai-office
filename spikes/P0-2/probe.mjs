import { promises as dns } from 'node:dns';
import { once } from 'node:events';
import { connect } from 'node:net';
import { release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
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
 * Sends CONNECT on an open proxy socket. `rest` is whatever the far end sent in the same read as the reply.
 * @param {import('node:net').Socket} socket
 * @param {Proxy} proxy
 * @param {string} target
 */
async function sendConnect(socket, proxy, target) {
  const auth = Buffer.from(`${proxy.user}:x`).toString('base64');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  const head = await readHead(socket);
  return { connectStatus: statusOf(head), rest: head.slice(head.indexOf('\r\n\r\n') + 4) };
}

/**
 * One HTTPS GET on a fresh connection, through a CONNECT proxy when one is given.
 * `inner` is the name used for TLS and the Host header inside the tunnel, when it differs from the CONNECT host.
 * Times run from the first socket open: `tunnelMs` to the CONNECT reply, `tlsMs` to the TLS handshake, `ttfbMs` to the
 * first response byte.
 * @param {{ host: string, path: string, proxy: Proxy | null, inner?: string }} request
 * @returns {Promise<HttpsResult>}
 */
export async function httpsGet({ host, path, proxy, inner = host }) {
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
    let tlsOptions = { host, port: 443, servername: inner };
    if (proxy !== null) {
      const socket = connect(proxy.port, proxy.host);
      raw = socket;
      connectStatus = (await sendConnect(socket, proxy, `${host}:443`)).connectStatus;
      tunnelMs = performance.now() - start;
      if (connectStatus !== 200) {
        socket.destroy();
        return { ok: false, connectStatus, error: `CONNECT ${connectStatus}`, ms: tunnelMs };
      }
      tlsOptions = { socket, servername: inner };
    }
    const tls = tlsConnect(tlsOptions);
    raw ??= tls;
    await once(tls, 'secureConnect');
    const tlsMs = performance.now() - start;
    tls.write(`GET ${path} HTTP/1.1\r\nHost: ${inner}\r\nUser-Agent: agent-works-probe\r\nConnection: close\r\n\r\n`);
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

/**
 * CONNECT to `host:port` and report whether the far end speaks first, as a plain TCP service would.
 * @param {{ host: string, port: number, proxy: Proxy | null }} request
 */
export async function tunnelBanner({ host, port, proxy }) {
  if (proxy === null) throw new Error('tunnel needs HTTPS_PROXY');
  const socket = connect(proxy.port, proxy.host);
  const timer = setTimeout(() => socket.destroy(), TIMEOUT_MS);
  try {
    const { connectStatus, rest } = await sendConnect(socket, proxy, `${host}:${port}`);
    socket.pause();
    if (connectStatus !== 200) return { connectStatus, banner: '' };
    const late =
      rest === '' ? await Promise.race([once(socket.resume(), 'data'), sleep(1500, [Buffer.alloc(0)])]) : [rest];
    return { connectStatus, banner: String(late[0]) };
  } catch (error) {
    return { connectStatus: undefined, banner: '', error: String(error) };
  } finally {
    clearTimeout(timer);
    socket.destroy();
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
  front: ([host = '', inner = '', path = '/']) =>
    httpsGet({ host, path, proxy: proxyFromEnv(process.env.HTTPS_PROXY), inner }),
  /** @param {string[]} args */
  tunnel: ([host = '', port = '443']) =>
    tunnelBanner({ host, port: Number(port), proxy: proxyFromEnv(process.env.HTTPS_PROXY) }),
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
