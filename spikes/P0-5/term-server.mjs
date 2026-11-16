import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * @typedef {'docker' | 'podman'} Engine
 * @typedef {'linux' | 'darwin' | 'win32'} HostOs
 * @typedef {{ engine: Engine, host: HostOs }} Target
 * @typedef {{ file: string, args: string[] }} Command
 * @typedef {{ type: 'input', data: string } | { type: 'resize', cols: number, rows: number }} ClientMessage
 * @typedef {{ type: 'output', data: string } | { type: 'exit', code: number }} ServerMessage
 */

export const LABEL = 'agent-works.project=P0-5';
export const SESSION = 'aw';
export const CLOSE_PTY_EXITED = 4000;
const MAX_SIZE = 1000;

/** @type {Record<Engine, Record<HostOs, string>>} */
export const ENGINES = {
  docker: { linux: 'docker', darwin: 'docker', win32: 'docker.exe' },
  podman: { linux: 'podman', darwin: 'podman', win32: 'podman.exe' },
};

const POSIX_DRIVE = /^(?:\/mnt)?\/([a-zA-Z])(\/.*)?$/;
const WINDOWS_DRIVE = /^([a-zA-Z]):[\\/]?(.*)$/;

/**
 * How the engine's daemon names a host directory. `posix` is a daemon that shares the host filesystem (Linux,
 * macOS VMs that mirror paths). `windows` is Docker Desktop or a podman machine, which take `C:\...` from
 * `docker.exe` and translate it. `wsl` is a daemon running inside a WSL 2 distro, which sees drives under `/mnt`.
 * @typedef {'posix' | 'windows' | 'wsl'} MountStyle
 */

/** @param {Target} target */
export function engineFile({ engine, host }) {
  const file = ENGINES[engine]?.[host];
  if (!file) throw new Error(`no ${engine} binary for ${host}; --engine must be docker or podman`);
  return file;
}

/** @type {Record<HostOs, MountStyle>} */
export const DEFAULT_MOUNT_STYLE = { linux: 'posix', darwin: 'posix', win32: 'windows' };

/** @param {string} hostPath */
const toWindows = (hostPath) => {
  const drive = POSIX_DRIVE.exec(hostPath);
  const windowsPath = drive ? `${drive[1]}:${drive[2] ?? '\\'}` : hostPath;
  return path.win32.resolve(windowsPath).replace(/^[a-z]:/, (letter) => letter.toUpperCase());
};

/** @type {Record<MountStyle, (hostPath: string) => string>} */
const MOUNT_SOURCE = {
  posix: (hostPath) => path.posix.resolve(hostPath),
  windows: toWindows,
  wsl: (hostPath) => {
    const drive = WINDOWS_DRIVE.exec(toWindows(hostPath));
    if (!drive) throw new Error(`bind mount source ${hostPath} is not on a drive WSL mounts under /mnt`);
    const rest = (drive[2] ?? '').replaceAll('\\', '/');
    return path.posix.join('/mnt', (drive[1] ?? '').toLowerCase(), rest);
  },
};

/**
 * @param {string} hostPath
 * @param {MountStyle} style
 */
export function mountSource(hostPath, style) {
  if (hostPath.includes(','))
    throw new Error(`bind mount source ${hostPath} contains a comma, which --mount cannot carry`);
  return MOUNT_SOURCE[style](hostPath);
}

/**
 * @param {Target} target
 * @param {{ cage: string, image: string, workspace: string, mountStyle?: MountStyle }} cage
 * @returns {Command}
 */
export function runCommand(target, { cage, image, workspace, mountStyle = DEFAULT_MOUNT_STYLE[target.host] }) {
  const mount = `type=bind,source=${mountSource(workspace, mountStyle)},target=/work,readonly`;
  return {
    file: engineFile(target),
    args: ['run', '-d', '--init', '--name', cage, '--label', LABEL, '--mount', mount, image],
  };
}

/**
 * @param {Target} target
 * @param {{ cage: string, session: string }} attach
 * @returns {Command}
 */
export function attachCommand(target, { cage, session }) {
  return {
    file: engineFile(target),
    args: ['exec', '-it', cage, 'tmux', '-u', 'attach-session', '-t', session],
  };
}

/**
 * @param {string} raw
 * @returns {ClientMessage | undefined}
 */
export function parseClientMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (message?.type === 'input' && typeof message.data === 'string') return message;
  const isSize = (/** @type {unknown} */ n) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= MAX_SIZE;
  if (message?.type === 'resize' && isSize(message.cols) && isSize(message.rows)) return message;
  return undefined;
}

/** @param {string | null} raw @param {number} fallback */
const initialSize = (raw, fallback) => {
  const n = Number(raw ?? Number.NaN);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), MAX_SIZE) : fallback;
};

/**
 * @param {Command} command
 * @param {{ quiet?: boolean, input?: string }} [options]
 */
