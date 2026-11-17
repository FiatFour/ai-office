import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { canonicalJson, writeAtomic } from './store/atomic.ts';

export interface RepoEntry {
  readonly id: string;
  readonly remote: string | null;
  readonly path: string;
}

export interface Factory {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly repos: readonly string[];
}

export interface RegistryView {
  readonly factories: readonly Factory[];
  readonly repos: readonly RepoEntry[];
}

export class RegistryError extends Error {}

const canonicalPath = (path: string): string => {
  const real = realpathSync(resolve(path));
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
};

export const repoIdFrom = (remote: string | null, path: string): string => {
  if (remote === null) return `local:${canonicalPath(path)}`;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/i.exec(remote.trim()) ?? [];
  const [, host, rest] = m;
  if (host === undefined || rest === undefined) throw new RegistryError(`cannot read the remote ${remote}`);
  return `${host}/${rest}`.toLowerCase();
};

export class Registry {
  private readonly reposPath: string;
  private readonly factoriesPath: string;
  private repos: Record<string, RepoEntry>;
  private factories: Record<string, Factory>;

  constructor(home: string) {
    mkdirSync(home, { recursive: true });
    this.reposPath = join(home, 'repos.json');
    this.factoriesPath = join(home, 'factories.json');
    this.repos = this.read<RepoEntry>(this.reposPath, 'repos');
    this.factories = this.read<Factory>(this.factoriesPath, 'factories');
  }

  private read<T>(path: string, key: string): Record<string, T> {
    if (!existsSync(path)) return {};
    return (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, T>>)[key] ?? {};
  }

  private save(): void {
    writeAtomic(this.reposPath, canonicalJson({ v: 1, repos: this.repos }));
    writeAtomic(this.factoriesPath, canonicalJson({ v: 1, factories: this.factories }));
  }

  view(): RegistryView {
    return {
      factories: Object.values(this.factories).sort((a, b) => (a.id < b.id ? -1 : 1)),
      repos: Object.values(this.repos).sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
  }

  addFactory(root: string, name?: string): { factory: Factory; created: boolean } {
    const id = canonicalPath(root);
    const known = this.factories[id];
    if (known !== undefined) return { factory: known, created: false };
    const factory: Factory = { id, name: name ?? (basename(id) || id), root: resolve(root), repos: [] };
    this.factories = { ...this.factories, [id]: factory };
    this.save();
    return { factory, created: true };
  }

  addRepo(factoryRoot: string, spec: { path: string; remote?: string | null }): { repo: RepoEntry; changed: boolean } {
    const factory = this.factories[canonicalPath(factoryRoot)];
    if (factory === undefined) throw new RegistryError(`no factory at ${factoryRoot}`);
    const remote = spec.remote ?? null;
    const id = repoIdFrom(remote, spec.path);
    const repo = this.repos[id] ?? { id, remote, path: resolve(spec.path) };
    const isNew = this.repos[id] === undefined;
    const joins = !factory.repos.includes(id);
    if (!isNew && !joins) return { repo, changed: false };
    if (isNew) this.repos = { ...this.repos, [id]: repo };
    if (joins) {
      this.factories = { ...this.factories, [factory.id]: { ...factory, repos: [...factory.repos, id].sort() } };
    }
    this.save();
    return { repo, changed: true };
  }
}
