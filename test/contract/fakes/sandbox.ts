import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { insideCage } from '../../../server/config.ts';
import { CageError, type CageView } from '../../../server/sandbox/container.ts';
import type { RunResult } from '../../../server/sandbox/engine.ts';
import { DEFAULT_ALLOWLIST, type Denial } from '../../../server/sandbox/firewall.ts';
import { HOST_UID, PROBE_ID, type SandboxLike, type SandboxSubject } from '../sandbox.contract.ts';

export type SandboxFault =
  | 'leaks-secrets'
  | 'runs-as-root'
  | 'open-network'
  | 'silent-denials'
  | 'release-twice'
  | 'keeps-containers'
  | 'accepts-cage-source'
  | 'throwaway-networked'
  | 'filters-run-on-host'
  | 'empty-export-ok'
  | 'vague-missing-image'
  | 'half-started-on-error'
  | 'exec-anywhere'
  | 'allow-anything'
  | 'work-read-only';

const PROTECTED = new Set(['.env', 'id_rsa']);

const ok = (out: string, code = 0): RunResult => ({ code, out, err: '', timedOut: false });

const gitOut = (cwd: string, ...args: string[]): Buffer =>
  execFileSync('git', args, { cwd, stdio: 'pipe', maxBuffer: 1 << 26 });

export class FakeSandbox implements SandboxLike {
  readonly denied: Denial[] = [];
  private readonly cages = new Map<string, CageView>();
  private readonly containers = new Set<string>();
  private readonly allowed = new Set<string>(DEFAULT_ALLOWLIST);
  private released = new Set<string>();
  private count = 0;

  constructor(
    private readonly home: string,
    private readonly image: string,
    private readonly faults: ReadonlySet<SandboxFault> = new Set(),
  ) {}

  list(): CageView[] {
    return [...this.cages.values()];
  }

  private export(source: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    if (this.faults.has('filters-run-on-host'))
      execFileSync('git', ['checkout-index', '-a', '-f', `--prefix=${dest}.host/`], { cwd: source, stdio: 'pipe' });
    let tree: string[];
    try {
      tree = gitOut(source, 'ls-tree', '-r', '--name-only', '-z', 'HEAD').toString('utf8').split('\0').filter(Boolean);
    } catch (error) {
      if (this.faults.has('empty-export-ok')) return;
      throw new CageError(`git archive failed: ${(error as Error).message.split('\n')[0]}`);
    }
    for (const path of tree) {
      const protectedFile = PROTECTED.has(path.split('/').at(-1) ?? '');
      if (protectedFile && !this.faults.has('leaks-secrets')) continue;
      let content: Buffer;
      try {
        content = gitOut(source, 'cat-file', 'blob', `HEAD:${path}`);
      } catch (error) {
        if (this.faults.has('empty-export-ok')) continue;
        throw new CageError(`git archive failed: ${(error as Error).message.split('\n')[0]}`);
      }
      mkdirSync(dirname(join(dest, path)), { recursive: true });
      writeFileSync(join(dest, path), content);
    }
  }

  async startCage(spec: { task: string; worker: string; source: string }): Promise<CageView> {
    if (!this.faults.has('accepts-cage-source') && insideCage(this.home, spec.source))
      throw new CageError(`${spec.source} is inside a cage or a worker home`);
    if (this.image.startsWith('aw-no-such-image')) {
      throw new CageError(
        this.faults.has('vague-missing-image')
          ? 'the cage image is missing'
          : `missing. Build it with: fake build -t ${this.image}`,
      );
    }
    this.count += 1;
    const id = `${spec.task.replace(/\W+/g, '-')}-${this.count}`;
    const container = `fake-cage-${id}`;
    if (this.faults.has('half-started-on-error')) this.containers.add(container);
    const repo = join(this.home, 'cages', id, 'repo');
    this.export(spec.source, repo);
    this.containers.add(container);
    const view: CageView = {
      id,
      task: spec.task,
      worker: spec.worker,
      container,
      workdir: repo,
      engine: 'fake',
      startedAt: Date.now(),
    };
    this.cages.set(id, view);
    return view;
  }

