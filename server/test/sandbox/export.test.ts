import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CageError, homeName } from '../../sandbox/container.ts';
import { ExportError, exportRepo, scanInContainer } from '../../sandbox/export.ts';
import { tempDir } from '../helpers.ts';

const answering =
  (code: number, out: string, err = '') =>
  async () => ({ code, out, err });

describe('contained scan', () => {
  it.each([
    ['garbage output', answering(0, 'not json')],
    ['empty output', answering(1, '')],
    ['a crash with a clean-looking body', answering(137, 'oops', 'killed')],
  ])('fails closed on %s', async (_name, throwaway) => {
    const result = await scanInContainer(tempDir('scan'), throwaway);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toContain('the contained scan failed');
  });

  it('passes a clean verdict through and carries issues through', async () => {
    expect(await scanInContainer(tempDir('scan'), answering(0, '{"clean":true,"issues":[]}'))).toEqual({
      clean: true,
      issues: [],
    });
    expect((await scanInContainer(tempDir('scan'), answering(1, '{"clean":false,"issues":["x"]}'))).clean).toBe(false);
  });
});

describe('export', () => {
  it('refuses a source that is not a directory and a destination that is not empty', async () => {
    const root = tempDir('export');
    await expect(exportRepo(join(root, 'none'), join(root, 'd'), answering(0, ''))).rejects.toBeInstanceOf(ExportError);
  });

  it('fails when the contained archive step fails', async () => {
    const root = tempDir('export');
    await expect(exportRepo(root, join(root, 'd'), answering(1, '', 'boom'))).rejects.toThrow('boom');
  });
});

describe('export mounts', () => {
  it('mounts the source read-only and the destination writable', async () => {
    const root = tempDir('export-mounts');
    const calls: string[][] = [];
    await exportRepo(root, join(root, 'd'), async (_args, mounts) => {
      calls.push(mounts);
      return { code: 0, out: '', err: '' };
    });
    const [archive] = calls;
    expect(archive?.join(' ')).toMatch(/dst=\/src,readonly/);
    expect(archive?.join(' ')).toMatch(/dst=\/work(?!,readonly)/);
  });
});

describe('worker home names', () => {
  it('give different workers different homes, including ones that slug alike', () => {
    const names = ['Nova', 'nova', 'nova!', 'nova-', '!!!', '???', 'a b', 'a-b', 'é', 'è'].map(homeName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it('uses a hash long enough that distinct workers do not share a home', () => {
    expect(homeName('nova')).toMatch(/^nova-[0-9a-f]{24}$/);
    const names = Array.from({ length: 3000 }, (_, i) => homeName(`worker ${i}`));
    expect(new Set(names).size).toBe(names.length);
  });

  it('names a home deterministically and refuses an empty worker', () => {
    expect(homeName('nova')).toBe(homeName('nova'));
    expect(() => homeName('')).toThrow(CageError);
    expect(() => homeName('  ')).toThrow(CageError);
  });
});
