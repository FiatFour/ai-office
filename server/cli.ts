import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  hqIdFor,
  imageFor,
  insideCage,
  pidAlive,
  type RuntimeFile,
  readRuntime,
  resolveHome,
} from './config.ts';
import { startHq } from './hq.ts';
import { type DoctorContext, exitCodeOf, formatChecks, type PortState, runDoctor } from './preflight/checks.ts';
import { realHostProbe } from './preflight/host.ts';
import { Registry } from './registry.ts';
import { SandboxDriver } from './sandbox/container.ts';
import { Engine, pickEngine, runBinary } from './sandbox/engine.ts';
import { StoreCorruptError, StoreLockedError } from './store/store.ts';

const BIN = fileURLToPath(new URL('../bin/agent-works.ts', import.meta.url));

export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const stdio: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

interface Parsed {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

const VALUE_FLAGS = new Set(['port', 'home', 'factory', 'remote', 'task', 'worker', 'source']);

export const parseArgs = (argv: readonly string[]): Parsed => {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const [name = '', inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags[name] = inline;
      else if (VALUE_FLAGS.has(name)) flags[name] = argv[++i] ?? '';
      else flags[name] = true;
    } else positional.push(arg);
  }
  const [command = 'open', ...rest] = positional;
  return { command, positional: rest, flags };
};

const HELP = `agent-works [open|ls|stop|doctor|add-repo|cage]

  open [--no-open] [--port N]   start or reuse HQ and register this folder as a factory (default)
  ls                            list factories and the repos each one holds
  stop                          stop HQ and remove every cage and network it made
  doctor [--json]               check this machine, one PASS, WARN, FAIL or SKIP per line
  add-repo <path> [--factory <folder>] [--remote <url>]
  cage start --task <t> --worker <w> [--source <repo>]   start one cage (HQ needs a running engine)
  cage stop <id>`;

const health = async (port: number): Promise<{ pid: number } | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { service?: string; pid?: number };
    return body.service === 'agent-works' && typeof body.pid === 'number' ? { pid: body.pid } : null;
  } catch {
    return null;
  }
};

const canBind = (port: number): Promise<boolean> =>
  new Promise((resolveBind) => {
    const probe = createServer();
    probe.once('error', () => resolveBind(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveBind(true)));
  });

export const portState = async (port: number): Promise<PortState> => {
  if (await canBind(port)) return { state: 'free' };
  const hq = await health(port);
  return hq === null ? { state: 'busy' } : { state: 'hq', pid: hq.pid };
};

export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

export const runningHq = async (home: string): Promise<RuntimeFile | null> => {
  const runtime = readRuntime(home);
  if (runtime === null || !pidAlive(runtime.pid)) return null;
  return (await health(runtime.port)) === null ? null : runtime;
};

export const ensureHq = async (
  home: string,
  wantedPort: number,
  explicitPort: boolean,
): Promise<{ runtime: RuntimeFile; reused: boolean }> => {
  const running = await runningHq(home);
  if (running !== null) {
    if (explicitPort && running.port !== wantedPort) {
      throw new CliError(
        `HQ is already running on port ${running.port}. Stop it with agent-works stop before moving it to ${wantedPort}.`,
      );
    }
    return { runtime: running, reused: true };
  }
  const state = await portState(wantedPort);
  if (state.state === 'hq') {
    throw new CliError(
      `Port ${wantedPort} is held by another HQ (pid ${state.pid}) that uses a different home. Stop it with agent-works stop from its home, or start this one on a free port with: agent-works --port <number>`,
      2,
    );
  }
  if (state.state !== 'free') {
    throw new CliError(
      `Port ${wantedPort} is busy. Another program holds it. Start HQ on a free port with: agent-works --port <number>`,
      2,
    );
  }
  mkdirSync(home, { recursive: true });
  const logPath = join(home, 'hq.log');
  const log = openSync(logPath, 'a');
  const logStart = statSync(logPath).size;
  const child = spawn(
    process.execPath,
    [...process.execArgv, BIN, 'serve', '--port', String(wantedPort), '--home', home],
    {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
      windowsHide: true,
    },
  );
  child.unref();
  closeSync(log);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const runtime = await runningHq(home);
    if (runtime !== null) return { runtime, reused: false };
    if (child.exitCode !== null) break;
    await sleep(40);
  }
  const lines = readFileSync(logPath).subarray(logStart).toString('utf8').trim().split('\n');
  throw new CliError(`HQ did not start. ${lines.slice(-8).join('\n')}\nThe full log is ${logPath}`);
};

