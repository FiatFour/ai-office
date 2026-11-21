import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitFixture, makeFixture } from './fixture.mjs';
import { scanRepo } from './git-scan.mjs';
import { startGuardServer, TOKEN_HEADER } from './hooks/guard-server.mjs';
import * as lane from './lane-checks.mjs';
import { preflightArgs, preflightInContainer, refreshGitClean } from './preflight.mjs';
import { checkToolCall } from './protected-paths.mjs';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

const bash = (command: string, ctx: Record<string, unknown>) =>
  checkToolCall({ tool_name: 'Bash', tool_input: { command } }, { home: '/h', ...ctx } as never);
const tool = (tool_name: string, tool_input: Record<string, unknown>, ctx: Record<string, unknown>) =>
  checkToolCall({ tool_name, tool_input }, { home: '/h', ...ctx } as never);

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p0-3-r4-'));
});

const cleanRepo = (name: string) => {
  const fixture = makeFixture(join(root, name));
  commitFixture(fixture.repo);
  return fixture;
};
const envBlob = (repo: string) => git(repo, 'hash-object', '-w', '.env').trim();

describePosix('A the preflight accounts for every object, by structure', () => {
  it('control: a fresh clone of a clean repo is clean', () => {
    const { repo } = cleanRepo('a-clone-src');
    const clone = join(root, 'a-clone');
    git(root, 'clone', '-q', repo, clone);
    expect(scanRepo(clone)).toMatchObject({ clean: true, protectedPaths: [] });
  });

  it('finds a protected path that has a newline in its directory name, in history only', () => {
    const { repo } = cleanRepo('a-newline');
    mkdirSync(join(repo, 'd\nx'));
    writeFileSync(join(repo, 'd\nx', '.env'), 'K=v\n');
    git(repo, 'add', '-f', 'd\nx');
    git(repo, 'commit', '-qm', 'add');
    git(repo, 'rm', '-rq', '--cached', 'd\nx');
    git(repo, 'commit', '-qm', 'drop');
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    git(repo, 'gc', '-q', '--prune=now');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.protectedPaths).toEqual(['d\nx/.env']);
  });

  it('scans a bare repo nested under vendor/lib.git', () => {
    const src = join(root, 'a-bare-src');
    mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, '.env'), 'K=v\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'x');
    const { repo } = cleanRepo('a-bare');
    mkdirSync(join(repo, 'vendor'));
    git(root, 'clone', '-q', '--bare', src, join(repo, 'vendor', 'lib.git'));
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.protectedPaths.some((path) => path.endsWith('.env'))).toBe(true);
  });

  it('scans a git dir that is not named .git', () => {
    const src = join(root, 'a-data-src');
    mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, '.npmrc'), 'K=v\n');
    git(src, 'add', '-f', '-A');
    git(src, 'commit', '-qm', 'x');
    const { repo } = cleanRepo('a-data');
    git(root, 'clone', '-q', '--bare', src, join(repo, '.gitdata'));
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.protectedPaths.some((path) => path.endsWith('.npmrc'))).toBe(true);
  });

  it('fails a lightweight tag on a blob', () => {
    const { repo } = cleanRepo('a-tag-light');
    git(repo, 'tag', 'v0', envBlob(repo));
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/refs\/tags\/v0/);
  });

  it('fails an annotated tag on a blob', () => {
    const { repo } = cleanRepo('a-tag-ann');
    git(repo, 'tag', '-a', '-m', 'm', 'v1', envBlob(repo));
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('fails an annotated tag on a tree', () => {
    const { repo } = cleanRepo('a-tag-tree');
    git(repo, 'tag', '-a', '-m', 'm', 'v1', 'HEAD^{tree}');
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('fails refs/notes, even when the note text is the credential', () => {
    const { repo } = cleanRepo('a-notes');
    git(repo, 'notes', 'add', '-F', '.env');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/refs\/notes/);
  });

  it('fails refs/replace', () => {
    const { repo } = cleanRepo('a-replace');
    const readme = git(repo, 'rev-parse', 'HEAD:README.md').trim();
    git(repo, 'replace', readme, envBlob(repo));
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/refs\/replace/);
  });

  it('fails a stash and refs/original', () => {
    const { repo } = cleanRepo('a-stash');
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    git(repo, 'stash', '-q');
    expect(scanRepo(repo).issues.join('\n')).toMatch(/refs\/stash/);
    git(repo, 'update-ref', 'refs/original/refs/heads/main', 'HEAD');
    expect(scanRepo(repo).issues.join('\n')).toMatch(/refs\/original/);
  });

  it('fails shallow, grafts and a worktrees dir', () => {
    for (const [name, file] of [
      ['shallow', 'shallow'],
      ['grafts', 'info/grafts'],
    ] as const) {
      const { repo } = cleanRepo(`a-${name}`);
      mkdirSync(join(repo, '.git', 'info'), { recursive: true });
      writeFileSync(join(repo, '.git', file), `${git(repo, 'rev-parse', 'HEAD').trim()}\n`);
      expect(scanRepo(repo).clean, name).toBe(false);
    }
    const { repo } = cleanRepo('a-worktree');
    git(repo, 'worktree', 'add', '-q', join(root, 'a-worktree-linked'));
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('fails a reflog with more than one entry, and passes once it is expired', () => {
    const { repo } = cleanRepo('a-reflog');
    writeFileSync(join(repo, 'src', 'extra.js'), 'x\n');
    git(repo, 'add', 'src/extra.js');
    git(repo, 'commit', '-qm', 'second');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/reflog/);
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    expect(scanRepo(repo).clean).toBe(true);
  });

  it('fails a staged-only protected file and a dangling blob', () => {
    const { repo } = cleanRepo('a-staged');
    git(repo, 'add', '-f', '.env');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.protectedPaths).toEqual(['.env']);
    expect(result.unreachable).toBeGreaterThan(0);
  });

  it('fails a .git that points outside the repo, or that is not a git dir', () => {
    const { repo } = cleanRepo('a-pointer');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', '.git'), 'gitdir: /somewhere/else\n');
    expect(scanRepo(repo).clean).toBe(false);
    const { repo: other } = cleanRepo('a-fakegit');
    mkdirSync(join(other, 'sub', '.git'), { recursive: true });
    expect(scanRepo(other).clean).toBe(false);
  });

  it('is an error, not clean, for a missing path and for a directory that is not a repo', () => {
    const missing = join(root, 'a-does-not-exist');
    const result = scanRepo(missing);
    expect(result).toMatchObject({ clean: false, units: 0 });
    expect(existsSync(missing)).toBe(false);
    const plain = join(root, 'a-plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'a.txt'), 'x');
    expect(scanRepo(plain).clean).toBe(false);
  });

  it('the container preflight refuses a missing path without running the engine or creating a host dir', () => {
    const missing = join(root, 'a-missing-mount');
    const result = preflightInContainer('no-such-engine', { repo: missing, image: 'x', runId: 'r4' });
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/does not exist/);
    expect(existsSync(missing)).toBe(false);
  });

  it('the scan container is bounded and mounts with an error on a missing source', () => {
    const args = preflightArgs({ repo: '/r', image: 'img', runId: 'r4', name: 'n1' });
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--memory');
    expect(args).toContain('--name');
    expect(
      args.some((arg) => /^type=bind,.*src=\/r,.*dst=\/repo,.*readonly/.test(arg) || arg.includes('type=bind')),
    ).toBe(true);
    expect(args.join(' ')).not.toMatch(/-v \/r:/);
    expect(args).not.toContain('-v');
  });

  it('a timeout removes the scan container', () => {
    const { repo } = cleanRepo('a-timeout');
    const dir = join(root, 'fake-engine');
    mkdirSync(dir);
    const log = join(dir, 'log');
    const engine = join(dir, 'engine');
    writeFileSync(engine, `#!/bin/sh\necho "$@" >> ${log}\n[ "$1" = run ] && sleep 5\nexit 0\n`);
    chmodSync(engine, 0o755);
    const result = preflightInContainer(engine, { repo, image: 'img', runId: 'r4', timeoutMs: 300 });
    expect(result.clean).toBe(false);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const name = /--name (\S+)/.exec(lines[0] ?? '')?.[1];
    expect(name).toBeTruthy();
    expect(lines.some((line) => line === `rm -f ${name}`)).toBe(true);
  });
});

