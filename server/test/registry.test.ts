import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
});