  private hardened(): string {
    const root = this.faults.has('runs-as-root');
    return `${root ? 0 : HOST_UID}\nCapBnd:\t${root ? '000001ffffffffff' : '0000000000000000'}\nNoNewPrivs:\t1\nroot ro,relatime\n`;
  }

  private answer(view: CageView | null, argv: readonly string[]): RunResult {
    const text = argv.join(' ');
    const id = PROBE_ID.exec(text)?.[1];
    const args = (text.split('\n')[0] ?? '').split(`probe:${id}`)[1]?.trim() ?? '';
    const work = (path: string) => join(view?.workdir ?? '', path.replace(/^\/work\/?/, ''));
    switch (id) {
      case 'has':
        return ok('', args.startsWith('/work/.git') || existsSync(work(args)) ? 0 : 1);
      case 'leak-scan': {
        const files = readdirSync(view?.workdir ?? '.', { recursive: true, withFileTypes: true }).filter((e) =>
          e.isFile(),
        );
        const hit = files.find((e) => readFileSync(join(e.parentPath, e.name), 'utf8').includes(args));
        return ok(hit === undefined ? '' : `${join(hit.parentPath, hit.name)}\n`);
      }
      case 'commits':
        return ok('1\n');
      case 'write':
        if (this.faults.has('work-read-only')) return ok('', 1);
        writeFileSync(work('owned.txt'), 'owned\n');
        return ok('');
      case 'hardened':
        return ok(this.hardened());
      case 'raw-connect':
        return ok(this.faults.has('open-network') ? 'CONNECTED\n' : 'FAILED ECONNREFUSED\n');
      case 'connect': {
        const target = /path:'([^']+)'/.exec(text)?.[1] ?? '';
        const host = target.split(':')[0] ?? '';
        if (this.allowed.has(host)) return ok('STATUS 200\n');
        if (!this.faults.has('silent-denials'))
          this.denied.push({
            host,
            port: 443,
            agent: view?.worker ?? '',
            reason: 'not-allowlisted',
            at: new Date().toISOString(),
          });
        return ok('STATUS 403\n');
      }
      case 'net-interfaces':
        return ok(this.faults.has('throwaway-networked') ? 'eth0\nlo\n' : 'lo\n');
      default:
        return ok('', 127);
    }
  }

  async exec(id: string, argv: readonly string[]): Promise<RunResult> {
    const view = this.cages.get(id) ?? null;
    if (view === null && !this.faults.has('exec-anywhere')) throw new CageError(`no cage ${id} is running`);
    return this.answer(view, argv);
  }

  async throwaway(args: string[], _mounts: string[]): Promise<RunResult> {
    return this.answer(null, args);
  }

  async allow(rule: string): Promise<void> {
    if (!this.faults.has('allow-anything') && !/^[a-z0-9]+(\.[a-z0-9-]+)+:([1-9]\d{0,4})$/.test(rule))
      throw new Error(`not a host rule: ${rule}`);
    this.allowed.add(rule.split(':')[0] ?? rule);
  }

  async releaseCage(id: string): Promise<boolean> {
    const view = this.cages.get(id);
    if (view === undefined) {
      const again = this.faults.has('release-twice') && this.released.has(id);
      return again;
    }
    this.containers.delete(view.container);
    this.cages.delete(id);
    this.released.add(id);
    return true;
  }

  async removeAll(): Promise<{ containers: number; networks: number }> {
    const containers = this.containers.size;
    const keep = this.faults.has('keeps-containers') ? [...this.containers].slice(0, 1) : [];
    this.containers.clear();
    for (const name of keep) this.containers.add(name);
    this.cages.clear();
    return { containers, networks: 1 };
  }

  async leftovers(): Promise<{ containers: string[]; networks: string[] }> {
    return { containers: [...this.containers], networks: [] };
  }
}

export const fakeSubject = (home: string, faults: readonly SandboxFault[] = []): SandboxSubject => {
  const set = new Set(faults);
  const driver = new FakeSandbox(home, 'aw-test-cage:1', set);
  const missing = 'aw-no-such-image:0';
  return {
    has: new Set(),
    driver,
    home,
    engine: 'fake',
    settleMs: 0,
    missingImage: { image: missing, driver: new FakeSandbox(home, missing, set) },
    denials: () => driver.denied,
  };
};