describePosix('B with an unclean repo the guard denies every command that invokes git', () => {
  const ctx = { cwd: '/workspace', workspace: '/workspace' };
  const invoking = [
    'git log -p',
    'A=1 git log -p',
    'env A=1 git log -p',
    'GIT_DIR=/workspace/.git git log -p',
    'git l',
    'git reflog -p',
    'git fast-export --all',
    'git worktree add -q /tmp/wt HEAD',
    'git clone -q /workspace /tmp/c && grep -r API /tmp/c',
    'git init /tmp/x && git -C /tmp/x fetch /workspace',
    'git $(echo log) -p',
    'git $x',
    'g=git; $g log -p',
    '$(echo git) log -p',
    'a=gi; b=t; $a$b log -p',
    '`echo git` log -p',
    '/usr/bin/git log -p',
    'git-upload-pack /workspace',
    '"gi""t" log -p',
    "$'\\x67it' log -p",
    'timeout 5 git log -p',
    'sudo git log -p',
    "su -c 'git log -p'",
    "script -qc 'git log -p' /dev/null",
    "sh -c 'git log -p'",
    'bash -c "sh -c \'git log -p\'"',
    'busybox sh -c "git log -p"',
    'echo "git log -p" | sh',
    "sh <<< 'git log -p'",
    'xargs git log -p < /dev/null',
    'find . -maxdepth 0 -exec git log -p ;',
    'command git log -p',
    'cat .git/logs/HEAD',
  ];
  it.each(invoking)('denies %s', (command) => {
    for (const gitClean of [false, undefined]) {
      const verdict = bash(command, { ...ctx, gitClean });
      expect(verdict.blocked, command).toBe(true);
    }
  });

  it('names the preflight as the cause', () => {
    const verdict = bash('A=1 git log -p', ctx);
    expect(verdict.blocked && verdict.reason).toMatch(/preflight/);
  });

  it.each([
    'ls -la',
    'cat README.md',
    'echo $(date)',
    'node -e "console.log(1)"',
    'cat .gitignore',
    'ls .github',
    'echo digit',
  ])('still allows %s', (command) => {
    expect(bash(command, ctx).blocked).toBe(false);
  });

  it('keeps the round 3 behavior when the repo is vouched for', () => {
    const clean = { ...ctx, gitClean: true };
    expect(bash('git log -p', clean).blocked).toBe(false);
    expect(bash('A=1 git log -p', clean).blocked).toBe(false);
    expect(bash('git status', clean).blocked).toBe(false);
    expect(bash('git -C /etc log -p', clean).blocked).toBe(true);
    expect(bash('git ls-files -o', clean).blocked).toBe(true);
  });
});

