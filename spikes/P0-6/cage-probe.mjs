import { once } from 'node:events';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 5000;
const EXT_ECH = 0xfe0d;

/** @param {string | undefined} url */
const proxyFromEnv = (url) => {
  if (url === undefined || url === '') throw new Error('HTTPS_PROXY is not set');
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 80), user: decodeURIComponent(parsed.username) };
};

/** @param {import('node:net').Socket} socket */
const readHead = (socket) =>
  new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error(`closed before headers: ${JSON.stringify(buffer)}`)));
  });

/** @param {string} host */
async function openTunnel(host) {
  const proxy = proxyFromEnv(process.env.HTTPS_PROXY);
  const socket = connect(proxy.port, proxy.host);
  const auth = Buffer.from(`${proxy.user}:x`).toString('base64');
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  const head = String(await readHead(socket));
  return { socket, connectStatus: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0) };
}

/** @param {number} type @param {Buffer} data */
const extension = (type, data) => {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
};

/** @param {string} name */
const serverName = (name) => {
  const bytes = Buffer.from(name);
  const entry = Buffer.alloc(3);
  entry.writeUInt16BE(bytes.length, 1);
  const list = Buffer.concat([entry, bytes]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(list.length);
  return extension(0, Buffer.concat([length, list]));
};

/** @param {Buffer[]} extensions */
const clientHello = (extensions) => {
  const exts = Buffer.concat(extensions);
  const extLength = Buffer.alloc(2);
  extLength.writeUInt16BE(exts.length);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    extLength,
    exts,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0, 0, 0]), body]);
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.from([22, 3, 1, 0, 0]);
  record.writeUInt16BE(handshake.length, 3);
  return Buffer.concat([record, handshake]);
};

/** @param {string} host */
async function ech(host) {
  const { socket, connectStatus } = await openTunnel(host);
  if (connectStatus !== 200) return { connectStatus, tunnelOpen: false, answered: false };
  socket.write(clientHello([serverName(host), extension(EXT_ECH, Buffer.alloc(8))]));
  const outcome = await Promise.race([
    once(socket, 'data').then(() => 'answered'),
    once(socket, 'close').then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('silent'), 3000)),
  ]);
  socket.destroy();
  return { connectStatus, tunnelOpen: true, answered: outcome === 'answered', outcome };
}

/** @param {string} host @param {string} inner */
async function hostHeader(host, inner) {
  const { socket, connectStatus } = await openTunnel(host);
  if (connectStatus !== 200) return { connectStatus, status: 0 };
  const tls = tlsConnect({ socket, servername: host });
  await once(tls, 'secureConnect');
  tls.write(`GET / HTTP/1.1\r\nHost: ${inner}\r\nUser-Agent: agent-works-probe\r\nConnection: close\r\n\r\n`);
  const head = String(await readHead(tls));
  tls.destroy();
  return {
    connectStatus,
    status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0),
    server: /server: (.*)/i.exec(head)?.[1],
  };
}

const COMMANDS = {
  /** @param {string[]} args */
  ech: ([host = '']) => ech(host),
  /** @param {string[]} args */
  hosthdr: ([host = '', inner = '']) => hostHeader(host, inner),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command = '', ...args] = process.argv.slice(2);
  if (!(command in COMMANDS)) throw new Error(`usage: cage-probe.mjs ${Object.keys(COMMANDS).join('|')} ...`);
  try {
    console.log(JSON.stringify(await COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)](args)));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
  }
}
