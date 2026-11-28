import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CageError, SandboxDriver } from '../../sandbox/container.ts';
import { exportRepo } from '../../sandbox/export.ts';
import type { Denial } from '../../sandbox/firewall.ts';
import { folder, tempDir } from '../helpers.ts';
import { CONTEXT, engines, IMAGE } from './engines.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  });

const fixtureRepo = (root: string, canary: string): string => {
  const repo = folder(root, 'source');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'hello.js'), "console.log('hi');\n");
  writeFileSync(join(repo, '.env'), `API_KEY=${canary}\n`);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '-A', '-f');
  git(repo, 'commit', '-qm', 'fixture with a tracked .env');
  return repo;
};

describe.skipIf(engines.length === 0)('sandbox driver on a real engine', () => {
  describe.each(engines.map((e) => [e.name, e] as const))('%s', (_name, engine) => {
    const project = `agent-works-test-${randomBytes(3).toString('hex')}`;
    const hq = randomBytes(3).toString('hex');
    const home = tempDir(`driver-${engine.name}`);
    const denials: Denial[] = [];
    const canary = `CANARY_${randomBytes(6).toString('hex')}`;
    let driver: SandboxDriver;

    beforeAll(async () => {
      const have = await engine.run(['image', 'inspect', IMAGE]);
      if (have.code !== 0)
        await engine.ok(['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
          timeoutMs: 600_000,
        });
      driver = new SandboxDriver({
        engine,
        home,
        hq,
        image: IMAGE,
        project,
        workerAllow: { nova: ['own.invalid'] },
        onDenial: (d) => denials.push(d),
      });
    }, 700_000);

    afterAll(async () => {
      await driver.removeAll();
    }, 120_000);

    it('starts a cage from a fresh sanitized export, owned by the host user, with no tracked secret', async () => {
      const source = fixtureRepo(tempDir('driver-src'), canary);
      const cage = await driver.startCage({ task: 'acme/t1', worker: 'nova', source });
      const exec = (script: string) => engine.run(['exec', cage.container, 'sh', '-c', script]);
      expect((await exec('test -f /work/hello.js && test -d /work/.git')).code).toBe(0);
      expect((await exec('test -e /work/.env')).code).not.toBe(0);
      const leaked = await exec(`grep -r --exclude-dir=node_modules ${canary} /work /home/agent 2>/dev/null | head -1`);
      expect(leaked.out.trim()).toBe('');
      const commits = (await exec('git -C /work rev-list --count --all')).out.trim();
      expect(commits).toBe('1');
      expect((await exec('echo owned > /work/owned.txt')).code).toBe(0);
      const owned = statSync(join(cage.workdir, 'owned.txt'));
      expect(owned.uid).toBe(process.getuid?.());
      expect(readFileSync(join(source, '.env'), 'utf8')).toContain(canary);
      expect(existsSync(join(cage.workdir, '.env'))).toBe(false);
    }, 180_000);

    it('runs the cage hardened on the internal network', async () => {
      const [cage] = driver.list();
      expect(cage).toBeDefined();
      const [inspect] = JSON.parse(await engine.ok(['inspect', cage?.container ?? ''])) as Array<{
        Config: { User: string };
        HostConfig: { CapDrop: string[]; SecurityOpt: string[] };
        NetworkSettings: { Networks: Record<string, unknown> };
      }>;
      const dropped = (inspect?.HostConfig.CapDrop ?? []).map((c) => c.toUpperCase().replace(/^CAP_/, ''));
      for (const cap of dropped.includes('ALL') ? [] : ['CHOWN', 'DAC_OVERRIDE', 'SETUID'])
        expect(dropped).toContain(cap);
      expect(dropped.length).toBeGreaterThan(0);
      expect(inspect?.HostConfig.SecurityOpt.join(' ')).toContain('no-new-privileges');
      const rootMount = await engine.run([
        'exec',
        cage?.container ?? '',
        'sh',
        '-c',
        'awk \'$2=="/"{print $4}\' /proc/mounts',
      ]);
      expect(rootMount.out.split(',')).toContain('ro');
      expect(inspect?.Config.User).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
      expect((inspect?.Config as { Env?: string[] } | undefined)?.Env).toContain(
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      );
      expect(Object.keys(inspect?.NetworkSettings.Networks ?? {})).toEqual([`aw-${hq}-internal`]);
      const net = JSON.parse(await engine.ok(['network', 'inspect', `aw-${hq}-internal`])) as Array<{
        Internal?: boolean;
        internal?: boolean;
      }>;
      expect(net[0]?.Internal ?? net[0]?.internal).toBe(true);
    });

    it('gives the cage no route out except the proxy', async () => {
      const [cage] = driver.list();
      const exec = (script: string) =>
        engine.run(['exec', cage?.container ?? '', 'node', '-e', script], { timeoutMs: 60_000 });
      const raw = await exec(
        "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:4000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('FAILED '+e.code);process.exit(0)});s.on('timeout',()=>{console.log('FAILED TIMEOUT');process.exit(0)})",
      );
      expect(raw.out).toContain('FAILED');
      const connect = (target: string) =>
        exec(
          `const u=new URL(process.env.HTTPS_PROXY);const r=require('http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'${target}',headers:{'Proxy-Authorization':'Basic '+Buffer.from(u.username+':x').toString('base64')},timeout:8000});r.on('connect',res=>{console.log('STATUS '+res.statusCode);process.exit(0)});r.on('error',e=>{console.log('ERROR '+e.code);process.exit(0)});r.on('timeout',()=>{console.log('ERROR TIMEOUT');process.exit(0)});r.end()`,
        );
      const denied = await connect('example.com:443');
      expect(denied.out).toContain('STATUS 403');
      const allowed = await connect('registry.npmjs.org:443');
      expect(allowed.out).not.toContain('STATUS 403');
      const deadline = Date.now() + 15_000;
      while (!denials.some((d) => d.host === 'example.com') && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 200));
      expect(denials.find((d) => d.host === 'example.com')).toMatchObject({
        port: 443,
        agent: 'nova',
        reason: 'not-allowlisted',
      });
      expect(denials.some((d) => d.host === 'registry.npmjs.org')).toBe(false);
    }, 120_000);

    it.skipIf(engine.name !== 'docker')(
      'cannot reach a host service through any bridge gateway',
      async () => {
        const server = createServer((s) => s.end('HOST-SERVICE')).listen(0, '0.0.0.0');
        await new Promise((r) => server.once('listening', r));
        const { port } = server.address() as { port: number };
        try {
          const [cage] = driver.list();
          const gateways = new Set(['172.17.0.1']);
          const ids = (await engine.ok(['network', 'ls', '-q'])).split('\n').filter(Boolean);
          for (const id of ids) {
            const [net] = JSON.parse(await engine.ok(['network', 'inspect', id])) as Array<{
              IPAM: { Config: Array<{ Gateway?: string }> | null };
            }>;
            for (const config of net?.IPAM.Config ?? []) if (config.Gateway) gateways.add(config.Gateway);
          }
          for (const gateway of gateways) {
            const res = await engine.run(
              [
                'exec',
                cage?.container ?? '',
                'node',
                '-e',
                `const s=require('net').connect({host:'${gateway}',port:${port},timeout:2500});s.on('data',()=>{console.log('LEAK');process.exit(0)});s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0))`,
              ],
              { timeoutMs: 30_000 },
            );
            expect(res.out, `gateway ${gateway}`).not.toContain('LEAK');
          }
        } finally {
          server.close();
        }
      },
      120_000,
    );

    it('names a cage by its address, gives it only its own rules and forgets it on release', async () => {
      const registry = () =>
        Object.values(JSON.parse(readFileSync(join(home, 'sandbox', hq, 'cages.json'), 'utf8'))) as unknown[];
      const [first] = driver.list();
      const vega = await driver.startCage({
        task: 'acme/t4',
        worker: 'vega',
        source: fixtureRepo(tempDir('driver-src4'), canary),
      });
      expect(registry()).toContainEqual({ agent: 'nova', allow: ['own.invalid'] });
      expect(registry()).toContainEqual({ agent: 'vega', allow: [] });
      const asNova = async (container: string, target: string) => {
        const script = `const u=new URL(process.env.HTTPS_PROXY);const r=require('http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'${target}',headers:{'Proxy-Authorization':'Basic '+Buffer.from('nova:x').toString('base64')},timeout:8000});r.on('connect',res=>{console.log(res.statusCode);process.exit(0)});r.on('error',e=>{console.log(e.code);process.exit(0)});r.end()`;
        return (await engine.run(['exec', container, 'node', '-e', script], { timeoutMs: 60_000 })).out.trim();
      };
      expect(await asNova(first?.container ?? '', 'own.invalid:443')).toBe('502');
      expect(await asNova(vega.container, 'own.invalid:443')).toBe('403');
      await expect.poll(() => denials.find((d) => d.host === 'own.invalid')?.agent, { timeout: 15_000 }).toBe('vega');
      expect(driver.rules()).not.toContain('later.invalid:443');
      await driver.allow('later.invalid:443');
      expect(driver.rules()).toContain('later.invalid:443');
      expect(await asNova(vega.container, 'later.invalid:443')).toBe('502');
      await driver.releaseCage(vega.id);
      expect(registry()).toEqual([{ agent: 'nova', allow: ['own.invalid'] }]);
    }, 180_000);

    it('releases one cage and then leaves nothing labeled behind after removeAll', async () => {
      const source = fixtureRepo(tempDir('driver-src2'), canary);
      const second = await driver.startCage({ task: 'acme/t2', worker: 'nova', source });
      expect(await driver.releaseCage(second.id)).toBe(true);
      expect(await driver.releaseCage(second.id)).toBe(false);
      expect((await driver.leftovers()).containers).not.toContain(second.container);
      await driver.removeAll();
      expect(await driver.leftovers()).toEqual({ containers: [], networks: [] });
      expect(driver.list()).toEqual([]);
    }, 180_000);

    const plantFilter = (repo: string, marker: string): void => {
      writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'attributes');
      git(repo, 'config', 'filter.x.smudge', `sh -c 'touch ${marker}; cat'`);
    };

    it('never runs the source repo filters on the host, whatever its config says', async () => {
      const marker = join(tempDir('marker-direct'), 'RAN-ON-HOST');
      const source = fixtureRepo(tempDir('driver-filter'), canary);
      plantFilter(source, marker);
      const dest = join(tempDir('driver-filter-dest'), 'repo');
      await exportRepo(source, dest, (args, mounts) => driver.throwaway(args, mounts)).catch(() => null);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dest, 'hello.js'))).toBe(true);
    }, 180_000);

    it('refuses a cage workdir, or a link to one, as a source and runs nothing from it', async () => {
      const marker = join(tempDir('marker-cage'), 'RAN-ON-HOST');
      const workdir = join(home, 'cages', 'one-abc123', 'repo');
      mkdirSync(workdir, { recursive: true });
      git(workdir, 'init', '-q', '-b', 'main');
      writeFileSync(join(workdir, 'a.txt'), 'a');
      git(workdir, 'add', '-A');
      git(workdir, 'commit', '-qm', 'agent work');
      plantFilter(workdir, marker);
      const link = join(tempDir('driver-link'), 'link');
      symlinkSync(workdir, link, 'junction');
      for (const source of [workdir, link, join(workdir, 'sub/..')]) {
        const failure = await driver.startCage({ task: 'acme/t7', worker: 'nova', source }).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(CageError);
        expect(String((failure as Error).message)).toContain('inside a cage');
      }
      expect(existsSync(marker)).toBe(false);
    }, 180_000);

    it('runs the throwaway container with no network interface but loopback', async () => {
      const result = await driver.throwaway(['sh', '-c', 'ls /sys/class/net'], []);
      expect(result.out.trim()).toBe('lo');
    }, 120_000);

    it('runs the throwaway container hardened, as the host user, with a read-only root', async () => {
      const probe = [
        'sh',
        '-c',
        'id -u; grep -E \'^(CapBnd|NoNewPrivs):\' /proc/self/status; awk \'$2=="/"{print "root", $4}\' /proc/mounts',
      ];
      const result = await driver.throwaway(probe, []);
      const lines = result.out.trim().split('\n');
      expect(lines[0]).toBe(String(process.getuid?.()));
      expect(process.getuid?.()).not.toBe(0);
      expect(lines).toContain('CapBnd:\t0000000000000000');
      expect(lines).toContain('NoNewPrivs:\t1');
      expect(lines.find((line) => line.startsWith('root '))?.split(/[ ,]/)).toContain('ro');
    }, 120_000);

    it('refuses an export when git archive fails half way, leaving a tar that looks whole', async () => {
      const source = folder(tempDir('driver-halfway'), 'source');
      git(source, 'init', '-q', '-b', 'main');
      writeFileSync(join(source, 'a.txt'), 'a'.repeat(8704));
      writeFileSync(join(source, 'zz.txt'), 'last\n');
      git(source, 'add', '-A');
      git(source, 'commit', '-qm', 'two files');
      const blob = execFileSync('git', ['rev-parse', 'HEAD:zz.txt'], { cwd: source, encoding: 'utf8' }).trim();
      const loose = join(source, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
      chmodSync(loose, 0o644);
      writeFileSync(loose, 'garbage');
      const dest = join(tempDir('driver-halfway-dest'), 'repo');
      await expect(exportRepo(source, dest, (args, mounts) => driver.throwaway(args, mounts))).rejects.toThrow(
        /git archive/,
      );
    }, 120_000);

    it('starts the throwaway with the hardened flags, the host user and no network', async () => {
      const seen: string[][] = [];
      const spy = new Proxy(engine, {
        get: (target, name) => {
          if (name === 'run')
            return (args: string[], options?: Parameters<typeof engine.run>[1]) => {
              seen.push(args);
              return engine.run(args, options);
            };
          const value = Reflect.get(target, name) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const watched = new SandboxDriver({ engine: spy, home, hq, image: IMAGE, project });
      await watched.throwaway(['true'], []);
      const args = seen.find((a) => a[0] === 'run') ?? [];
      const pair = (flag: string, value: string) => args.findIndex((a, i) => a === flag && args[i + 1] === value);
      expect(pair('--cap-drop', 'ALL')).toBeGreaterThan(0);
      expect(pair('--security-opt', 'no-new-privileges')).toBeGreaterThan(0);
      expect(pair('--network', 'none')).toBeGreaterThan(0);
      expect(args).toContain('--read-only');
      expect(pair('--user', `${process.getuid?.()}:${process.getgid?.()}`)).toBeGreaterThan(0);
    }, 120_000);

    it('refuses an export when the contained git archive fails, instead of making an empty repo', async () => {
      const source = folder(tempDir('driver-nohead'), 'source');
      git(source, 'init', '-q', '-b', 'main');
      const dest = join(tempDir('driver-nohead-dest'), 'repo');
      await expect(exportRepo(source, dest, (args, mounts) => driver.throwaway(args, mounts))).rejects.toThrow(
        /git archive/,
      );
    }, 120_000);

    it('removes every protected file from the export, not only the first', async () => {
      const source = fixtureRepo(tempDir('driver-many'), canary);
      mkdirSync(join(source, 'sub'));
      writeFileSync(join(source, 'sub', '.env'), `SECOND=${canary}\n`);
      writeFileSync(join(source, 'id_rsa'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${canary}\n`);
      git(source, 'add', '-A', '-f');
      git(source, 'commit', '-qm', 'more secrets');
      const dest = join(tempDir('driver-many-dest'), 'repo');
      const { removed } = await exportRepo(source, dest, (args, mounts) => driver.throwaway(args, mounts));
      expect(removed.length).toBeGreaterThanOrEqual(3);
      for (const path of ['.env', 'sub/.env', 'id_rsa']) expect(existsSync(join(dest, path))).toBe(false);
      expect(existsSync(join(dest, 'hello.js'))).toBe(true);
    }, 120_000);

    it('names the build command when the image is missing and leaves nothing behind', async () => {
      const missing = new SandboxDriver({ engine, home, hq, image: 'aw-no-such-image:0', project });
      const failure = await missing
        .startCage({ task: 'acme/t3', worker: 'nova', source: tempDir('driver-src3') })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CageError);
      expect(String((failure as Error).message)).toContain(`${engine.name} build -t aw-no-such-image:0`);
      expect(await missing.leftovers()).toEqual({ containers: [], networks: [] });
    });

    it('refuses a source that is not a directory and leaves nothing behind', async () => {
      const failure = await driver
        .startCage({ task: 'acme/t4', worker: 'nova', source: join(home, 'nope') })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(await driver.leftovers()).toEqual({ containers: [], networks: [] });
    });
  });
});
