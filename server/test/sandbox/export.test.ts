import { describe, expect, it } from 'vitest';
import { ExportError, exportRepo, scanInContainer } from '../../sandbox/export.ts';
import { tempDir } from '../helpers.ts';
import { join } from 'node:path';

const answering = (code: number, out: string, err = '') => async () => ({ code, out, err });

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
