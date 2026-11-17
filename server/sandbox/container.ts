import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from './engine.ts';
import { exportPath, exportRepo, scanInContainer, userArgs } from './export.ts';
import {
  DEFAULT_ALLOWLIST,
  type Denial,
  type Firewall,
  HQ_LABEL,
  hardenedArgs,
  labelArgs,
  lowerFirewall,
  PROJECT_LABEL,
  PROXY_PORT,
  raiseFirewall,
} from './firewall.ts';

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
  readonly onDenial?: (denial: Denial) => void;
}

export class CageError extends Error {}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export class SandboxDriver {
  readonly engine: Engine;
  private readonly home: string;
  private readonly hq: string;
  private readonly image: string;
  private readonly project: string;
  private readonly allowlist: readonly string[];
  private readonly onDenial: (denial: Denial) => void;
  private firewall: Promise<Firewall> | null = null;
  private rootless: boolean | null = null;
  private readonly cages = new Map<string, CageView>();

  constructor(options: DriverOptions) {
    this.engine = options.engine;
    this.home = options.home;
    this.hq = options.hq;
    this.image = options.image;
    this.project = options.project ?? 'agent-works';
    this.allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
    this.onDenial = options.onDenial ?? (() => {});
  }

  list(): CageView[] {
    return [...this.cages.values()];
  }

  private async user(): Promise<string[]> {
    this.rootless ??= (await this.engine.info()).rootless;
    return userArgs(this.engine, this.rootless);
  }

  private async throwaway(args: string[], mounts: string[]) {
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
        '-w',
        '/work',
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
    await this.requireImage();
    const id = `${slug(spec.task)}-${randomBytes(3).toString('hex')}`;
    const cageDir = join(this.home, 'cages', id);
    const repo = exportPath(join(this.home, 'cages'), id);
    const homeDir = join(this.home, 'homes', slug(spec.worker));
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
        '-e',
        `HTTPS_PROXY=${proxy}`,
        '-e',
        `HTTP_PROXY=${proxy}`,
        '-e',
        'NO_PROXY=localhost,127.0.0.1',
        '-w',
        '/work',
        '--mount',
        `type=bind,src=${repo},dst=/work`,
        '--mount',
        `type=bind,src=${homeDir},dst=/home/agent`,
        this.image,
        'sleep',
        'infinity',
      ]);
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

  async releaseCage(id: string): Promise<boolean> {
    const view = this.cages.get(id);
    if (view === undefined) return false;
    await this.engine.run(['rm', '-f', view.container]);
    this.cages.delete(id);
    return true;
  }

  async removeAll(): Promise<{ containers: number; networks: number }> {
    const filter = ['--filter', `label=${PROJECT_LABEL}=${this.project}`, '--filter', `label=${HQ_LABEL}=${this.hq}`];
    const before = (await this.engine.ok(['ps', '-aq', ...filter])).split('\n').filter(Boolean).length;
    const firewall = this.firewall === null ? null : await this.firewall.catch(() => null);
    firewall?.stop();
    await lowerFirewall(this.engine, this.project, this.hq);
    const networks = (await this.engine.ok(['network', 'ls', '-q', ...filter])).split('\n').filter(Boolean).length;
    this.cages.clear();
    this.firewall = null;
    return { containers: before, networks };
  }

  async leftovers(): Promise<{ containers: string[]; networks: string[] }> {
    const filter = ['--filter', `label=${PROJECT_LABEL}=${this.project}`, '--filter', `label=${HQ_LABEL}=${this.hq}`];
    const names = async (args: string[]) => (await this.engine.ok(args)).split('\n').filter(Boolean);
    return {
      containers: await names(['ps', '-a', ...filter, '--format', '{{.Names}}']),
      networks: await names(['network', 'ls', ...filter, '--format', '{{.Name}}']),
    };
  }
}