describePosix('C cheap fail-closed matcher rules', () => {
  const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
  const nest = (command: string, depth: number) => {
    let text = command;
    for (let level = 0; level < depth; level++) text = `sh -c ${quote(text)}`;
    return text;
  };
  const ctx = { cwd: '/workspace', workspace: '/workspace' };

  it('denies a shell nested deeper than the matcher can follow', () => {
    for (const depth of [1, 2, 3, 4]) expect(bash(nest('cat .env', depth), ctx).blocked, `${depth}`).toBe(true);
    for (const depth of [5, 6, 9]) expect(bash(nest('cat .env', depth), ctx).blocked, `${depth}`).toBe(true);
    expect(bash(nest('echo hi', 2), ctx).blocked).toBe(false);
    const deep = bash(nest('echo hi', 7), ctx);
    expect(deep.blocked && deep.reason).toMatch(/nest/);
  });

  it('decodes $"..." locale quoting', () => {
    expect(bash('cat $".env"', ctx).blocked).toBe(true);
    expect(bash('cat $".e""nv"', ctx).blocked).toBe(true);
    expect(bash('echo $"hello"', ctx).blocked).toBe(false);
  });

  it('denies a backslash in a Grep glob or a Glob pattern', () => {
    const dir = join(root, 'c-glob');
    mkdirSync(dir);
    writeFileSync(join(dir, '.env'), 'K=v\n');
    const local = { cwd: dir };
    expect(tool('Glob', { pattern: '\\.env', path: dir }, local).blocked).toBe(true);
    expect(tool('Grep', { pattern: 'K', glob: '\\.env', path: dir }, local).blocked).toBe(true);
    expect(tool('Grep', { pattern: 'K', glob: '*\\.e*', path: dir }, local).blocked).toBe(true);
    const clean = join(root, 'c-glob-clean');
    mkdirSync(clean);
    writeFileSync(join(clean, 'a.js'), 'x');
    expect(tool('Glob', { pattern: '\\*.js', path: clean }, { cwd: clean }).blocked).toBe(true);
    expect(tool('Glob', { pattern: '*.js', path: clean }, { cwd: clean }).blocked).toBe(false);
  });

  describe('search roots that contain the workspace', () => {
    let held: { repo: string };
    let bare: string;
    beforeAll(() => {
      held = makeFixture(join(root, 'c-anc'));
      bare = join(root, 'c-anc-clean');
      mkdirSync(join(bare, 'src'), { recursive: true });
      writeFileSync(join(bare, 'src', 'a.js'), 'x');
    });
    const at = (cwd: string) => ({ cwd, workspace: '/workspace', root: held.repo });
    it.each([
      ['/workspace', 'grep -r K /'],
      ['/workspace', 'grep -r K ..'],
      ['/workspace', 'grep -r K /workspace/..'],
      ['/workspace', 'rg K /'],
      ['/workspace', 'find / -name x'],
      ['/workspace', 'tar cf - /'],
      ['/workspace', 'cp -r / /tmp/x'],
      ['/workspace', 'cd .. && grep -r K workspace'],
      ['/workspace', 'cd .. && grep -r K .'],
      ['/workspace/src', 'grep -r K ..'],
      ['/workspace/src', 'cd /workspace/src && grep -r K ../..'],
    ])('denies %s: %s', (cwd, command) => {
      expect(bash(command, at(cwd)).blocked, command).toBe(true);
    });
    it('denies Grep and Glob over an ancestor path', () => {
      for (const path of ['/', '..', '/workspace/..']) {
        expect(tool('Grep', { pattern: 'K', path }, at('/workspace')).blocked, path).toBe(true);
        expect(tool('Glob', { pattern: '*', path }, at('/workspace')).blocked, path).toBe(true);
      }
    });
    it('allows the same searches when the tree below holds nothing protected', () => {
      const ok = { cwd: '/workspace', workspace: '/workspace', root: bare };
      expect(bash('grep -r K ..', ok).blocked).toBe(false);
      expect(bash('cd .. && grep -r K workspace', ok).blocked).toBe(false);
      expect(tool('Grep', { pattern: 'K', path: '/' }, ok).blocked).toBe(false);
    });
  });
});

