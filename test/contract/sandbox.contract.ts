import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { CageView } from '../../server/sandbox/container.ts';
import type { RunResult } from '../../server/sandbox/engine.ts';
import type { Denial } from '../../server/sandbox/firewall.ts';
import { folder, tempDir } from '../../server/test/helpers.ts';
import { type Case, NotRun, type Subject } from './kit.ts';

export interface SandboxLike {
  startCage(spec: { task: string; worker: string; source: string }): Promise<CageView>;
  exec(id: string, argv: readonly string[]): Promise<RunResult>;
  allow(rule: string): Promise<void>;
  releaseCage(id: string): Promise<boolean>;
  removeAll(): Promise<{ containers: number; networks: number }>;
  leftovers(): Promise<{ containers: string[]; networks: string[] }>;
  list(): CageView[];
  throwaway(args: string[], mounts: string[]): Promise<RunResult>;
}

export interface SandboxSubject extends Subject {
  readonly driver: SandboxLike;
  readonly home: string;
  readonly engine: string;
  readonly settleMs: number;
  readonly missingImage: { readonly image: string; readonly driver: SandboxLike };
  denials(): readonly Denial[];
}

export const probe = {
  sh: (id: string, script: string, ...args: string[]): string[] => [
    'sh',
    '-c',
    `: probe:${id} ${args.join(' ')}\n${script}`,
  ],
  node: (id: string, code: string): string[] => ['node', '-e', `//probe:${id}\n${code}`],
};

export const PROBE_ID = /probe:([a-z-]+)/;

export const HOST_UID = process.getuid?.() ?? 1000;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  });

const slash = (path: string) => path.replaceAll('\\', '/');

const fixtureRepo = (canary: string): string => {
  const repo = folder(tempDir('contract-src'), 'source');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'hello.js'), "console.log('hi');\n");
  writeFileSync(join(repo, '.env'), `API_KEY=${canary}\n`);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '-A', '-f');
  git(repo, 'commit', '-qm', 'fixture with a tracked .env');
  return repo;
};

const inCage = (s: SandboxSubject, cage: CageView, argv: string[]) => s.driver.exec(cage.id, argv);

const present = async (s: SandboxSubject, cage: CageView, path: string): Promise<boolean> =>
  (await inCage(s, cage, probe.sh('has', `test -e ${path}`, path))).code === 0;

const connectProbe = (target: string) =>
  probe.node(
    'connect',
    `const u=new URL(process.env.HTTPS_PROXY);const r=require('http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'${target}',headers:{'Proxy-Authorization':'Basic '+Buffer.from(u.username+':x').toString('base64')},timeout:8000});r.on('connect',res=>{console.log('STATUS '+res.statusCode);process.exit(0)});r.on('error',e=>{console.log('ERROR '+e.code);process.exit(0)});r.on('timeout',()=>{console.log('ERROR TIMEOUT');process.exit(0)});r.end()`,
  );

const HARDENED = probe.sh(
  'hardened',
  'id -u; grep -E \'^(CapBnd|NoNewPrivs):\' /proc/self/status; awk \'$2=="/"{print "root", $4}\' /proc/mounts',
);

const expectHardened = (out: string) => {
  const lines = out.trim().split('\n');
  expect(HOST_UID).not.toBe(0);
  expect(lines[0]).toBe(String(HOST_UID));
  expect(lines).toContain('CapBnd:\t0000000000000000');
  expect(lines).toContain('NoNewPrivs:\t1');
  expect(lines.find((line) => line.startsWith('root '))?.split(/[ ,]/)).toContain('ro');
};

const plantFilter = (repo: string, marker: string): void => {
  writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'attributes');
  git(repo, 'config', 'filter.x.smudge', `sh -c 'touch ${slash(marker)}; cat'`);
};

const clean = (s: SandboxSubject) => expect(s.driver.leftovers()).resolves.toEqual({ containers: [], networks: [] });

const using = async <T>(s: SandboxSubject, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } finally {
    await s.driver.removeAll();
  }
};

