import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitFixture, makeFixture } from './fixture.mjs';
import { scanRepo } from './git-scan.mjs';
import { checkToolCall, parseCommands } from './protected-paths.mjs';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

const vouched = { home: '/h', cwd: '/workspace', workspace: '/workspace', gitClean: true } as never;
const unvouched = { home: '/h', cwd: '/workspace', workspace: '/workspace', gitClean: false } as never;
const bash = (command: string, ctx = vouched) => checkToolCall({ tool_name: 'Bash', tool_input: { command } }, ctx);

describePosix('A git rules see through assignments, wrappers and option values', () => {
  it.each([
    'A=1 git -C /srv/x log -p',
    'FOO=bar git worktree add /tmp/w',
    'A=1 git update-ref refs/notes/x HEAD',
    'A=1 git config core.worktree /x',
    'A=1 git grep --no-index x',
    'A=1 B=2 git --git-dir=/srv/x log -p',
    'A= git -C /srv/x log -p',
    'A="b c" git -C /srv/x log -p',
    'env -C /srv git log',
    'env -u X git -C /srv/x log',
    'env -u HOME git -c core.worktree=/home/node add -A',
    'env A=1 git -C /srv/x log -p',
    'sudo -u root git -C /srv/x log -p',
    'sudo -u root -g wheel git worktree add /tmp/w',
    'doas -u root git -C /srv/x log',
    'timeout 5 git -C /srv/x log -p',
    'timeout -s KILL 5s git -C /srv/x log -p',
    'nice -n 5 git -C /srv/x log -p',
    'nohup git -C /srv/x log',
    'stdbuf -o0 git -C /srv/x log',
    'time git -C /srv/x log',
    'command git -C /srv/x log',
    'exec git -C /srv/x log',
    'su -c "git -C /srv/x log -p" root',
    'cd sub && A=1 git log -p',
    'A=1 cd sub && git log',
    'env -C sub git log',
    'env --chdir=sub git log -p',
    'env --chdir sub git log -p',
    'CDPATH=/srv cd sub && git log',
    'command cd sub && git log',
    'builtin cd sub && git log',
    'sudo -D sub git log',
    'A=1 git show HEAD:.env',
    'A=1 git cat-file -p HEAD:.env',
  ])('denies %s', (command) => {
    expect(bash(command).blocked).toBe(true);
  });

  it.each([
    'git log -p',
    'git status',
    'git diff',
    'git commit -m x',
    'git commit -m "cd sub"',
    'A=1 git log -p',
    'FOO=bar git status',
    'env -u X git log -p',
    'env -C /workspace git log -p',
    'sudo -u root git log',
    'timeout 5 git status',
    'nice -n 5 git diff',
    'cd /workspace && git log',
    'cd /workspace && A=1 git log -p',
    'CDPATH=/srv cd /workspace && git log',
    'git log; cd sub; ls',
  ])('allows %s', (command) => {
    expect(bash(command).blocked).toBe(false);
  });

  it.each([
    'A=1 $CMD log',
    'env -u X $CMD log',
    'sudo -u root $CMD log',
    'A=1 B=2 $(echo git) log',
    'FOO=bar git log -p',
    'timeout 5 git log',
  ])('with no verdict denies %s', (command) => {
    expect(bash(command, unvouched).blocked).toBe(true);
  });

  it('keeps assignments as one word and still splits git options', () => {
    expect(parseCommands('A=1 B="x y" git -c core.pager=cat log')).toEqual([
      ['A=1', 'B=x y', 'git', '-c', 'core.pager', 'cat', 'log'],
    ]);
  });
});

describePosix('B cd anywhere in the command moves, with a sticky taint', () => {
  it.each([
    '{ cd sub; git log; }',
    'true && { cd sub; } && git log',
    'if true; then cd sub; fi; git log -p',
    '! cd sub; git log -p',
    'for d in sub; do cd $d; done; git log',
    "eval 'cd sub' && git log",
    'eval "cd sub; git log"',
    'sh -c "cd sub" && git log',
    'while true; do pushd sub; done; git log',
    'true || cd sub; git log',
  ])('denies %s', (command) => {
    expect(bash(command).blocked).toBe(true);
  });

  it.each([
    'cd /workspace && git log',
    'git status',
    'git commit -m x',
    'git diff',
    'eval "git status"',
    'if true; then git log; fi',
  ])('allows %s', (command) => {
    expect(bash(command).blocked).toBe(false);
  });
});

describePosix('C the scan accepts what normal git writes', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p0-3-r7-'));
  });

  const repoAt = (name: string) => {
    const fixture = makeFixture(join(root, name));
    commitFixture(fixture.repo);
    return fixture.repo;
  };
  const expire = (repo: string) => git(repo, 'reflog', 'expire', '--expire=now', '--all');

  it('stays clean after multi-pack-index write --bitmap and repack --write-midx', () => {
    const repo = repoAt('midx');
    git(repo, 'repack', '-adq', '--write-midx', '--write-bitmap-index');
    git(repo, 'multi-pack-index', 'write', '--bitmap');
    expire(repo);
    const result = scanRepo(repo);
    expect(result.issues).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it('stays clean after a rerere merge (MERGE_RR, rr-cache)', () => {
    const repo = repoAt('rerere');
    git(repo, 'config', 'rerere.enabled', 'true');
    const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'conflict.txt'), 'side\n');
    git(repo, 'add', 'conflict.txt');
    git(repo, 'commit', '-qm', 'side');
    git(repo, 'checkout', '-q', base);
    writeFileSync(join(repo, 'conflict.txt'), 'base\n');
    git(repo, 'add', 'conflict.txt');
    git(repo, 'commit', '-qm', 'base');
    expect(() => git(repo, 'merge', 'side')).toThrow();
    git(repo, 'merge', '--abort');
    expire(repo);
    git(repo, 'gc', '-q', '--prune=now');
    writeFileSync(join(repo, '.git', 'MERGE_RR'), '');
    const result = scanRepo(repo);
    expect(result.issues).toEqual([]);
    expect(result.clean).toBe(true);
  });

  it('stays clean with lfs and fsmonitor--daemon dirs, and flags a git dir nested in them', () => {
    const repo = repoAt('lfs');
    mkdirSync(join(repo, '.git', 'lfs', 'objects', 'ab', 'cd'), { recursive: true });
    writeFileSync(join(repo, '.git', 'lfs', 'objects', 'ab', 'cd', 'f'.repeat(64)), 'x');
    mkdirSync(join(repo, '.git', 'lfs', 'tmp'), { recursive: true });
    mkdirSync(join(repo, '.git', 'fsmonitor--daemon', 'cookies'), { recursive: true });
    expire(repo);
    expect(scanRepo(repo).issues).toEqual([]);
    for (const dir of ['lfs', 'fsmonitor--daemon']) {
      const nested = repoAt(`nested-${dir}`);
      git(root, 'clone', '-q', '--bare', nested, join(nested, '.git', dir, 'v.git'));
      expect(scanRepo(nested).clean).toBe(false);
    }
  });
});