function run({ file, args }, { quiet = false, input } = {}) {
  const stdio = input === undefined ? (quiet ? 'pipe' : 'inherit') : ['pipe', 'inherit', 'inherit'];
  const result = spawnSync(file, args, { stdio: /** @type {any} */ (stdio), input });
  return result.status === 0;
}

/** @param {() => boolean} probe */
async function waitFor(probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the cage tmux session');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * @param {{ port: number, attach: Command, assets: Record<string, [string, string]> }} options
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function serveTerminal({ port, attach, assets }) {
  const { spawn: spawnPty } = await import('@lydell/node-pty');
  const { WebSocketServer } = await import('ws');
  /** @type {string[]} */
  let ownHosts = [];
  const isOwnHost = (/** @type {string | undefined} */ host) => ownHosts.includes(host ?? '');
  const server = createServer((req, res) => {
    if (!isOwnHost(req.headers.host)) return res.writeHead(403).end();
    const asset = assets[new URL(req.url ?? '/', 'http://localhost').pathname];
    if (!asset) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': asset[1] }).end(readFileSync(asset[0]));
  });

  /** @type {Set<import('@lydell/node-pty').IPty>} */
  const ptys = new Set();
  const wss = new WebSocketServer({
    server,
    path: '/term',
    verifyClient: (/** @type {{ origin: string, req: import('node:http').IncomingMessage }} */ { origin, req }) =>
      isOwnHost(req.headers.host) && ownHosts.some((host) => origin === `http://${host}`),
  });
  wss.on('connection', (ws, req) => {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const pty = spawnPty(attach.file, attach.args, {
      name: 'xterm-256color',
      cols: initialSize(query.get('cols'), 80),
      rows: initialSize(query.get('rows'), 24),
      env: process.env,
    });
    ptys.add(pty);
    const send = (/** @type {ServerMessage} */ message) => ws.send(JSON.stringify(message));
    pty.onData((data) => send({ type: 'output', data }));
    pty.onExit(({ exitCode }) => {
      ptys.delete(pty);
      // ConPTY keeps its conhost.exe alive until ClosePseudoConsole, which node-pty calls only from kill().
      if (process.platform === 'win32') pty.kill();
      if (ws.readyState !== ws.OPEN) return;
      send({ type: 'exit', code: exitCode });
      ws.close(CLOSE_PTY_EXITED, 'pty exited');
    });
    ws.on('message', (raw) => {
      const message = parseClientMessage(raw.toString());
      if (message?.type === 'input') pty.write(message.data);
      if (message?.type === 'resize') pty.resize(message.cols, message.rows);
    });
    ws.on('close', () => {
      if (ptys.delete(pty)) pty.kill();
    });
  });

  await once(server.listen(port, '127.0.0.1'), 'listening');
  const { port: bound } = /** @type {import('node:net').AddressInfo} */ (server.address());
  ownHosts = [`127.0.0.1:${bound}`, `localhost:${bound}`];
  return {
    url: `http://${ownHosts[0]}/`,
    close: () => {
      for (const pty of ptys) pty.kill();
      wss.close();
      server.close();
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string', default: 'docker' },
      port: { type: 'string', default: '7681' },
      cage: { type: 'string', default: 'aw-p0-5' },
      image: { type: 'string', default: 'agent-works-p0-5-cage' },
      'mount-style': { type: 'string' },
    },
  });
  const target = /** @type {Target} */ ({ engine: values.engine, host: process.platform });
  const file = engineFile(target);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { cage, image } = values;
  const mountStyle = /** @type {MountStyle} */ (values['mount-style'] ?? DEFAULT_MOUNT_STYLE[target.host]);
  if (!Object.hasOwn(MOUNT_SOURCE, mountStyle))
    throw new Error(`--mount-style must be posix, windows or wsl, got ${mountStyle}`);

  const containerfile = readFileSync(path.join(here, 'Containerfile'), 'utf8');
  if (!run({ file, args: ['build', '-t', image, '-'] }, { input: containerfile })) {
    throw new Error(`${file} build failed`);
  }
  run({ file, args: ['rm', '-f', cage] }, { quiet: true });
  if (!run(runCommand(target, { cage, image, workspace: here, mountStyle }))) throw new Error(`${file} run failed`);
  await waitFor(() => run({ file, args: ['exec', cage, 'tmux', 'has-session', '-t', SESSION] }, { quiet: true }));

  const require = createRequire(import.meta.url);
  const { url, close } = await serveTerminal({
    port: Number(values.port),
    attach: attachCommand(target, { cage, session: SESSION }),
    assets: {
      '/': [path.join(here, 'index.html'), 'text/html; charset=utf-8'],
      '/vendor/xterm.mjs': [require.resolve('@xterm/xterm/lib/xterm.mjs'), 'text/javascript'],
      '/vendor/xterm.css': [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css'],
      '/vendor/addon-fit.mjs': [require.resolve('@xterm/addon-fit/lib/addon-fit.mjs'), 'text/javascript'],
    },
  });
  const shutdown = () => {
    close();
    run({ file, args: ['rm', '-f', cage] }, { quiet: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`listening ${url} cage=${cage} engine=${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
