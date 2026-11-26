import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { refusesTestSide, testSideOf } from '../testside.ts';

const plant = (root: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
};

describe('testSideOf runner config literals', () => {
  it('treats bare and dotted paths named by a config as test-side, relative to the config directory', () => {
    const tree = tempDir('testside-tree');
    const hidden = tempDir('testside-hidden');
    plant(tree, {
      'vitest.config.ts': `export default { test: { setupFiles: ['vitest.setup.ts', 'src/setup-env.ts', './dotted.ts'] } };\n`,
      'vitest.setup.ts': '',
      'src/setup-env.ts': '',
      'dotted.ts': '',
      'src/app.ts': '',
      'pkg/vitest.config.ts': `export default { test: { setupFiles: ['setup/local.ts'] } };\n`,
      'pkg/setup/local.ts': '',
      'setup/local.ts': '',
    });
    const side = testSideOf(tree, hidden);
    for (const path of ['vitest.setup.ts', 'src/setup-env.ts', 'dotted.ts', 'pkg/setup/local.ts'])
      expect(refusesTestSide(side, path), path).toBe(true);
    expect(refusesTestSide(side, 'src/app.ts')).toBe(false);
    expect(refusesTestSide(side, 'setup/local.ts')).toBe(false);
  });
});
