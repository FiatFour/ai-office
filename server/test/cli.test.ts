import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError, main, parseArgs } from '../cli.ts';
import { readRuntime } from '../config.ts';
import { Store } from '../store/store.ts';
import { folder, tempDir } from './helpers.ts';

const BIN = fileURLToPath(new URL('../../bin/agent-works.ts', import.meta.url));
const canRun =
  (process.features as { typescript?: boolean | string }).typescript !== undefined &&
  (process.features as { typescript?: boolean | string }).typescript !== false;
const live = canRun ? describe : describe.skip;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe', timeout: 20_000 });

const repoAt = (root: string, name: string, remote: string): string => {
  const dir = folder(root, name);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
};

const cli = (cwd: string, home: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const res = spawnSync(process.execPath, [BIN, ...args, '--home', home], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
};

const homes: string[] = [];
const holders: Server[] = [];
afterEach(() => {
  // With no HQ, `stop` still asks the container engine, which can hang for 20 s on a Windows runner.
  for (const home of homes.splice(0)) if (readRuntime(home) !== null) cli(process.cwd(), home, ['stop']);
  for (const server of holders.splice(0)) server.close();
  // `stop` of a running HQ can wait 20 s for the container engine, past the default 10 s hook limit.
}, 60_000);

describe('argument parsing', () => {
  it('reads flags, values and the default command', () => {
    expect(parseArgs([]).command).toBe('open');
    expect(parseArgs(['--no-open', '--port', '7431'])).toMatchObject({
      command: 'open',
      flags: { 'no-open': true, port: '7431' },
    });
    expect(parseArgs(['add-repo', 'x', '--factory=y']).flags.factory).toBe('y');
  });
});

describe('doctor in process', () => {
  it('prints the host row and exits 1 with this OS fix when the engine does not answer', async () => {
    const lines: string[] = [];
    const home = tempDir('cli-doctor');
    const code = await main(
      ['doctor', '--home', home],
      { ...process.env, DOCKER_HOST: 'unix:///nonexistent-aw.sock', AGENT_WORKS_ENGINE: 'docker' },
      { out: (t) => lines.push(t), err: (t) => lines.push(t) },
    );
    const text = lines.join('\n');
    console.log(`doctor on ${process.platform}, exit ${code}\n${text}`);
    expect(text).toMatch(/^(PASS|WARN|FAIL|SKIP)\s+Host: /m);
    if (!/^FAIL\s+Container engine/m.test(text)) return;
    expect(code).toBe(1);
    expect(text).toMatch(/fix: .+/);
  }, 60_000);

  it('prints a JSON array of checks with --json', async () => {
    const lines: string[] = [];
    await main(
      ['doctor', '--json', '--home', tempDir('cli-json')],
      { ...process.env, DOCKER_HOST: 'unix:///nonexistent-aw.sock', AGENT_WORKS_ENGINE: 'docker' },
      { out: (t) => lines.push(t), err: () => {} },
    );
    const parsed = JSON.parse(lines.join('\n')) as Array<{ id: string; status: string }>;
    expect(parsed.map((c) => c.id)).toContain('engine');
  }, 60_000);
});

describe('commands refuse to start from inside a cage', () => {
  const inCage = () => {
    const home = tempDir('cli-cage-home');
    const cwd = join(home, 'cages', 'one-abc123', 'repo');
    mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
    homes.push(home);
    return { home, cwd };
  };
  const quiet = { out: () => {}, err: () => {} };

  it('refuses to add a repo whose path is inside a cage, from a cwd that is not', async () => {
    const root = tempDir('cli-cage-path');
    const home = folder(root, 'home');
    const inside = folder(home, 'cages/one-abc123/repo');
    const outside = folder(root, 'clone');
    const link = join(root, 'link');
    symlinkSync(inside, link, 'junction');
    for (const target of [inside, link]) {
      const failure = await main(['add-repo', target, '--home', home], { AGENT_WORKS_CWD: outside }, quiet).catch(
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(CliError);
      expect(String((failure as Error).message)).toContain('inside a cage');
    }
  });

  it.each([['cage', 'start', '--task', 't', '--worker', 'w'], ['open'], ['add-repo', '.']])(
    '%s from a cage workdir',
    async (...argv) => {
      const { home, cwd } = inCage();
      const failure = await main([...argv, '--home', home], { AGENT_WORKS_CWD: cwd }, quiet).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CliError);
      expect(String((failure as Error).message)).toContain('inside a cage');
    },
  );
});

live('the CLI as a process', () => {
  it('starts HQ, lists the factory, reuses it from a second folder and stops it', async () => {
    const root = tempDir('cli-live');
    const home = folder(root, 'home');
    homes.push(home);
    const a = repoAt(root, 'alpha', 'git@github.com:acme/alpha.git');
    const b = repoAt(root, 'beta', 'git@github.com:acme/beta.git');
    const port = String(await freePort());
    const first = cli(a, home, ['--no-open', '--port', port]);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toContain(`http://127.0.0.1:${port}`);
    expect(first.out).toContain('started');
    const ls = cli(a, home, ['ls']);
    expect(ls.out).toContain('factory alpha');
    expect(ls.out).toContain('github.com/acme/alpha');
    const second = cli(b, home, ['--no-open', '--port', port]);
    expect(second.out).toContain('reused');
    const pidOf = (text: string) => /pid (\d+)/.exec(text)?.[1];
    expect(pidOf(second.out)).toBe(pidOf(first.out));
    const both = cli(a, home, ['ls']).out;
    expect(both).toContain('factory alpha');
    expect(both).toContain('factory beta');
    const stop = cli(a, home, ['stop']);
    expect(stop.out).toContain('stopped');
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toBeTruthy();
  }, 60_000);

  it('says the port is busy and suggests --port when another program holds it', async () => {
    const root = tempDir('cli-busy');
    const home = folder(root, 'home');
    const port = await freePort();
    const holder = createServer().listen(port, '127.0.0.1');
    holders.push(holder);
    await new Promise((r) => holder.once('listening', r));
    const res = cli(folder(root, 'w'), home, ['--no-open', '--port', String(port)]);
    expect(res.code).toBe(2);
    expect(res.err).toContain(`Port ${port} is busy`);
    expect(res.err).toContain('--port');
  });

  it('names the other HQ when a second home asks for a port an HQ already holds', async () => {
    const root = tempDir('cli-other-hq');
    const [one, two] = [folder(root, 'home-one'), folder(root, 'home-two')] as [string, string];
    homes.push(one);
    const port = String(await freePort());
    const first = cli(folder(root, 'a'), one, ['--no-open', '--port', port]);
    expect(first.code).toBe(0);
    const pid = /pid (\d+)/.exec(first.out)?.[1];
    const second = cli(folder(root, 'b'), two, ['--no-open', '--port', port]);
    expect(second.code).toBe(2);
    expect(second.err).toContain(`another HQ (pid ${pid})`);
    expect(second.err).not.toContain('Another program');
    expect(second.err).toContain('--port');
    // This and the two-factory test start an HQ and stop it in the hook: up to 7.3 s together on Windows runners.
  }, 60_000);

  it('says another HQ owns the state, not a stack trace, when a live process holds the state directory', async () => {
    const root = tempDir('cli-owned');
    const home = folder(root, 'home');
    homes.push(home);
    const holder = Store.open(join(home, 'state'));
    try {
      const res = cli(folder(root, 'w'), home, ['--no-open', '--port', String(await freePort())]);
      expect(res.code).toBe(1);
      expect(res.err).toContain(`another HQ (pid ${process.pid}) owns this state directory`);
      expect(res.err).not.toMatch(/\bat \w+.*\.ts:\d+/);
    } finally {
      holder.close();
    }
  });

  it('shows only this start, not the lines an earlier run left in hq.log', async () => {
    const root = tempDir('cli-log-tail');
    const home = folder(root, 'home');
    homes.push(home);
    writeFileSync(join(home, 'hq.log'), 'OLD-RUN-LINE\n'.repeat(20));
    const holder = Store.open(join(home, 'state'));
    try {
      const res = cli(folder(root, 'w'), home, ['--no-open', '--port', String(await freePort())]);
      expect(res.err).toContain('owns this state directory');
      expect(res.err).not.toContain('OLD-RUN-LINE');
    } finally {
      holder.close();
    }
  });

  it('adds one repo to two factories with one entry in repos.json', async () => {
    const root = tempDir('cli-many');
    const home = folder(root, 'home');
    homes.push(home);
    const clone = repoAt(root, 'shared', 'https://github.com/acme/shared.git');
    const f1 = folder(root, 'f1');
    const f2 = folder(root, 'f2');
    const port = String(await freePort());
    expect(cli(f1, home, ['add-repo', clone, '--port', port]).code).toBe(0);
    expect(cli(f2, home, ['add-repo', clone, '--port', port]).code).toBe(0);
    const repos = JSON.parse((await import('node:fs')).readFileSync(join(home, 'repos.json'), 'utf8')) as {
      repos: Record<string, unknown>;
    };
    expect(Object.keys(repos.repos)).toEqual(['github.com/acme/shared']);
    const ls = cli(f1, home, ['ls']).out;
    expect(ls.match(/repo github.com\/acme\/shared/g)).toHaveLength(2);
  }, 60_000);
});

live('serve --mode cages', () => {
  const config = (dir: string, over: Record<string, unknown> = {}) => {
    const path = join(dir, 'cages.json');
    writeFileSync(
      path,
      JSON.stringify({
        host: 'github',
        repo: 'acme/app',
        base: 'main',
        source: dir,
        author: 'nova',
        reviewer: 'vega',
        tickets: { 'alpha/t1': { kind: 'feature', title: 'Add a file', body: 'Write a file.' } },
        pollMs: 3_600_000,
        ...over,
      }),
    );
    return path;
  };

  it.skipIf(process.platform === 'win32')(
    'runs HQ with the cages mode from a config file, and Ctrl-C stops it',
    async () => {
      const home = tempDir('cli-cages');
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [BIN, 'serve', '--port', String(port), '--home', home, '--mode', 'cages', '--config', config(home)],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      try {
        let snap: { mode: unknown } | null = null;
        for (let i = 0; i < 200 && snap === null; i += 1) {
          snap = await fetch(`http://127.0.0.1:${port}/api/snapshot`)
            .then((r) => r.json() as Promise<{ mode: unknown }>)
            .catch(() => null);
          if (snap === null) await sleep(50);
        }
        expect(snap?.mode).toMatchObject({ rounds: {}, jobs: [] });
        const bad = await fetch(`http://127.0.0.1:${port}/api/tickets`, { method: 'POST', body: 'null' });
        expect(bad.status).toBe(400);
        child.kill('SIGINT');
        const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
        expect(code).toBe(0);
      } finally {
        child.kill('SIGKILL');
      }
    },
    60_000,
  );

  it('refuses a config it cannot use with exit code 2', () => {
    const dir = tempDir('cli-cages-bad');
    expect(cli(dir, dir, ['serve', '--mode', 'cages', '--config', config(dir, { host: 'bitbucket' })]).code).toBe(2);
    expect(
      cli(dir, dir, [
        'serve',
        '--mode',
        'cages',
        '--config',
        config(dir, { tickets: { 'bad id': { kind: 'chore', title: 't', body: 'b' } } }),
      ]).code,
    ).toBe(2);
    for (const [over, said] of [
      [{ reviewer: 'Nova' }, /different logins/],
      [{ repo: 'acme' }, /not <owner>\/<name>/],
      [{ host: 'gitlab', repo: '7' }, /not a namespace path/],
    ] as const) {
      const ran = cli(dir, dir, ['serve', '--mode', 'cages', '--config', config(dir, over)]);
      expect(ran.code, JSON.stringify(over)).toBe(2);
      expect(ran.out + ran.err).toMatch(said);
    }
    expect(cli(dir, dir, ['serve', '--mode', 'cages']).code).toBe(2);
    expect(cli(dir, dir, ['serve', '--mode', 'other']).code).toBe(2);
  }, 60_000);
});