describePosix('D honesty fixes', () => {
  it('the guard server takes the git verdict per request, so a lane can recompute it', async () => {
    const server = await startGuardServer({ logPath: join(root, 'd-log.jsonl'), home: '/h', secret: 's' });
    const ask = async (command: string) => {
      const response = await fetch(`${server.hookUrl}`, {
        method: 'POST',
        headers: { [TOKEN_HEADER]: 's', 'content-type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          cwd: '/w',
        }),
      });
      return (await response.text()).includes('deny');
    };
    try {
      expect(await ask('git log -p')).toBe(true);
      server.setGitClean(true);
      expect(await ask('git log -p')).toBe(false);
      server.setGitClean(false);
      expect(await ask('A=1 git log -p')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('refreshGitClean runs a fresh scan and applies the result before each lane', () => {
    const applied: boolean[] = [];
    const server = { setGitClean: (value: boolean) => applied.push(value) };
    let dirty = false;
    const scan = () => ({ clean: !dirty, issues: dirty ? ['staged .env'] : [] });
    expect(refreshGitClean(server, scan)).toBe(true);
    dirty = true;
    expect(refreshGitClean(server, scan)).toBe(false);
    expect(applied).toEqual([true, false]);
  });

  it('globprobe passes only when the tool was called and printed output', () => {
    expect(lane.toolProbe([{ attempted: true, output: 'x' }])).toBe('PASS');
    expect(lane.toolProbe([{ attempted: false, output: '' }])).toBe('NOT-RUN');
    expect(lane.toolProbe([{ attempted: true, output: '' }])).toBe('FAIL');
    expect(
      lane.toolProbe([
        { attempted: true, output: 'x' },
        { attempted: false, output: '' },
      ]),
    ).toBe('FAIL');
    expect(lane.toolProbe([])).toBe('NOT-RUN');
  });

  const permission = (() => {
    try {
      execFileSync(process.execPath, ['--permission', '--allow-fs-read=*', '-e', '1'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const itPermission = permission ? it : it.skip;
  const netFlag = (() => {
    try {
      execFileSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-net', '-e', '1'], {
        stdio: 'ignore',
      });
      return ['--allow-net'];
    } catch {
      return [];
    }
  })();

  itPermission('control: under node --permission a child process cannot start, even through a joined import', () => {
    const script = `
      const name = ['node:child', 'process'].join('_');
      const { execFileSync } = await import(name);
      try { execFileSync('true'); console.log('SPAWNED'); } catch (error) { console.log(error.code); }
    `;
    const out = execFileSync(
      process.execPath,
      ['--permission', '--allow-fs-read=*', '--input-type=module', '-e', script],
      {
        encoding: 'utf8',
      },
    );
    expect(out.trim()).toBe('ERR_ACCESS_DENIED');
  });

  itPermission('guard-server.mjs and protected-paths.mjs serve every verdict without the right to spawn', async () => {
    const fixture = makeFixture(join(root, 'd-perm'));
    const log = join(root, 'd-perm.jsonl');
    const child = spawn(
      process.execPath,
      [
        '--permission',
        '--allow-fs-read=*',
        `--allow-fs-write=${log}`,
        ...netFlag,
        new URL('./hooks/guard-server.mjs', import.meta.url).pathname,
        '--log',
        log,
        '--secret',
        's',
        '--workspace',
        '/workspace',
        '--root',
        fixture.repo,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
        child.once('exit', () => reject(new Error(`guard exited: ${stderr}`)));
      });
      const ask = async (command: string) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { [TOKEN_HEADER]: 's' },
          body: JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command },
            cwd: '/workspace',
          }),
        });
        return { status: response.status, body: await response.text() };
      };
      for (const command of ['git log -p', 'A=1 git log -p', 'cat .env', 'grep -r K .', 'cat README.md']) {
        const answer = await ask(command);
        expect(answer.status, command).toBe(200);
        expect(answer.body.includes('deny'), command).toBe(command !== 'cat README.md');
      }
      expect(child.exitCode).toBeNull();
      expect(stderr).not.toMatch(/ERR_ACCESS_DENIED/);
    } finally {
      child.kill();
    }
  });

  it('the harness no longer runs git on the host over a repo an agent could write', () => {
    const source = readFileSync(new URL('./run-agent.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/run\('git'/);
  });
});
