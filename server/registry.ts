import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const caseKey = (path: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;

const canonicalPath = (path: string): string => caseKey(realpathSync.native(resolve(path)));

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'ssh:': '22',
  'git+ssh:': '22',
  'ssh+git:': '22',
  'git:': '9418',
};

const SCP_LIKE = /^(?:[^@/:\\]+@)?([^/:\\]{2,}):(?!\/\/)(.+)$/;

const trimRepoPath = (path: string): string =>
  path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '');

const localRemoteId = (remote: string, clone: string): string => {
  const path = resolve(clone, remote).replaceAll('\\', '/');
  return `file:${trimRepoPath(path.replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}:`))}`;
};

export const repoIdFrom = (remote: string | null, path: string): string => {
  if (remote === null) return `local:${canonicalPath(path)}`;
  const text = remote.trim();
  if (/^file:\/\//i.test(text)) return localRemoteId(fileURLToPath(text), path);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const port = url.port === '' || DEFAULT_PORTS[url.protocol] === url.port ? '' : `:${url.port}`;
      return `${url.hostname}${port}/${trimRepoPath(decodeURIComponent(url.pathname))}`.toLowerCase();
    } catch {
      return `local:${canonicalPath(path)}`;
    }
  }
  const scp = SCP_LIKE.exec(text);
  if (scp?.[1] !== undefined && scp[2] !== undefined) return `${scp[1]}/${trimRepoPath(scp[2])}`.toLowerCase();
  return localRemoteId(text, path);
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
    const real = realpathSync(resolve(spec.path));
    const remote = spec.remote ?? null;
    const known = Object.values(this.repos).find((entry) => caseKey(entry.path) === caseKey(real));
    const id = remote === null && known !== undefined ? known.id : repoIdFrom(remote, real);
    const renamed = known !== undefined && known.id !== id;
    const existing = this.repos[id];
    const repo = existing ?? { id, remote: remote ?? known?.remote ?? null, path: known?.path ?? real };
    const joins = !(this.factories[factory.id]?.repos ?? factory.repos).includes(id);
    if (existing !== undefined && !joins && !renamed) return { repo, changed: false };
    const repos = { ...this.repos };
    if (renamed && known !== undefined) delete repos[known.id];
    repos[id] = repo;
    this.repos = repos;
    this.factories = Object.fromEntries(
      Object.entries(this.factories).map(([key, each]) => {
        const swapped = renamed && known !== undefined ? each.repos.map((r) => (r === known.id ? id : r)) : each.repos;
        const list = key === factory.id && joins ? [...swapped, id] : swapped;
        return [key, { ...each, repos: [...new Set(list)].sort() }];
      }),
    );
    this.save();
    return { repo, changed: true };
  }
}
