import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/test/helpers.ts';
import { refusesTestSide, testSideOf } from '../testside.ts';

const put = (root: string, rel: string, text = ''): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe('runner config literals', () => {
  it('treats bare and dot-relative paths named by a config as test-side, relative to the config directory', () => {
    const tree = tempDir('side-tree');
    put(
      tree,
      'vitest.config.ts',
      `export default { test: { setupFiles: ['vitest.setup.ts', 'src/setup-env.ts', './dot.ts'] } };`,
    );
    put(tree, 'vitest.setup.ts');
    put(tree, 'src/setup-env.ts');
    put(tree, 'dot.ts');
    put(tree, 'src/other.ts');
    put(tree, 'pkg/vitest.config.ts', `export default { setupFiles: ["setup/boot.js"] };`);
    put(tree, 'pkg/setup/boot.ts');
    put(tree, 'setup/boot.ts');
    const side = testSideOf(tree, tempDir('side-hidden'));
    for (const path of ['vitest.setup.ts', 'src/setup-env.ts', 'dot.ts', 'pkg/setup/boot.ts']) {
      expect(refusesTestSide(side, path), path).toBe(true);
    }
    expect(refusesTestSide(side, 'src/other.ts')).toBe(false);
    expect(refusesTestSide(side, 'setup/boot.ts')).toBe(false);
  });

  it('does not protect source files for non-file strings such as ".", "src" or "node"', () => {
    const tree = tempDir('side-tree');
    put(
      tree,
      'vitest.config.ts',
      `export default { root: '.', test: { include: ['src', './'], environment: 'node' } };`,
    );
    put(tree, 'index.ts');
    put(tree, 'src/index.ts');
    put(tree, 'node.ts');
    put(tree, 'src.ts');
    const side = testSideOf(tree, tempDir('side-hidden'));
    for (const path of ['index.ts', 'src/index.ts', 'node.ts', 'src.ts']) {
      expect(refusesTestSide(side, path), path).toBe(false);
    }
  });
});
