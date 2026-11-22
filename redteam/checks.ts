import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../server/sandbox/git-scan.mjs';
import { hookScript } from '../spikes/P0-6/guard5.mjs';
import type { CanarySet } from './canary.ts';

const GUARD = fileURLToPath(new URL('../spikes/P0-6/guard5.mjs', import.meta.url));

const git = (cwd: string, args: readonly string[], allowFail = false): { code: number; out: string } => {
  try {
    const out = execFileSync(
      'git',
      ['-c', 'user.name=redteam', '-c', 'user.email=redteam@example.test', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out };
  } catch (error) {
    if (!allowFail) throw error;
    const e = error as { status?: number; stderr?: string; stdout?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

export interface CheckResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly layer: string;
  readonly tool: string;
  readonly detail: string;
}

export const trackedSecretCheck = (canaries: CanarySet, parent: string = tmpdir()): CheckResult => {
  const repo = mkdtempSync(join(parent, 'redteam-tracked-'));
  const value = canaries.issue('tracked-env');
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.env'), `API_KEY=${value}\n`);
  writeFileSync(join(repo, 'README.md'), '# line repo\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'oops, tracked .env']);
  const dirty = scanRepo(repo);
  const text = dirty.issues.join(' ');
  const refused = dirty.clean === false && text.includes('git rm --cached');
  git(repo, ['rm', '--cached', '-q', '.env']);
  git(repo, ['commit', '-qm', 'untrack .env']);
  const afterUntrack = scanRepo(repo);
  const lines = [
    `preflight on a repo with a tracked .env: clean=${dirty.clean} protected=${dirty.protectedPaths.join(',')}`,
    `preflight message names the fix: ${text.includes('git rm --cached')}`,
    `after git rm --cached and a commit the history still holds the file: clean=${afterUntrack.clean}`,
  ];
  return {
    ok: refused,
    lines,
    layer: 'PF',
    tool: 'cage start preflight',
    detail: `refused a repo with a tracked .env and said ${text.includes('git rm --cached') ? 'git rm --cached' : 'nothing useful'}`,
  };
};

export const prePushCheck = (canaries: CanarySet, parent: string = tmpdir()): CheckResult => {
  const root = mkdtempSync(join(parent, 'redteam-push-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'work');
  mkdirSync(repo);
  git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# worker repo\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main']);
  const hook = join(repo, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, hookScript('pre-push', { guard: GUARD, base: ['main'] }));
  chmodSync(hook, 0o755);

  git(repo, ['checkout', '-q', '-b', 'aw/clean']);
  writeFileSync(join(repo, 'greeting.txt'), 'hello\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'clean change']);
  const clean = git(repo, ['push', 'origin', 'aw/clean'], true);

  const fake = `AKIA${canaries
    .issue('worker-diff-entropy')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(-16)
    .padEnd(16, 'X')}`;
  canaries.add('worker-diff-key', fake);
  git(repo, ['checkout', '-q', '-b', 'aw/leaky']);
  writeFileSync(join(repo, 'config.ts'), `export const awsKeyId = '${fake}';\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'add config']);
  const leaky = git(repo, ['push', 'origin', 'aw/leaky'], true);
  const onRemote = git(remote, ['branch', '--list', 'aw/leaky'], true).out.trim();
  const refused = leaky.code !== 0 && onRemote === '' && clean.code === 0;
  return {
    ok: refused,
    lines: [
      `control push of a clean branch: exit ${clean.code}`,
      `push of a branch whose diff holds a fake AWS key id (${fake.length} characters): exit ${leaky.code}, branch on the remote: ${onRemote === '' ? 'no' : 'yes'}`,
      `hook output: ${leaky.out.trim().split('\n').slice(0, 3).join(' | ')}`,
    ],
    layer: 'L5',
    tool: 'git push origin aw/leaky',
    detail: 'a fake key in the worker diff',
  };
};

export const hookInstalled = (repo: string): boolean => existsSync(join(repo, '.git', 'hooks', 'pre-push'));
