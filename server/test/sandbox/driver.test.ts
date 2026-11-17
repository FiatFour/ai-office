import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CageError, SandboxDriver } from '../../sandbox/container.ts';
import { Engine, type EngineName } from '../../sandbox/engine.ts';
import type { Denial } from '../../sandbox/firewall.ts';
import { folder, tempDir } from '../helpers.ts';

const CONTEXT = fileURLToPath(new URL('.', import.meta.url));
const IMAGE = process.env.AGENT_WORKS_TEST_IMAGE ?? 'aw-test-cage:1';
const optedOut = process.env.AGENT_WORKS_NO_LIVE === '1';

const usable = async (name: EngineName): Promise<Engine | null> => {
  if (optedOut || process.platform !== 'linux') return null;
  const engine = new Engine(name);
  if ((await engine.version()) === null) return null;
  const os = await engine.run(['info', '--format', name === 'docker' ? '{{.OSType}}' : '{{.Host.OS}}'], {
    timeoutMs: 20_000,
  });
  if (os.code !== 0 || os.out.trim() !== 'linux') return null;
  const info = await engine.info();
  if (!info.ok || (name === 'podman' && !info.rootless)) return null;
  return engine;
};

const engines = (await Promise.all((['docker', 'podman'] as const).map(usable))).filter((e): e is Engine => e !== null);

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
      driver = new SandboxDriver({ engine, home, hq, image: IMAGE, project, onDenial: (d) => denials.push(d) });
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
      expect(Object.keys(inspect?.NetworkSettings.Networks ?? {})).toEqual([`aw-${hq}-internal`]);
      const net = JSON.parse(await engine.ok(['network', 'inspect', `aw-${hq}-internal`])) as Array<{
        Internal: boolean;
      }>;
      expect(net[0]?.Internal).toBe(true);
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
