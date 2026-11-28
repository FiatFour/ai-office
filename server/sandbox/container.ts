import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { insideCage } from '../config.ts';
import type { Engine, RunResult } from './engine.ts';
import { exportPath, exportRepo, mount, scanInContainer, userArgs } from './export.ts';
import {
  addressOn,
  type CageIdentity,
  DEFAULT_ALLOWLIST,
  type Denial,
  type Firewall,
  type FirewallPolicy,
  filterArgs,
  hardenedArgs,
  labelArgs,
  lines,
  lowerFirewall,
  PROXY_PORT,
  raiseFirewall,
  writeAllowlist,
  writeCages,
} from './firewall.ts';
import { parseAllowlist } from './proxy/allowlist.mjs';
import { siteOf } from './site.ts';

export interface CageView {
  readonly id: string;
  readonly task: string;
  readonly worker: string;
  readonly container: string;
  readonly workdir: string;
  readonly engine: string;
  readonly startedAt: number;
}

export interface DriverOptions {
  readonly engine: Engine;
  readonly home: string;
  readonly hq: string;
  readonly image: string;
  readonly project?: string;
  readonly allowlist?: readonly string[];
  readonly workerAllow?: FirewallPolicy['workers'];
  readonly homeWorker?: (worker: string) => string;
  readonly onDenial?: (denial: Denial) => void;
}

export class CageError extends Error {}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export const homeName = (worker: string): string => {
  if (worker.trim() === '') throw new CageError('a worker name cannot be empty');
  return `${slug(worker) || 'worker'}-${createHash('sha256').update(worker).digest('hex').slice(0, 24)}`;
};

export class SandboxDriver {
  readonly engine: Engine;
  private readonly home: string;
  private readonly hq: string;
  private readonly image: string;
  private readonly project: string;
  private allowlist: readonly string[];
  private readonly workerAllow: FirewallPolicy['workers'];
  /** The registry the proxy reads, by cage address. */
  private readonly identities = new Map<string, CageIdentity>();
  private readonly addresses = new Map<string, string>();
  private readonly homeWorker: (worker: string) => string;
  private readonly onDenial: (denial: Denial) => void;
  private firewall: Promise<Firewall> | null = null;
  private rootless: boolean | null = null;
  private readonly cages = new Map<string, CageView>();

  constructor(options: DriverOptions) {
    this.engine = options.engine;
    this.home = options.home;
    this.homeWorker = options.homeWorker ?? ((worker) => worker);
    this.hq = options.hq;
    this.image = options.image;
    this.project = options.project ?? 'agent-works';
    this.allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
    this.workerAllow = options.workerAllow ?? {};
    this.onDenial = options.onDenial ?? (() => {});
  }

  list(): CageView[] {
    return [...this.cages.values()];
  }

  /** The project's rules now: the policy's, and every site a person has allowed since. */
  rules(): readonly string[] {
    return this.allowlist;
  }

  private async user(): Promise<string[]> {
    this.rootless ??= (await this.engine.info()).rootless;
    return userArgs(this.engine, this.rootless);
  }

  async throwaway(args: string[], mounts: string[]) {
    return this.engine.run(
      [
        'run',
        '--rm',
        ...labelArgs(this.project, this.hq, 'throwaway'),
        '--network',
        'none',
        ...hardenedArgs(),
        '--pids-limit',
        '256',
        '--memory',
        '2g',
        ...(await this.user()),
        '-e',
        'HOME=/tmp',
        ...mounts,
        '--entrypoint',
        args[0] ?? 'true',
        this.image,
        ...args.slice(1),
      ],
      { timeoutMs: 300_000 },
    );
  }

  private async requireImage(): Promise<void> {
    const found = await this.engine.run(['image', 'inspect', this.image], { timeoutMs: 30_000 });
    if (found.code !== 0) {
      throw new CageError(
        `the cage image ${this.image} is not on this ${this.engine.name}. Build it with: ${this.engine.name} build -t ${this.image} -f server/sandbox/Containerfile server/sandbox`,
      );
    }
  }

  private raise(): Promise<Firewall> {
    this.firewall ??= raiseFirewall({
      engine: this.engine,
      project: this.project,
      hq: this.hq,
      image: this.image,
      dir: join(this.home, 'sandbox', this.hq),
      allowlist: this.allowlist,
      onDenial: this.onDenial,
    }).catch(async (error) => {
      this.firewall = null;
      await lowerFirewall(this.engine, this.project, this.hq);
      throw error;
    });
    return this.firewall;
  }