const post = async <T = Record<string, never>>(
  runtime: RuntimeFile,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<T> => {
  const res = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'DELETE' ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const parsed = (await res.json()) as { error?: string };
  if (!res.ok) throw new CliError(parsed.error ?? `HQ answered ${res.status}`);
  return parsed as T;
};

const gitOut = async (cwd: string, args: string[]): Promise<string | null> => {
  const res = await runBinary('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], { timeoutMs: 10_000 });
  return res.code === 0 ? res.out.trim() : null;
};

export const factoryFor = async (cwd: string): Promise<{ root: string; remote: string | null; isRepo: boolean }> => {
  const top = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return { root: realpathSync(cwd), remote: null, isRepo: false };
  return { root: realpathSync(top), remote: await gitOut(top, ['remote', 'get-url', 'origin']), isRepo: true };
};

const openBrowser = (url: string): void => {
  const [bin, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(bin, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
};

export const makeDoctorContext = (env: NodeJS.ProcessEnv, home: string, port: number): DoctorContext => {
  const image = imageFor(env);
  const engineFor = (name: 'docker' | 'podman') => {
    const engine = new Engine(name, env);
    return {
      version: () => engine.version(),
      info: () => engine.info(),
      image: async (tag: string) => (await engine.run(['image', 'inspect', tag], { timeoutMs: 30_000 })).code === 0,
    };
  };
  return {
    host: realHostProbe(),
    nodeVersion: process.version,
    home,
    port,
    image,
    engines: { docker: engineFor('docker'), podman: engineFor('podman') },
    gitVersion: async () => {
      const res = await runBinary('git', ['--version'], { timeoutMs: 10_000 });
      return res.code === 0 ? res.out.trim() : null;
    },
    portState,
    exists: existsSync,
    preferred: env.AGENT_WORKS_ENGINE,
  };
};

const hqDriver =
  (env: NodeJS.ProcessEnv, home: string) =>
  async (hq: string, onDenial: ConstructorParameters<typeof SandboxDriver>[0]['onDenial']) => {
    const engine = await pickEngine(env.AGENT_WORKS_ENGINE, env);
    if (engine === null) return null;
    return new SandboxDriver({
      engine,
      home,
      hq,
      image: imageFor(env),
      ...(onDenial === undefined ? {} : { onDenial }),
      ...(env.AGENT_WORKS_PROJECT === undefined ? {} : { project: env.AGENT_WORKS_PROJECT }),
    });
  };

export const main = async (argv: readonly string[], env: NodeJS.ProcessEnv, io: Io = stdio): Promise<number> => {
  const { command, positional, flags } = parseArgs(argv);
  const home = resolve(typeof flags.home === 'string' ? flags.home : resolveHome(env));
  const explicitPort = typeof flags.port === 'string';
  const port = explicitPort ? Number(flags.port) : Number(env.AGENT_WORKS_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`${String(flags.port)} is not a port`, 2);
  const cwd = env.AGENT_WORKS_CWD ?? process.cwd();
  const notCage = (path: string): string => {
    if (insideCage(home, path))
      throw new CliError(`${path} is inside a cage, which an agent can write. Run this from your own clone.`, 2);
    return path;
  };
  if (['open', 'add-repo', 'cage'].includes(command)) notCage(cwd);

  if (command === 'help' || flags.help === true) {
    io.out(HELP);
    return 0;
  }
  if (command === 'serve') {
    const hq = await startHq({ home, port, makeDriver: hqDriver(env, home) }).catch((error: unknown) => {
      if (error instanceof StoreLockedError || error instanceof StoreCorruptError) throw new CliError(error.message, 3);
      throw error;
    });
    const quit = () => void hq.close();
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    await hq.stopped;
    return 0;
  }
  if (command === 'doctor') {
    const checks = await runDoctor(makeDoctorContext(env, home, port));
    io.out(flags.json === true ? JSON.stringify(checks, null, 2) : formatChecks(checks));
    return exitCodeOf(checks);
  }
  if (command === 'ls') {
    const running = await runningHq(home);
    const view =
      running === null
        ? new Registry(home).view()
        : ((await (await fetch(`${running.url}/api/snapshot`)).json()) as { registry: ReturnType<Registry['view']> })
            .registry;
    io.out(
      running === null ? 'HQ is not running. Listing the registry on disk.' : `HQ ${running.url} (pid ${running.pid})`,
    );
    if (view.factories.length === 0) io.out('No factories yet. Run agent-works in a repo folder.');
    for (const factory of view.factories) {
      io.out(`factory ${factory.name}  ${factory.root}`);
      for (const id of factory.repos) io.out(`  repo ${id}  ${view.repos.find((repo) => repo.id === id)?.path ?? ''}`);
    }
    return 0;
  }
  if (command === 'stop') {
    const running = await runningHq(home);
    if (running === null) {
      const driver = await hqDriver(env, home)(hqIdFor(home), undefined);
      const left = await driver?.removeAll();
      io.out(
        `HQ is not running.${left === undefined || left.containers + left.networks === 0 ? '' : ` Removed ${left.containers} leftover containers and ${left.networks} networks.`}`,
      );
      return 0;
    }
    await post(running, '/api/stop', {});
    const deadline = Date.now() + 60_000;
    while (pidAlive(running.pid) && Date.now() < deadline) await sleep(50);
    if (pidAlive(running.pid)) throw new CliError(`HQ (pid ${running.pid}) did not stop within 60 s`);
    io.out(`HQ stopped (pid ${running.pid}).`);
    return 0;
  }
  if (command === 'open') {
    const { runtime, reused } = await ensureHq(home, port, explicitPort);
    const here = await factoryFor(cwd);
    const { factory } = await post<{ factory: { name: string } }>(runtime, '/api/factories', { root: here.root });
    if (here.isRepo) await post(runtime, '/api/repos', { factory: here.root, path: here.root, remote: here.remote });
    io.out(`HQ ${reused ? 'reused' : 'started'} at ${runtime.url} (pid ${runtime.pid})`);
    io.out(`factory ${factory.name}  ${here.root}`);
    if (flags['no-open'] !== true) openBrowser(runtime.url);
    return 0;
  }
  if (command === 'add-repo') {
    const [target] = positional;
    if (target === undefined) throw new CliError('usage: agent-works add-repo <path> [--factory <folder>]', 2);
    const path = notCage(realpathSync(resolve(cwd, target)));
    const factoryRoot =
      typeof flags.factory === 'string'
        ? notCage(realpathSync(resolve(cwd, flags.factory)))
        : (await factoryFor(cwd)).root;
    const remote =
      typeof flags.remote === 'string' ? flags.remote : await gitOut(path, ['remote', 'get-url', 'origin']);
    const { runtime } = await ensureHq(home, port, explicitPort);
    await post(runtime, '/api/factories', { root: factoryRoot });
    const { repo, changed } = await post<{ repo: { id: string }; changed: boolean }>(runtime, '/api/repos', {
      factory: factoryRoot,
      path,
      remote,
    });
    io.out(`${changed ? 'added' : 'already had'} ${repo.id} in factory ${factoryRoot}`);
    return 0;
  }
  if (command === 'cage') {
    const [action, id] = positional;
    const running = await runningHq(home);
    if (running === null) throw new CliError('HQ is not running. Start it with agent-works.');
    if (action === 'start') {
      const task = typeof flags.task === 'string' ? flags.task : '';
      const worker = typeof flags.worker === 'string' ? flags.worker : '';
      if (!task || !worker)
        throw new CliError('usage: agent-works cage start --task <t> --worker <w> [--source <repo>]', 2);
      const source = notCage(
        typeof flags.source === 'string' ? resolve(cwd, flags.source) : (await factoryFor(cwd)).root,
      );
      const cage = await post<{ id: string; container: string; workdir: string }>(running, '/api/cages', {
        task,
        worker,
        source,
      });
      io.out(`cage ${cage.id} container ${cage.container} workdir ${cage.workdir}`);
      return 0;
    }
    if (action === 'stop' && id !== undefined) {
      await post(running, `/api/cages/${encodeURIComponent(id)}`, null, 'DELETE');
      io.out(`cage ${id} removed`);
      return 0;
    }
    throw new CliError('usage: agent-works cage start|stop', 2);
  }
  io.err(`unknown command ${command}\n${HELP}`);
  return 2;
};

export const run = async (argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> => {
  try {
    return await main(argv, env);
  } catch (error) {
    if (error instanceof CliError) {
      stdio.err(error.message);
      return error.code;
    }
    stdio.err(String((error as Error).stack ?? error));
    return 1;
  }
};