export const sandboxCases: readonly Case<SandboxSubject>[] = [
  {
    id: 'export-is-sanitized',
    rule: 'a cage starts from a fresh export with no tracked secret and a single commit, and the source is untouched',
    run: (s) =>
      using(s, async () => {
        const canary = `CANARY_${randomBytes(6).toString('hex')}`;
        const source = fixtureRepo(canary);
        const cage = await s.driver.startCage({ task: 'acme/t1', worker: 'nova', source });
        expect(await present(s, cage, '/work/hello.js')).toBe(true);
        expect(await present(s, cage, '/work/.git')).toBe(true);
        expect(await present(s, cage, '/work/.env')).toBe(false);
        const leaked = await inCage(
          s,
          cage,
          probe.sh(
            'leak-scan',
            `grep -r --exclude-dir=node_modules ${canary} /work /home/agent 2>/dev/null | head -1`,
            canary,
          ),
        );
        expect(leaked.out.trim()).toBe('');
        expect((await inCage(s, cage, probe.sh('commits', 'git -C /work rev-list --count --all'))).out.trim()).toBe(
          '1',
        );
        expect(readFileSync(join(source, '.env'), 'utf8')).toContain(canary);
        expect(existsSync(join(cage.workdir, '.env'))).toBe(false);
      }),
  },
  {
    id: 'cage-files-belong-to-the-host-user',
    rule: 'a file the agent writes in the cage is owned by the host user, not by root',
    run: (s) =>
      using(s, async () => {
        const cage = await s.driver.startCage({ task: 'acme/t1', worker: 'nova', source: fixtureRepo('c') });
        expect((await inCage(s, cage, probe.sh('write', 'echo owned > /work/owned.txt'))).code).toBe(0);
        if (process.getuid === undefined) throw new NotRun('this OS has no POSIX uid to compare the owner with');
        expect(statSync(join(cage.workdir, 'owned.txt')).uid).toBe(process.getuid());
      }),
  },
  {
    id: 'cage-is-hardened',
    rule: 'the cage runs as the host user with no capabilities, no-new-privs and a read-only root',
    run: (s) =>
      using(s, async () => {
        const cage = await s.driver.startCage({ task: 'acme/t1', worker: 'nova', source: fixtureRepo('c') });
        expectHardened((await inCage(s, cage, HARDENED)).out);
      }),
  },
  {
    id: 'cage-has-no-route-out-but-the-proxy',
    rule: 'a raw connection fails, a CONNECT to an unlisted host is refused and reported with the agent, a listed host is not',
    run: (s) =>
      using(s, async () => {
        const cage = await s.driver.startCage({ task: 'acme/t1', worker: 'nova', source: fixtureRepo('c') });
        const raw = await inCage(
          s,
          cage,
          probe.node(
            'raw-connect',
            "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:4000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('FAILED '+e.code);process.exit(0)});s.on('timeout',()=>{console.log('FAILED TIMEOUT');process.exit(0)})",
          ),
        );
        expect(raw.out).toContain('FAILED');
        expect((await inCage(s, cage, connectProbe('example.com:443'))).out).toContain('STATUS 403');
        expect((await inCage(s, cage, connectProbe('registry.npmjs.org:443'))).out).not.toContain('STATUS 403');
        const deadline = Date.now() + s.settleMs;
        while (!s.denials().some((d) => d.host === 'example.com') && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 200));
        expect(s.denials().find((d) => d.host === 'example.com')).toMatchObject({ port: 443, agent: 'nova' });
        expect(s.denials().some((d) => d.host === 'registry.npmjs.org')).toBe(false);
      }),
  },
  {
    id: 'allow-takes-a-host-rule-only',
    rule: 'allow refuses anything that is not a single host rule and lifts the refusal for one that is',
    run: (s) =>
      using(s, async () => {
        const cage = await s.driver.startCage({ task: 'acme/t1', worker: 'nova', source: fixtureRepo('c') });
        for (const bad of ['two words', '', '*', 'a/b', 'example.org:0'] as const)
          await expect(s.driver.allow(bad)).rejects.toThrow();
        await s.driver.allow('example.org:443');
        expect((await inCage(s, cage, connectProbe('example.org:443'))).out).not.toContain('STATUS 403');
      }),
  },
  {
    id: 'release-is-idempotent',
    rule: 'releasing a cage removes its container once and reports false the second time',
    run: (s) =>
      using(s, async () => {
        const cage = await s.driver.startCage({ task: 'acme/t2', worker: 'nova', source: fixtureRepo('c') });
        expect(await s.driver.releaseCage(cage.id)).toBe(true);
        expect(await s.driver.releaseCage(cage.id)).toBe(false);
        expect((await s.driver.leftovers()).containers).not.toContain(cage.container);
      }),
  },
  {
    id: 'remove-all-leaves-nothing',
    rule: 'removeAll counts and removes every container and network of the project, and empties the list',
    run: async (s) => {
      await s.driver.startCage({ task: 'acme/t2', worker: 'nova', source: fixtureRepo('c') });
      await s.driver.startCage({ task: 'acme/t3', worker: 'mira', source: fixtureRepo('c') });
      expect(s.driver.list()).toHaveLength(2);
      const removed = await s.driver.removeAll();
      expect(removed.containers).toBeGreaterThanOrEqual(2);
      await clean(s);
      expect(s.driver.list()).toEqual([]);
    },
  },
  {
    id: 'cage-workdir-is-refused-as-a-source',
    rule: 'a cage workdir, a link to one, or a path through it is never used as an export source',
    run: async (s) => {
      const marker = join(tempDir('contract-marker'), 'RAN-ON-HOST');
      const workdir = join(s.home, 'cages', 'one-abc123', 'repo');
      mkdirSync(workdir, { recursive: true });
      git(workdir, 'init', '-q', '-b', 'main');
      writeFileSync(join(workdir, 'a.txt'), 'a');
      git(workdir, 'add', '-A');
      git(workdir, 'commit', '-qm', 'agent work');
      plantFilter(workdir, marker);
      const link = join(tempDir('contract-link'), 'link');
      symlinkSync(workdir, link, 'junction');
      for (const source of [workdir, link, join(workdir, 'sub/..')]) {
        const failure = await s.driver.startCage({ task: 'acme/t7', worker: 'nova', source }).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(Error);
        expect(String((failure as Error).message)).toContain('inside a cage');
      }
      expect(existsSync(marker)).toBe(false);
      await clean(s);
    },
  },
  {
    id: 'throwaway-has-no-network-and-is-hardened',
    rule: 'the throwaway container has only loopback and the same hardening as a cage',
    run: async (s) => {
      const net = await s.driver.throwaway(probe.sh('net-interfaces', 'ls /sys/class/net'), []);
      expect(net.out.trim()).toBe('lo');
      expectHardened((await s.driver.throwaway(HARDENED, [])).out);
    },
  },
  {
    id: 'source-filters-never-run-on-the-host',
    rule: 'a smudge filter in the source repo config never runs outside the container',
    run: (s) =>
      using(s, async () => {
        const marker = join(tempDir('contract-filter'), 'RAN-ON-HOST');
        const source = fixtureRepo('c');
        plantFilter(source, marker);
        await s.driver.startCage({ task: 'acme/t5', worker: 'nova', source }).catch(() => null);
        expect(existsSync(marker)).toBe(false);
      }),
  },
  {
    id: 'a-failed-archive-refuses-the-export',
    rule: 'an empty repo and a repo with a corrupt object both fail with git archive and leave nothing behind',
    run: async (s) => {
      const empty = folder(tempDir('contract-nohead'), 'source');
      git(empty, 'init', '-q', '-b', 'main');
      await expect(s.driver.startCage({ task: 'acme/t8', worker: 'nova', source: empty })).rejects.toThrow(
        /git archive/,
      );
      const half = folder(tempDir('contract-halfway'), 'source');
      git(half, 'init', '-q', '-b', 'main');
      writeFileSync(join(half, 'a.txt'), 'a'.repeat(8704));
      writeFileSync(join(half, 'zz.txt'), 'last\n');
      git(half, 'add', '-A');
      git(half, 'commit', '-qm', 'two files');
      const blob = execFileSync('git', ['rev-parse', 'HEAD:zz.txt'], { cwd: half, encoding: 'utf8' }).trim();
      const loose = join(half, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
      chmodSync(loose, 0o644);
      writeFileSync(loose, 'garbage');
      await expect(s.driver.startCage({ task: 'acme/t9', worker: 'nova', source: half })).rejects.toThrow(
        /git archive/,
      );
      await clean(s);
    },
  },
  {
    id: 'every-protected-file-is-removed',
    rule: 'every protected file is gone from the export, not only the first, and ordinary files stay',
    run: (s) =>
      using(s, async () => {
        const canary = `CANARY_${randomBytes(6).toString('hex')}`;
        const source = fixtureRepo(canary);
        mkdirSync(join(source, 'sub'));
        writeFileSync(join(source, 'sub', '.env'), `SECOND=${canary}\n`);
        writeFileSync(join(source, 'id_rsa'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${canary}\n`);
        git(source, 'add', '-A', '-f');
        git(source, 'commit', '-qm', 'more secrets');
        const cage = await s.driver.startCage({ task: 'acme/t6', worker: 'nova', source });
        for (const path of ['.env', 'sub/.env', 'id_rsa']) expect(await present(s, cage, `/work/${path}`)).toBe(false);
        expect(await present(s, cage, '/work/hello.js')).toBe(true);
      }),
  },
  {
    id: 'a-missing-image-names-the-build-command',
    rule: 'a missing image fails with the build command for this engine and leaves nothing behind',
    run: async (s) => {
      const failure = await s.missingImage.driver
        .startCage({ task: 'acme/t3', worker: 'nova', source: fixtureRepo('c') })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toContain(`${s.engine} build -t ${s.missingImage.image}`);
      await expect(s.missingImage.driver.leftovers()).resolves.toEqual({ containers: [], networks: [] });
    },
  },
  {
    id: 'a-bad-source-leaves-nothing-behind',
    rule: 'a source that is not a directory is refused and leaves no container or network',
    run: async (s) => {
      const failure = await s.driver
        .startCage({ task: 'acme/t4', worker: 'nova', source: join(s.home, 'nope') })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      await clean(s);
    },
  },
  {
    id: 'exec-needs-a-running-cage',
    rule: 'exec on a cage that is not running fails instead of running anywhere',
    run: async (s) => {
      await expect(s.driver.exec('no-such-cage-000000', probe.sh('has', 'true', '/'))).rejects.toThrow(/no cage/);
    },
  },
];
