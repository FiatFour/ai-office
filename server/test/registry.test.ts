import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Registry, repoIdFrom } from '../registry.ts';
import { folder, tempDir } from './helpers.ts';

describe('registry', () => {
  it('lets one repo belong to two factories and keeps one clone entry', () => {
    const root = tempDir('registry');
    const home = folder(root, 'home');
    const clone = folder(root, 'clone');
    const a = folder(root, 'factory-a');
    const b = folder(root, 'factory-b');
    const registry = new Registry(home);
    registry.addFactory(a);
    registry.addFactory(b);
    const remote = 'git@github.com:Acme/App.git';
    const first = registry.addRepo(a, { path: clone, remote });
    const second = registry.addRepo(b, { path: clone, remote: 'https://github.com/acme/app' });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(second.repo.id).toBe(first.repo.id);
    const view = registry.view();
    expect(view.repos).toHaveLength(1);
    expect(view.factories.map((f) => f.repos)).toEqual([[first.repo.id], [first.repo.id]]);
  });

  it('writes repos.json with one entry and both factories list the line', () => {
    const root = tempDir('registry-disk');
    const home = folder(root, 'home');
    const clone = folder(root, 'clone');
    const a = folder(root, 'a');
    const b = folder(root, 'b');
    const registry = new Registry(home);
    registry.addFactory(a);
    registry.addFactory(b);
    registry.addRepo(a, { path: clone, remote: 'https://github.com/acme/app.git' });
    registry.addRepo(b, { path: clone, remote: 'https://github.com/acme/app.git' });
    const reread = new Registry(home).view();
    expect(reread.repos.map((r) => r.id)).toEqual(['github.com/acme/app']);
    expect(reread.factories.every((f) => f.repos.includes('github.com/acme/app'))).toBe(true);
  });

  it('is idempotent and reports no change for a repeated add', () => {
    const root = tempDir('registry-idem');
    const registry = new Registry(folder(root, 'home'));
    const a = folder(root, 'a');
    const clone = folder(root, 'clone');
    registry.addFactory(a);
    expect(registry.addRepo(a, { path: clone, remote: null }).changed).toBe(true);
    expect(registry.addRepo(a, { path: clone, remote: null }).changed).toBe(false);
    expect(registry.addFactory(a).created).toBe(false);
  });

  it('refuses a repo for a factory that is not registered', () => {
    const root = tempDir('registry-missing');
    const registry = new Registry(folder(root, 'home'));
    expect(() => registry.addRepo(folder(root, 'none'), { path: folder(root, 'c'), remote: null })).toThrow(
      /no factory/,
    );
  });

  it('names a repo by host and path whatever the remote spelling', () => {
    for (const remote of [
      'git@github.com:Acme/App.git',
      'https://github.com/acme/app.git',
      'ssh://git@github.com/acme/app',
      'https://github.com/acme/app/',
    ]) {
      expect(repoIdFrom(remote, '/x')).toBe('github.com/acme/app');
    }
  });

  it('survives a corrupt file by refusing to start with it silently reset', () => {
    const root = tempDir('registry-corrupt');
    const home = folder(root, 'home');
    writeFileSync(join(home, 'repos.json'), '{not json');
    expect(() => new Registry(home)).toThrow();
  });

  it('keeps one id for one clone whether or not a remote is given, in either order', () => {
    for (const order of [
      [null, 'https://github.com/acme/app.git'],
      ['https://github.com/acme/app.git', null],
    ]) {
      const root = tempDir('registry-remote');
      const registry = new Registry(folder(root, 'home'));
      const a = folder(root, 'a');
      const clone = folder(root, 'clone');
      registry.addFactory(a);
      for (const remote of order) registry.addRepo(a, { path: clone, remote });
      const view = registry.view();
      expect(view.repos.map((r) => r.id)).toEqual(['github.com/acme/app']);
      expect(view.factories[0]?.repos).toEqual(['github.com/acme/app']);
    }
  });

  it('moves every factory to the remote id when a clone first known by path gains a remote', () => {
    const root = tempDir('registry-upgrade');
    const registry = new Registry(folder(root, 'home'));
    const [a, b, clone] = [folder(root, 'a'), folder(root, 'b'), folder(root, 'clone')] as [string, string, string];
    registry.addFactory(a);
    registry.addFactory(b);
    registry.addRepo(a, { path: clone, remote: null });
    registry.addRepo(b, { path: clone, remote: null });
    registry.addRepo(a, { path: clone, remote: 'git@github.com:acme/app.git' });
    const view = registry.view();
    expect(view.repos.map((r) => r.id)).toEqual(['github.com/acme/app']);
    expect(view.factories.map((f) => f.repos)).toEqual([['github.com/acme/app'], ['github.com/acme/app']]);
  });

  it('sees a symlinked path as the same clone and the same factory', () => {
    const root = tempDir('registry-link');
    const registry = new Registry(folder(root, 'home'));
    const real = folder(root, 'real');
    const link = join(root, 'link');
    symlinkSync(real, link, 'junction');
    const first = registry.addFactory(real).factory;
    expect(registry.addFactory(link)).toMatchObject({ created: false, factory: { id: first.id } });
    registry.addRepo(real, { path: real, remote: null });
    expect(registry.addRepo(link, { path: link, remote: null }).changed).toBe(false);
    expect(registry.view().repos).toHaveLength(1);
  });

  it('keeps the first clone path when a second clone of the same remote is added', () => {
    const root = tempDir('registry-second');
    const registry = new Registry(folder(root, 'home'));
    const [a, b, one, two] = ['a', 'b', 'one', 'two'].map((name) => folder(root, name)) as [
      string,
      string,
      string,
      string,
    ];
    registry.addFactory(a);
    registry.addFactory(b);
    const remote = 'https://github.com/acme/app.git';
    registry.addRepo(a, { path: one, remote });
    registry.addRepo(b, { path: two, remote });
    expect(registry.view().repos).toHaveLength(1);
    expect(registry.view().repos[0]?.path).toBe(one);
    expect(new Registry(join(root, 'home')).view().repos[0]?.path).toBe(one);
  });

  it('names a clone by the real path when it was added through a link, and finds it again by either path', () => {
    const root = tempDir('registry-link-path');
    const registry = new Registry(folder(root, 'home'));
    const real = folder(root, 'real');
    const link = join(root, 'link');
    symlinkSync(real, link, 'junction');
    const factory = folder(root, 'factory');
    registry.addFactory(factory);
    const first = registry.addRepo(factory, { path: link, remote: null });
    expect(first.repo.path).toBe(real);
    const second = registry.addRepo(factory, { path: real, remote: 'https://github.com/acme/app.git' });
    expect(registry.view().repos.map((r) => r.id)).toEqual(['github.com/acme/app']);
    expect(second.repo.path).toBe(real);
    const third = registry.addRepo(factory, { path: link, remote: null });
    expect(third.repo.id).toBe('github.com/acme/app');
    expect(registry.view().repos).toHaveLength(1);
  });

  describe('repo ids from the remote', () => {
    const id = (remote: string) => repoIdFrom(remote, '/clone');
    const same = [
      'git@github.com:acme/repo.git',
      'git@GitHub.com:Acme/Repo',
      'https://github.com/acme/repo',
      'https://github.com/acme/repo.git/',
      'https://github.com:443/acme/repo',
      'https://user:token@github.com/acme/repo.git',
      'http://github.com:80/acme/repo',
      'ssh://git@github.com/acme/repo.git',
      'ssh://git@github.com:22/acme/repo.git',
      'git://github.com:9418/acme/repo',
    ];

    it.each(same)('gives %s the id github.com/acme/repo', (remote) => {
      expect(id(remote)).toBe('github.com/acme/repo');
    });

    it('collapses a double slash in the path', () => {
      expect(id('https://github.com//acme/repo')).toBe('github.com/acme/repo');
      expect(id('https://github.com/acme//repo.git')).toBe('github.com/acme/repo');
      expect(id('git@github.com:acme//repo')).toBe('github.com/acme/repo');
    });

    it('reads a bracketed IPv6 host the same in scp and URL form', () => {
      expect(id('git@[::1]:org/repo')).toBe('[::1]/org/repo');
      expect(id('git@[::1]:org/repo.git')).toBe('[::1]/org/repo');
      expect(id('ssh://git@[::1]/org/repo')).toBe('[::1]/org/repo');
      expect(id('ssh://git@[::1]:2222/org/repo')).toBe('[::1]:2222/org/repo');
    });

    it('keeps a port that is not the default for the scheme', () => {
      expect(id('ssh://git@git.example.com:2222/acme/repo.git')).toBe('git.example.com:2222/acme/repo');
      expect(id('https://git.example.com:8443/acme/repo')).toBe('git.example.com:8443/acme/repo');
      expect(id('ssh://git@git.example.com:443/acme/repo.git')).toBe('git.example.com:443/acme/repo');
    });

    it('accepts a local path or file URL and gives the same stable id for both spellings', () => {
      const path = tempDir('registry-local-origin');
      const bare = join(path, 'origin.git');
      const expected = id(bare);
      expect(expected.startsWith('file:')).toBe(true);
      expect(id(pathToFileURL(bare).href)).toBe(expected);
      expect(id(`${bare}/`)).toBe(expected);
      expect(id(bare.replace(/\.git$/, ''))).toBe(expected);
      expect(repoIdFrom('../origin.git', join(path, 'clone'))).toBe(expected);
    });

    it('adds a clone whose origin is a local path', () => {
      const root = tempDir('registry-local-add');
      const registry = new Registry(folder(root, 'home'));
      const factory = folder(root, 'factory');
      registry.addFactory(factory);
      const added = registry.addRepo(factory, { path: folder(root, 'clone'), remote: join(root, 'origin.git') });
      expect(added.changed).toBe(true);
      expect(added.repo.id.startsWith('file:')).toBe(true);
    });

    it('falls back to the clone path for a remote it cannot read', () => {
      const root = tempDir('registry-odd-remote');
      const clone = folder(root, 'clone');
      expect(repoIdFrom('https://', clone)).toBe(repoIdFrom(null, clone));
    });
  });
});
