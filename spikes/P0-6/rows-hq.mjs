import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

/** @typedef {{ observed: string[], detail: string } | { notRun: string }} Outcome */

const P04 = fileURLToPath(new URL('../P0-4/githost.mjs', import.meta.url));
const P05 = fileURLToPath(new URL('../P0-5/', import.meta.url));
const PAGE = fileURLToPath(new URL('../P0-5/index.html', import.meta.url));

/** @param {{ port: number, host: string, path?: string }} target */
const httpStatus = ({ port, host, path = '/' }) =>
  new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });

/** @param {any} socket */
const outcomeOf = (socket) =>
  new Promise((resolve) => {
    socket.once('open', () => resolve('open'));
    socket.once('unexpected-response', (/** @type {any} */ _req, /** @type {{ statusCode?: number }} */ res) =>
      resolve(`rejected ${res.statusCode}`),
    );
    socket.once('error', () => resolve('error'));
  });

const startTerminal = async () => {
  const { serveTerminal } = await import('../P0-5/term-server.mjs');
  const require = createRequire(P05);
  /** @type {any} */
  const WebSocket = require('ws');
  const server = await serveTerminal({
    port: 0,
    attach: { file: 'cat', args: [] },
    assets: { '/': [PAGE, 'text/html'] },
  });
  const port = Number(new URL(server.url).port);
  return { server, port, WebSocket };
};

export const HQ_ROWS = {
  'term-ws-origin': {
    lane: null,
    run: async () => {
      const { server, port, WebSocket } = await startTerminal();
      try {
        const url = `ws://127.0.0.1:${port}/term`;
        const connect = async (/** @type {string} */ origin) => {
          const socket = new WebSocket(url, { headers: { origin } });
          const outcome = await outcomeOf(socket);
          socket.terminate();
          return outcome;
        };
        const evil = await connect('http://evil.example');
        const own = await connect(`http://127.0.0.1:${port}`);
        return {
          observed: evil.startsWith('rejected') && own === 'open' ? ['W1'] : [`evil=${evil}`],
          detail: `a WebSocket upgrade with Origin http://evil.example: ${evil}; with the page's own origin: ${own}`,
        };
      } finally {
        server.close();
      }
    },
  },
  'term-host-rebind': {
    lane: null,
    run: async () => {
      const { server, port } = await startTerminal();
      try {
        const rebound = await httpStatus({ port, host: `rebind.evil.example:${port}` });
        const own = await httpStatus({ port, host: `127.0.0.1:${port}` });
        return {
          observed: rebound === 403 && own === 200 ? ['W2'] : [`rebound=${rebound}`],
          detail: `GET / with Host rebind.evil.example gets ${rebound}; with Host 127.0.0.1:${port} gets ${own}`,
        };
      } finally {
        server.close();
      }
    },
  },
  'term-bind-loopback': {
    lane: null,
    run: async () => {
      const external = Object.values(networkInterfaces())
        .flat()
        .find((nic) => nic !== undefined && !nic.internal && nic.family === 'IPv4');
      if (external === undefined) return { notRun: 'this host has no non-loopback IPv4 address to connect to' };
      const { server, port } = await startTerminal();
      try {
        const outcome = await new Promise((resolve) => {
          const socket = connect({ host: external.address, port, timeout: 3000 });
          socket.once('connect', () => resolve('connected'));
          socket.once('timeout', () => resolve('timeout'));
          socket.once('error', (error) => resolve(/** @type {NodeJS.ErrnoException} */ (error).code));
          socket.on('connect', () => socket.destroy());
        });
        return {
          observed: outcome === 'ECONNREFUSED' ? ['W3'] : [`reachable=${outcome}`],
          detail: `the terminal server answered 127.0.0.1 and a connect to ${external.address}:${port} gave ${outcome}`,
        };
      } finally {
        server.close();
      }
    },
  },
  'webhook-secret-argv': {
    lane: null,
    run: () => {
      const source = readFileSync(P04, 'utf8');
      const inArgv = /`--secret=\$\{secret\}`/.test(source);
      return {
        observed: inArgv ? [] : ['stopped'],
        detail: `static check of spikes/P0-4/githost.mjs: the forwarder is started with the webhook secret as an argv entry (${inArgv}), so any process on the host can read it from the process list. Not run live, it needs the scratch repo (issue #8)`,
      };
    },
  },
};

const NOT_RUN = {
  'fw-doh':
    'needs a DNS-over-HTTPS resolver on the allowlist and a real zone the operator controls. A canary zone costs money, so it is parked in gates.md',
  'fw-rootful-podman':
    'this machine has no podman, and the P0-2 rootful lane ran in a Fedora container, not in this replay. P0-2 measured host-gateway FAIL on rootful podman',
  'fw-krun-exec':
    'this machine has no krun runtime. P0-2 measured that podman exec into a krun cage fails with "the handler does not support exec"',
  'fw-squid-sni':
    'the replay rig runs the Node proxy only. P0-2 measured that Squid 6.13 cannot read the SNI, so deny-fronting is NOT-RUN there',
  'push-base-server-side':
    'branch protection on the git host needs settings on a repo the operator owns. Not set on the scratch repo (private, free plan, no Actions)',
  'local-host-run':
    'subagents-local runs Claude Code on the operator host. A run needs a Claude login in a fresh HOME, and the only login is the operator one. Procedure in docs/threat-model.md, section "Running the local rows on the host"',
};

export const NOT_RUN_ROWS = Object.fromEntries(
  Object.entries(NOT_RUN).map(([id, reason]) => [
    id,
    { lane: id === 'push-base-server-side' ? 6 : id === 'local-host-run' ? 10 : null, run: () => ({ notRun: reason }) },
  ]),
);
