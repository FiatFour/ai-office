import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { refusesTestSide, testSideOf } from '../testside.ts';

const write = (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
};

describe('testSideOf runner config literals', () => {
  it('treats bare relative literals in a runner config as test-side', () => {
    const tree = tempDir('testside-tree');
    write(tree, {
      'vitest.config.ts': "export default { test: { setupFiles: ['vitest.setup.ts', 'src/setup-env.ts'] } };",
      'vitest.setup.ts': '',
      'src/setup-env.ts': '',
      'src/app.ts': '',
    });
    const side = testSideOf(tree, tempDir('testside-hidden'));
    expect(refusesTestSide(side, 'vitest.setup.ts')).toBe(true);
    expect(refusesTestSide(side, 'src/setup-env.ts')).toBe(true);
    expect(refusesTestSide(side, 'src/app.ts')).toBe(false);
  });

  it('resolves bare literals against the config directory', () => {
    const tree = tempDir('testside-nested');
    write(tree, {
      'pkg/vitest.config.ts': "export default { test: { setupFiles: ['setup.ts'] } };",
      'pkg/setup.ts': '',
      'setup.ts': '',
    });
    const side = testSideOf(tree, tempDir('testside-hidden'));
    expect(refusesTestSide(side, 'pkg/setup.ts')).toBe(true);
    expect(refusesTestSide(side, 'setup.ts')).toBe(false);
  });
});
