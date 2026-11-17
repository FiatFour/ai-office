import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../cli.ts';
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
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

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
  for (const home of homes.splice(0)) cli(process.cwd(), home, ['stop']);
  for (const server of holders.splice(0)) server.close();
});

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
  });

  it('prints a JSON array of checks with --json', async () => {
    const lines: string[] = [];
    await main(
      ['doctor', '--json', '--home', tempDir('cli-json')],
      { ...process.env, DOCKER_HOST: 'unix:///nonexistent-aw.sock', AGENT_WORKS_ENGINE: 'docker' },
      { out: (t) => lines.push(t), err: () => {} },
    );
    const parsed = JSON.parse(lines.join('\n')) as Array<{ id: string; status: string }>;
    expect(parsed.map((c) => c.id)).toContain('engine');
  });
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
  });

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
  });
});
