import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideCage } from '../config.ts';
import { folder, tempDir } from './helpers.ts';

const layout = () => {
  const root = tempDir('config');
  const home = folder(root, 'home');
  const cage = folder(home, 'cages/one-abc123/repo');
  const worker = folder(home, 'homes/nova-0123');
  return { root, home, cage, worker };
};

describe('insideCage', () => {
  it('refuses a cage workdir, a worker home and anything under them', () => {
    const { home, cage, worker } = layout();
    expect(insideCage(home, cage)).toBe(true);
    expect(insideCage(home, folder(cage, 'sub/deeper'))).toBe(true);
    expect(insideCage(home, worker)).toBe(true);
  });

  it('refuses the cages and homes directories themselves', () => {
    const { home } = layout();
    expect(insideCage(home, join(home, 'cages'))).toBe(true);
    expect(insideCage(home, join(home, 'homes'))).toBe(true);
  });

  it('allows the operator clone and other folders under the same home', () => {
    const { root, home } = layout();
    expect(insideCage(home, folder(root, 'clone'))).toBe(false);
    expect(insideCage(home, folder(home, 'sandbox'))).toBe(false);
    expect(insideCage(home, join(root, 'does-not-exist'))).toBe(false);
  });

  it('follows a link into a cage', () => {
    const { root, home, cage } = layout();
    const link = join(root, 'link');
    symlinkSync(cage, link, 'junction');
    expect(insideCage(home, link)).toBe(true);
  });

  it('is not fooled by another spelling of the same folder', () => {
    const { home, cage } = layout();
    const probe = cage.replace('/cages/', '/CAGES/');
    mkdirSync(cage, { recursive: true });
    if (!existsSync(probe)) return;
    expect(insideCage(home, probe)).toBe(true);
    expect(insideCage(home.replace(/home$/, 'HOME'), cage)).toBe(true);
  });
});
