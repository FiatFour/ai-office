import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitFixture, makeFixture } from './fixture.mjs';
import { scanRepo } from './git-scan.mjs';
import { TOKEN_HEADER } from './hooks/guard-server.mjs';
import * as lane from './lane-checks.mjs';
import { preflightInContainer } from './preflight.mjs';
import { checkToolCall } from './protected-paths.mjs';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const here = (name: string) => new URL(name, import.meta.url).pathname;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p0-3-r5-'));
});

const cleanRepo = (name: string) => {
  const fixture = makeFixture(join(root, name));
  commitFixture(fixture.repo);
  return fixture;
};

describePosix('A structural scan: symlinks, nesting, alternates, loose stores', () => {
  it('control: a clean repo, a gc-packed repo and a fresh clone stay clean', () => {
    const { repo } = cleanRepo('a-control');
    expect(scanRepo(repo).clean).toBe(true);
    git(repo, 'gc', '-q');
    expect(scanRepo(repo).clean).toBe(true);
    const clone = join(root, 'a-control-clone');
    git(root, 'clone', '-q', repo, clone);
    expect(scanRepo(clone).clean).toBe(true);
  });

  it('flags a git dir whose HEAD is a symlink, whatever the dir is named', () => {
    const { repo } = cleanRepo('a-headlink');
    const vault = join(repo, 'vault');
    git(root, 'clone', '-q', '--bare', repo, vault);
    execFileSync('mv', [join(vault, 'HEAD'), join(repo, 'real-head')]);
    symlinkSync(join(repo, 'real-head'), join(vault, 'HEAD'));
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toMatch(/symlink/);
  });

  it.each(['objects', 'refs'])('flags a git dir whose %s is a symlink', (entry) => {
    const { repo } = cleanRepo(`a-${entry}link`);
    const vault = join(repo, 'vault');
    git(root, 'clone', '-q', '--bare', repo, vault);
    execFileSync('mv', [join(vault, entry), join(repo, `real-${entry}`)]);
    symlinkSync(join(repo, `real-${entry}`), join(vault, entry));
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toMatch(/symlink/);
  });

  it('flags a bare repo nested inside .git, which the walk used to skip', () => {
    const { repo } = cleanRepo('a-nested');
    const source = join(root, 'a-nested-src.git');
    git(root, 'clone', '-q', '--bare', repo, source);
    execFileSync('cp', ['-r', source, join(repo, '.git', 'vault.git')]);
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toMatch(/vault\.git/);
  });

  it('flags a bare repo nested inside .git/objects', () => {
    const { repo } = cleanRepo('a-nested-objects');
    const source = join(root, 'a-nested-objects-src.git');
    git(root, 'clone', '-q', '--bare', repo, source);
    execFileSync('cp', ['-r', source, join(repo, '.git', 'objects', 'vault')]);
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('flags the alternates file in any form: a file, an empty file, a symlink, a dangling symlink', () => {
    const forms: Record<string, (path: string) => void> = {
      file: (path) => writeFileSync(path, '/tmp/elsewhere/objects\n'),
      empty: (path) => writeFileSync(path, ''),
      symlink: (path) => {
        writeFileSync(`${path}.target`, '/tmp/elsewhere/objects\n');
        symlinkSync(`${path}.target`, path);
      },
      dangling: (path) => symlinkSync('/nonexistent/alternates-target', path),
    };
    for (const [name, make] of Object.entries(forms)) {
      const { repo } = cleanRepo(`a-alt-${name}`);
      make(join(repo, '.git', 'objects', 'info', 'alternates'));
      const result = scanRepo(repo);
      expect(result.clean, name).toBe(false);
      expect(result.issues.join(' '), name).toMatch(/alternates/);
    }
  });

  it('flags a loose object store with no HEAD or refs, as a heuristic', () => {
    const { repo } = cleanRepo('a-loose');
    const blob = git(repo, 'rev-parse', 'HEAD').trim();
    const store = join(repo, 'cache', 'store');
    mkdirSync(join(store, blob.slice(0, 2)), { recursive: true });
    execFileSync('cp', [join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), join(store, blob.slice(0, 2))]);
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toMatch(/loose object store.*heuristic/);
  });

  it('flags a pack directory with .pack files anywhere in the tree', () => {
    const { repo } = cleanRepo('a-pack');
    git(repo, 'gc', '-q');
    const pack = join(repo, 'data', 'pack');
    mkdirSync(pack, { recursive: true });
    const real = join(repo, '.git', 'objects', 'pack');
    for (const file of execFileSync('ls', [real], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
      execFileSync('cp', [join(real, file), pack]);
    }
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toMatch(/pack/);
  });
});

describePosix('G structural git dir walk: any unknown entry inside a git dir is a finding', () => {
  const bareInto = (name: string, where: string[]) => {
    const { repo } = cleanRepo(name);
    const source = join(root, `${name}-src.git`);
    git(root, 'clone', '-q', '--bare', repo, source);
    const target = join(repo, '.git', ...where);
    mkdirSync(join(target, '..'), { recursive: true });
    execFileSync('cp', ['-r', source, target]);
    return repo;
  };

  it.each([
    ['objects/pack/v.git'],
    ['objects/ab/v.git'],
    ['objects/info/v.git'],
    ['refs/v.git'],
    ['hooks/v.git'],
    ['logs/v.git'],
  ])('flags a bare repo at .git/%s', (where) => {
    const repo = bareInto(`g-${where.replace(/\W/g, '-')}`, where.split('/'));
    expect(scanRepo(repo).clean).toBe(false);
  });

  it.each([
    ['objects/pack/stray.txt'],
    ['objects/ab/stray.txt'],
    ['objects/stray'],
    ['info/stray'],
    ['stray-dir/file'],
    ['logs/stray'],
  ])('flags an unknown entry at .git/%s', (where) => {
    const { repo } = cleanRepo(`g-stray-${where.replace(/\W/g, '-')}`);
    const path = join(repo, '.git', ...where.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'x');
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('control: the lock, gc and tmp files git writes while it runs stay clean', () => {
    const { repo } = cleanRepo('g-control-tmp');
    const dot = join(repo, '.git');
    writeFileSync(join(dot, 'objects', 'maintenance.lock'), '');
    writeFileSync(join(dot, 'objects', 'pack', 'tmp_pack_abc123'), '');
    writeFileSync(join(dot, 'objects', 'pack', `.tmp-123-pack-${'a'.repeat(40)}.idx`), '');
    writeFileSync(join(dot, 'gc.pid'), '1 host');
    writeFileSync(join(dot, 'gc.log'), '');
    writeFileSync(join(dot, 'index.lock'), '');
    expect(scanRepo(repo).clean).toBe(true);
  });

  it('control: fresh, cloned, gc-packed, repacked and submodule layouts stay clean', () => {
    const { repo } = cleanRepo('g-control');
    expect(scanRepo(repo).clean).toBe(true);
    git(repo, 'gc', '-q');
    expect(scanRepo(repo).clean).toBe(true);
    git(repo, 'repack', '-adq', '--write-bitmap-index');
    git(repo, 'commit-graph', 'write');
    expect(scanRepo(repo).clean).toBe(true);
    const clone = join(root, 'g-control-clone');
    git(root, 'clone', '-q', repo, clone);
    expect(scanRepo(clone).clean).toBe(true);
    const sub = cleanRepo('g-control-sub').repo;
    const outer = cleanRepo('g-control-outer').repo;
    git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
    git(outer, 'commit', '-qm', 'sub');
    const linked = join(root, 'g-control-linked');
    git(root, '-c', 'protocol.file.allow=always', 'clone', '-q', '--recurse-submodules', outer, linked);
    expect(existsSync(join(linked, '.git', 'modules', 'vendor', 'sub', 'HEAD'))).toBe(true);
    git(join(linked, 'vendor', 'sub'), 'reflog', 'expire', '--expire=now', '--all');
    expect(scanRepo(linked).clean).toBe(true);
  });
});

describePosix('E the git env vars and path options once the repo is vouched for', () => {
  const ctx = { home: '/h', cwd: '/workspace', workspace: '/workspace', gitClean: true } as never;
  const bash = (command: string) => checkToolCall({ tool_name: 'Bash', tool_input: { command } }, ctx);

  it.each([
    'GIT_DIR=/srv/x/.git git log -p',
    'GIT_OBJECT_DIRECTORY=/srv/x/objects git log -p',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES=/srv/x git log -p',
    'GIT_WORK_TREE=/srv/x git diff',
    'GIT_INDEX_FILE=/srv/x/index git ls-files',
    'GIT_COMMON_DIR=/srv/x git log',
    'env GIT_DIR=/srv/x git log -p',
    'env -i GIT_OBJECT_DIRECTORY=/srv/x git cat-file -p HEAD',
    'export GIT_DIR=/srv/x; git log -p',
    'sh -c "GIT_DIR=/srv/x git log -p"',
    'git --git-dir=/srv/x/.git log -p',
    'git --git-dir=/workspace/vault.git log -p',
    'git --git-dir /workspace/vault.git log -p',
    'git --git-dir=.git/vault.git log -p',
    'git --work-tree=/workspace/sub diff',
    'git -C /workspace/sub log -p',
    'git -C /workspace/.git/vault.git log -p',
    'git -C /srv/x status',
    'git --git-dir=/workspace/vault.git status',
    'cd A && git log -p',
    'cd .git/vault.git && git log -p',
    'cd sub && git log',
    'cd .git/objects/pack/v.git && git log -p',
    'cd sub; cd ..; git log',
    'cd - && git log -p',
    'cd $X && git log -p',
    'cd && git log',
    'pushd sub >/dev/null && git log',
    'popd && git log',
    'sh -c "cd sub && git log -p"',
    'cd sub && sh -c "git log -p"',
    'git config core.worktree /home/node && git add -f -A :/ && git diff --cached',
    'git -c core.worktree=/home/node diff --cached',
    'git -ccore.worktree=/home/node diff',
    'git --config-env=core.worktree=WT diff',
    'git config core.gitdir /x',
    'git config core.bare true',
    'git config include.path /x',
    'git config includeIf.gitdir:/x.path /y',
    'git config extensions.worktreeConfig true',
    'git config --add core.worktree /',
    'git -c include.path=/x log -p',
    'git worktree add /tmp/w',
    'git update-ref refs/replace/abc def',
    'git symbolic-ref HEAD refs/stash',
    'git update-ref refs/notes/x HEAD',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/ git diff',
  ])('denies %s', (command) => {
    expect(bash(command).blocked).toBe(true);
  });

  it.each([
    'git log -p',
    'git status',
    'git -C /workspace log -p',
    'git -C . diff',
    'git --git-dir=/workspace/.git log -p',
    'git --git-dir .git log -p',
    'git --git-dir=/workspace/.git --work-tree=/workspace diff',
    'echo GITHUB_DIR=1',
    'cd /workspace && git log -p',
    'cd . && git status',
    'cd sub && ls',
    'git log; cd sub; ls',
    'git config user.name x',
    'git -c core.pager=cat log -p',
    'git update-ref refs/heads/x HEAD',
    'git symbolic-ref HEAD refs/heads/main',
    'git branch',
  ])('allows %s', (command) => {
    expect(bash(command).blocked).toBe(false);
  });
});

describePosix('F preflight timeoutMs bounds wall time', () => {
  it('kills a container that ignores SIGTERM at the deadline', () => {
    const dir = mkdtempSync(join(root, 'f-'));
    const engine = join(dir, 'fake-engine');
    writeFileSync(
      engine,
      `#!/bin/sh
if [ "$1" = run ]; then
  exec ${process.execPath} -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"
fi
exit 0
`,
    );
    chmodSync(engine, 0o755);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const started = Date.now();
    const result = preflightInContainer(engine, { repo, image: 'x', runId: 'r5', timeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.clean).toBe(false);
    expect(result.issues.join(' ')).toMatch(/timed out|deadline|timeout/i);
  });
});

describePosix('B spawn audit: any attempt to start a process is observable even when swallowed', () => {
  const GUARD_FILES = ['hooks/guard-server.mjs', 'protected-paths.mjs'];
  const permission = (() => {
    try {
      execFileSync(process.execPath, ['--permission', '--allow-fs-read=*', '-e', '1'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
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
  const itPermission = permission ? it : it.skip;
  const attempts = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');

  itPermission('the audit preload records a swallowed spawn that the permission model denies', () => {
    const audit = join(root, 'b-control.audit');
    const script = `
      const name = ['node:child', 'process'].join('_');
      const m = await import(name);
      try { m['exec' + 'FileSync']('true'); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    `;
    execFileSync(
      process.execPath,
      [
        '--permission',
        '--allow-fs-read=*',
        `--allow-fs-write=${audit}`,
        '--import',
        here('./spawn-audit.mjs'),
        '--input-type=module',
        '-e',
        script,
      ],
      { env: { ...process.env, SPAWN_AUDIT_FILE: audit } },
    );
    expect(attempts(audit)).toMatch(/execFileSync/);
  });

  itPermission('checkToolCall makes no spawn attempt on the gitClean true and false paths', () => {
    const audit = join(root, 'b-driver.audit');
    const out = execFileSync(
      process.execPath,
      [
        '--permission',
        '--allow-fs-read=*',
        `--allow-fs-write=${audit}`,
        '--import',
        here('./spawn-audit.mjs'),
        here('./spawn-driver.mjs'),
      ],
      { encoding: 'utf8', env: { ...process.env, SPAWN_AUDIT_FILE: audit } },
    );
    expect(out.trim()).toBe('ok');
    expect(attempts(audit)).toBe('');
  });

  itPermission('the guard server makes no spawn attempt with --git-clean on or off', async () => {
    const fixture = makeFixture(join(root, 'b-server'));
    for (const clean of [true, false]) {
      const audit = join(root, `b-server-${clean}.audit`);
      const log = join(root, `b-server-${clean}.jsonl`);
      const child = spawn(
        process.execPath,
        [
          '--permission',
          '--allow-fs-read=*',
          `--allow-fs-write=${log}`,
          `--allow-fs-write=${audit}`,
          ...netFlag,
          '--import',
          here('./spawn-audit.mjs'),
          here('./hooks/guard-server.mjs'),
          '--log',
          log,
          '--secret',
          's',
          '--workspace',
          '/workspace',
          '--root',
          fixture.repo,
          ...(clean ? ['--git-clean'] : []),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPAWN_AUDIT_FILE: audit } },
      );
      try {
        const url = await new Promise<string>((resolve, reject) => {
          child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
          child.once('exit', () => reject(new Error('guard exited')));
        });
        for (const command of ['git log -p', 'A=1 git log -p', 'cat .env', 'grep -r K .', 'cat README.md']) {
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
          expect(response.status).toBe(200);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(attempts(audit), `git-clean ${clean}`).toBe('');
      } finally {
        child.kill();
      }
    }
  });

  it('the guard modules contain no dynamic import, process.binding, getBuiltinModule, createRequire, Function( or eval(', () => {
    const banned = [
      /\bimport\s*\(/,
      /process\s*\.\s*binding/,
      /getBuiltinModule/,
      /createRequire/,
      /\bFunction\s*\(/,
      /\beval\s*\(/,
      /\brequire\s*\(/,
      /child_process/,
    ];
    for (const file of GUARD_FILES) {
      const source = readFileSync(here(`./${file}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const pattern of banned) expect(source, `${file} ${pattern}`).not.toMatch(pattern);
    }
  });
});

describePosix('C preflightComplete', () => {
  const good = { dirtyVariants: 5, variants: 5, missingClean: false, missingCreated: false, cloneClean: true };
  it('passes when every variant is dirty, the missing path is refused and a fresh clone is clean', () => {
    expect(lane.preflightComplete(good)).toBe(true);
  });
  it('fails without a clean fresh clone', () => {
    expect(lane.preflightComplete({ ...good, cloneClean: false })).toBe(false);
  });
  it('fails when a single variant scans clean', () => {
    expect(lane.preflightComplete({ ...good, dirtyVariants: 4 })).toBe(false);
  });
  it('fails with no variants', () => {
    expect(lane.preflightComplete({ ...good, dirtyVariants: 0, variants: 0 })).toBe(false);
  });
  it('fails when a missing path scans clean or gets created', () => {
    expect(lane.preflightComplete({ ...good, missingClean: true })).toBe(false);
    expect(lane.preflightComplete({ ...good, missingCreated: true })).toBe(false);
  });
});

describePosix('D toolProbe', () => {
  it('does not pass on a hook error result', () => {
    expect(lane.toolProbe([{ attempted: true, output: 'PreToolUse:Glob hook error: connection refused' }])).toBe(
      'FAIL',
    );
    expect(lane.toolProbe([{ attempted: true, output: '/workspace/.env' }])).toBe('PASS');
  });
});
