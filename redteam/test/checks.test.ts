import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CanarySet } from '../canary.ts';
import { prePushCheck, trackedSecretCheck } from '../checks.ts';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit || process.platform === 'win32')('lane checks on a real git repo', () => {
  it('refuses a repo with a tracked .env and names git rm --cached', () => {
    const result = trackedSecretCheck(new CanarySet('c1'));
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('preflight message names the fix: true');
  });

  it('refuses a push whose diff holds a fake key and lets a clean push through', () => {
    const set = new CanarySet('c2');
    const result = prePushCheck(set);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toContain('exit 0');
    expect(result.lines[1]).toContain('branch on the remote: no');
    expect(set.entries().some(([kind]) => kind === 'worker-diff-key')).toBe(true);
  });

  it('does not print the fake key in its report', () => {
    const set = new CanarySet('c3');
    const result = prePushCheck(set);
    expect(set.find(result.lines.join('\n'))).toEqual([]);
  });
});
