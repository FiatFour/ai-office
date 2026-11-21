import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARDENED_ARGS, HARDENED_ENV } from '../P0-3/git-scan.mjs';
import { hardenedGit, scanStaged } from './guard5.mjs';

/** @typedef {{ observed: string[], detail: string } | { notRun: string }} Outcome */

const P04 = fileURLToPath(new URL('../P0-4/githost.mjs', import.meta.url));
const P05 = fileURLToPath(new URL('../P0-5/', import.meta.url));
const PAGE = fileURLToPath(new URL('../P0-5/index.html', import.meta.url));
const XTERM = fileURLToPath(new URL('../P0-5/node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('./guard5.mjs', import.meta.url));

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

/** @type {Record<string, [string, string]>} */
const TERM_PATCHES = {
  'ws-origin-off': [['ownHosts.some((host) => origin === `http://', '$', '{host}`)'].join(''), 'true'],
  'host-check-off': ['if (!isOwnHost(req.headers.host)) return res.writeHead(403).end();', ''],
  'bind-all': ["server.listen(port, '127.0.0.1')", "server.listen(port, '0.0.0.0')"],
};

/**
 * The P0-5 terminal server, or for a mutation a copy of it with one check removed, in a temp directory that links the
 * spike's node_modules. The repository's own file is never edited.
 * @param {string} mutate
 */
const termServerPath = (mutate) => {
  const patch = TERM_PATCHES[mutate];
  if (patch === undefined) return fileURLToPath(new URL('../P0-5/term-server.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'aw-p0-6-term-'));
  const source = readFileSync(fileURLToPath(new URL('../P0-5/term-server.mjs', import.meta.url)), 'utf8');
  if (!source.includes(patch[0])) throw new Error(`mutation ${mutate} no longer matches term-server.mjs`);
  writeFileSync(join(dir, 'term-server.mjs'), source.replace(patch[0], patch[1]));
  symlinkSync(join(P05, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), readFileSync(join(P05, 'package.json')));
  return join(dir, 'term-server.mjs');
};

/** @param {string} mutate */
const startTerminal = async (mutate) => {
  const { serveTerminal } = await import(termServerPath(mutate));
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

const MECHANISMS = /** @type {const} */ (['fsmonitor', 'textconv', 'external']);

/**
 * A repo the way an injected agent leaves it: a staged change to a tracked file, and a `.git/config` and
 * `.gitattributes` that run a command whenever a plain git reads the repo. Each command touches its own marker file.
 * @param {string} root
 */
const hostileRepo = (root) => {
  const repo = join(root, 'repo');
  const markers = join(root, 'markers');
  mkdirSync(markers, { recursive: true });
  mkdirSync(repo);
  /** @param {string[]} args */
  const safe = (args) =>
    execFileSync(
      'git',
      [
        ...HARDENED_ARGS,
        '-c',
        'user.name=a',
        '-c',
        'user.email=a@example.test',
        '-c',
        'commit.gpgsign=false',
        '-C',
        repo,
        ...args,
      ],
      { env: { ...HARDENED_ENV, PATH: process.env.PATH ?? '' }, stdio: 'pipe' },
    );
  safe(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitattributes'), '*.ts diff=evil\n');
  safe(['add', '-A']);
  safe(['commit', '-qm', 'init']);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  safe(['add', 'a.ts']);
  const touch = (/** @type {string} */ name) => `sh -c 'touch ${join(markers, name)}' sh`;
  writeFileSync(
    join(repo, '.git', 'config'),
    `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[core]\n\tfsmonitor = ${touch('fsmonitor')}\n[diff]\n\texternal = ${touch('external')}\n[diff "evil"]\n\ttextconv = ${touch('textconv')}\n`,
  );
  const ran = () => MECHANISMS.filter((name) => existsSync(join(markers, name)));
  return { repo, ran };
};

/** @param {string} secret @param {string} body */
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export const HQ_ROWS = {
  'host-git-config-exec': {
    lane: null,
    run: (/** @type {{ mutate: string }} */ ctx) => {
      const guarded = hostileRepo(mkdtempSync(join(tmpdir(), 'aw-p0-6-hostile-guard-')));
      const control = hostileRepo(mkdtempSync(join(tmpdir(), 'aw-p0-6-hostile-control-')));
      const plain = (/** @type {string} */ cwd) => (/** @type {string[]} */ args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
      plain(control.repo)(['diff', '--cached']);
      plain(control.repo)(['diff', '--cached', '--no-ext-diff']);
      const hook = spawnSync('node', [GUARD, 'pre-commit'], { cwd: guarded.repo, encoding: 'utf8' });
      const push =
        ctx.mutate === ''
          ? spawnSync('node', [GUARD, 'pre-push', '--base', 'main'], {
              cwd: guarded.repo,
              encoding: 'utf8',
              input: `refs/heads/x ${execFileSync('git', ['-C', guarded.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()} refs/heads/x ${'0'.repeat(40)}\n`,
            }).status
          : null;
      scanStaged(ctx.mutate === 'git-hardening-off' ? plain(guarded.repo) : hardenedGit(guarded.repo));
      const ran = guarded.ran();
      const controlRan = control.ran();
      return {
        observed:
          ran.length === 0 && MECHANISMS.every((name) => controlRan.includes(name))
            ? ['HG']
            : [...ran.map((name) => `ran-${name}`), `control-ran=${controlRan.join('+')}`],
        detail: `a repo whose .git/config sets core.fsmonitor and diff.external and whose .gitattributes sets a textconv driver, each touching a marker on the host: the guard's pre-commit scan (exit ${hook.status}) and pre-push scan (exit ${push ?? 'skipped'}) ran ${ran.length} of them; a plain git diff --cached on a copy ran ${controlRan.length} of ${MECHANISMS.length} (${controlRan.join(', ')})`,
      };
    },
  },
  'webhook-forged-delivery': {
    lane: null,
    run: async (/** @type {{ mutate: string }} */ ctx) => {
      const { githubSignatureValid: real } = await import('../P0-4/githost.mjs');
      const valid = ctx.mutate === 'signature-check-off' ? () => true : real;
      const secret = 'a-per-run-secret';
      const body = Buffer.from('{"action":"opened"}');
      const accepted = {
        genuine: valid(secret, body, sign(secret, body.toString())),
        missing: valid(secret, body, undefined),
        wrongSecret: valid(secret, body, sign('another-secret', body.toString())),
        tamperedBody: valid(secret, Buffer.from('{"action":"closed"}'), sign(secret, body.toString())),
        noPrefix: valid(secret, body, sign(secret, body.toString()).slice('sha256='.length)),
      };
      const forged = [accepted.missing, accepted.wrongSecret, accepted.tamperedBody, accepted.noPrefix];
      return {
        observed:
          accepted.genuine && forged.every((ok) => ok === false)
            ? ['WH']
            : [`forged-accepted=${forged.filter(Boolean).length}`],
        detail: `the P0-4 receiver's githubSignatureValid: a genuine HMAC-SHA256 delivery is accepted (${accepted.genuine}); a missing header, a signature from another secret, a tampered body and an unprefixed digest are accepted ${JSON.stringify(forged)}. This is the receiver check, not a live webhook; the secret sits in argv until issue #8 is fixed (webhook-secret-argv)`,
      };
    },
  },
  'term-escape-osc': {
    lane: null,
    run: () => {
      if (!existsSync(XTERM))
        return { notRun: 'spikes/P0-5 has no installed @xterm/xterm, so there is nothing to inspect' };
      const bundle = readFileSync(XTERM, 'utf8');
      const page = readFileSync(PAGE, 'utf8');
      const handled = [...new Set([...bundle.matchAll(/registerOscHandler\((\d+)/g)].map((match) => match[1]))];
      const clipboard = /ClipboardAddon|addon-clipboard/.test(page);
      const links = /linkHandler/.test(page);
      return {
        notRun: `a browser is needed to see what the page does with OSC 52 (clipboard write), OSC 8 (link) and OSC 0/2 (title) from the pty. Static findings: the xterm.js 6.0.0 bundle registers OSC ${handled.join(', ')}, and 52 ${handled.includes('52') ? 'is' : 'is not'} among them; the page ${clipboard ? 'loads' : 'does not load'} a clipboard addon, so a clipboard write is ${clipboard ? 'handled' : 'dropped by the parser'}; the page ${links ? 'sets' : 'does not set'} a linkHandler, so OSC 8 links use xterm's default (a confirm prompt). Procedure: attach the terminal to a cage, run printf '\\033]52;c;%s\\a' "$(printf pwned | base64)" and printf '\\033]8;;https://example.com\\033\\\\text\\033]8;;\\033\\\\', paste the clipboard, and click the link`,
      };
    },
  },
  'term-ws-origin': {
    lane: null,
    run: async (/** @type {{ mutate: string }} */ ctx) => {
      const { server, port, WebSocket } = await startTerminal(ctx.mutate);
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
    run: async (/** @type {{ mutate: string }} */ ctx) => {
      const { server, port } = await startTerminal(ctx.mutate);
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
    run: async (/** @type {{ mutate: string }} */ ctx) => {
      const external = Object.values(networkInterfaces())
        .flat()
        .find((nic) => nic !== undefined && !nic.internal && nic.family === 'IPv4');
      if (external === undefined) return { notRun: 'this host has no non-loopback IPv4 address to connect to' };
      const { server, port } = await startTerminal(ctx.mutate);
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
  'ide-autorun-config':
    'an IDE or devcontainer on the operator host that opens the agent-written worktree executes files the agent wrote (.vscode/tasks.json with runOptions.runOn folderOpen, .devcontainer postCreateCommand, a .gitmodules url that runs a transport helper). That needs a real IDE, so the replay cannot drive it. No layer stops it, and the P0-3 guard and preflight do not open the folder (host-git-config-exec). Procedure: write a tasks.json that touches a marker on folderOpen into a worktree and open it in the IDE with Workspace Trust off',
  'hq-api-unauth-local':
    'HQ does not exist in this repository yet, only the deny stub, so there is no API to call. Spec: in subagents-local the agent runs as the operator on the host and can reach any HQ endpoint on loopback, so an unauthenticated HQ API is open to it by construction. Needs the HQ scaffold; the forged-delivery half is covered by webhook-forged-delivery',
  'local-host-run':
    'subagents-local runs Claude Code on the operator host. A run needs a Claude login in a fresh HOME, and the only login is the operator one. Procedure in docs/threat-model.md, section "Running the local rows on the host"',
};

export const NOT_RUN_ROWS = Object.fromEntries(
  Object.entries(NOT_RUN).map(([id, reason]) => [
    id,
    { lane: id === 'push-base-server-side' ? 6 : id === 'local-host-run' ? 10 : null, run: () => ({ notRun: reason }) },
  ]),
);