  async startCage(spec: { task: string; worker: string; source: string }): Promise<CageView> {
    if (insideCage(this.home, spec.source))
      throw new CageError(
        `${spec.source} is inside a cage or a worker home, which an agent can write. Export from the operator's own clone instead.`,
      );
    await this.requireImage();
    const homeSlug = homeName(this.homeWorker(spec.worker));
    const id = `${slug(spec.task)}-${randomBytes(3).toString('hex')}`;
    const cageDir = join(this.home, 'cages', id);
    const repo = exportPath(join(this.home, 'cages'), id);
    const homeDir = join(this.home, 'homes', homeSlug);
    mkdirSync(homeDir, { recursive: true });
    try {
      const run = (args: string[], mounts: string[]) => this.throwaway(args, mounts);
      await exportRepo(spec.source, repo, run);
      const scan = await scanInContainer(repo, run);
      if (!scan.clean) throw new CageError(`preflight refused the export: ${scan.issues.join(' ')}`);
      const firewall = await this.raise();
      const proxy = `http://${encodeURIComponent(spec.worker)}:x@${firewall.proxyIp}:${PROXY_PORT}`;
      const container = `aw-${this.hq}-cage-${id}`;
      await this.engine.ok([
        'run',
        '-d',
        '--name',
        container,
        ...labelArgs(this.project, this.hq, 'cage'),
        '--label',
        `agent-works.task=${spec.task}`,
        '--label',
        `agent-works.agent=${spec.worker}`,
        '--network',
        firewall.internal,
        ...hardenedArgs(),
        '--pids-limit',
        '1024',
        '--memory',
        '4g',
        ...(await this.user()),
        '-e',
        'HOME=/home/agent',
        // Every denial counts toward the worker pause, so the agent must not retry telemetry hosts the firewall denies.
        '-e',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        '-e',
        `HTTPS_PROXY=${proxy}`,
        '-e',
        `HTTP_PROXY=${proxy}`,
        '-e',
        'NO_PROXY=localhost,127.0.0.1',
        '-w',
        '/work',
        ...mount(repo, '/work'),
        ...mount(homeDir, '/home/agent'),
        this.image,
        'sleep',
        'infinity',
      ]);
      const address = await addressOn(this.engine, container, firewall.internal).catch(async (error: unknown) => {
        await this.engine.run(['rm', '-f', container]);
        throw error;
      });
      this.identities.set(address, {
        agent: spec.worker,
        allow: Object.hasOwn(this.workerAllow, spec.worker) ? (this.workerAllow[spec.worker] ?? []) : [],
      });
      this.addresses.set(id, address);
      writeCages(firewall.cagesPath, this.identities);
      const view: CageView = {
        id,
        task: spec.task,
        worker: spec.worker,
        container,
        workdir: repo,
        engine: this.engine.name,
        startedAt: Date.now(),
      };
      this.cages.set(id, view);
      return view;
    } catch (error) {
      rmSync(cageDir, { recursive: true, force: true });
      throw error;
    }
  }

  async exec(
    id: string,
    argv: readonly string[],
    options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<RunResult> {
    const view = this.cages.get(id);
    if (view === undefined) throw new CageError(`no cage ${id} is running`);
    return this.engine.run(['exec', '-i', '-w', '/work', view.container, ...argv], options);
  }

  async allow(rule: string): Promise<void> {
    parseAllowlist(rule);
    if (siteOf(rule)?.site !== rule) throw new Error(`allowlist: not a host rule: ${JSON.stringify(rule)}`);
    const { allowlistPath } = await this.raise();
    const current = lines(readFileSync(allowlistPath, 'utf8'));
    if (current.includes(rule)) return;
    writeAllowlist(allowlistPath, [...current, rule]);
    this.allowlist = [...current, rule];
  }

  async releaseCage(id: string): Promise<boolean> {
    const view = this.cages.get(id);
    if (view === undefined) return false;
    await this.engine.run(['rm', '-f', view.container]);
    this.cages.delete(id);
    this.identities.delete(this.addresses.get(id) ?? '');
    this.addresses.delete(id);
    if (this.firewall !== null) writeCages((await this.firewall).cagesPath, this.identities);
    return true;
  }

  async removeAll(): Promise<{ containers: number; networks: number }> {
    const filter = filterArgs(this.project, this.hq);
    const before = lines(await this.engine.ok(['ps', '-aq', ...filter])).length;
    const firewall = this.firewall === null ? null : await this.firewall.catch(() => null);
    firewall?.stop();
    await lowerFirewall(this.engine, this.project, this.hq);
    const networks = lines(await this.engine.ok(['network', 'ls', '-q', ...filter])).length;
    this.cages.clear();
    this.identities.clear();
    this.addresses.clear();
    this.firewall = null;
    return { containers: before, networks };
  }

  async leftovers(): Promise<{ containers: string[]; networks: string[] }> {
    const filter = filterArgs(this.project, this.hq);
    const names = async (args: string[]) => lines(await this.engine.ok(args));
    return {
      containers: await names(['ps', '-a', ...filter, '--format', '{{.Names}}']),
      networks: await names(['network', 'ls', ...filter, '--format', '{{.Name}}']),
    };
  }
}
