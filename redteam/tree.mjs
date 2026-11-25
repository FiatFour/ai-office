import { spawnSync } from 'node:child_process';

/**
 * Paths git reports as changed under `root`: modified, staged and untracked. Untracked files count, because a new
 * file is as much a change to the tree as an edit.
 * @param {string} root
 * @returns {string[]}
 */
export const dirtyPaths = (root) => {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git status failed in ${root}: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter((line) => line !== '');
};

/**
 * `<sha>` for a clean tree, `<sha> (uncommitted changes)` otherwise, untracked files included.
 * @param {string} root
 */
export const commitMarker = (root) => {
  const sha = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return `${sha}${dirtyPaths(root).length === 0 ? '' : ' (uncommitted changes)'}`;
};
