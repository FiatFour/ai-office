import { appendFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { type CageView, type DriverOptions, SandboxDriver } from '../server/sandbox/container.ts';

export const BENCH_ALLOWLIST: readonly string[] = ['api.anthropic.com'];

export interface BenchCageOptions extends Omit<DriverOptions, 'allowlist'> {
  readonly installed: string | null;
}

export class BenchCage extends SandboxDriver {
  private readonly installed: string | null;

  constructor({ installed, ...options }: BenchCageOptions) {
    super({ ...options, allowlist: BENCH_ALLOWLIST });
    this.installed = installed;
  }

  override async startCage(spec: { task: string; worker: string; source: string }): Promise<CageView> {
    const view = await super.startCage(spec);
    const modules = this.installed === null ? null : join(this.installed, 'node_modules');
    if (modules !== null && existsSync(modules)) {
      cpSync(modules, join(view.workdir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      appendFileSync(join(view.workdir, '.git', 'info', 'exclude'), 'node_modules/\n');
    }
    return view;
  }
}
