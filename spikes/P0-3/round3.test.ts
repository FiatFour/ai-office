import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupArgs } from './cage.mjs';
import { commitFixture, makeFixture, maskMounts } from './fixture.mjs';
import { scanRepo } from './git-scan.mjs';
import { startGuardServer } from './hooks/guard-server.mjs';
import * as lane from './lane-checks.mjs';
import { checkToolCall, findProtected, parseCommands } from './protected-paths.mjs';
import { managedSettings } from './settings.mjs';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

const bash = (command: string, ctx: Record<string, unknown>) =>
  checkToolCall({ tool_name: 'Bash', tool_input: { command } }, { home: '/h', ...ctx } as never);

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'p0-3-r3-'));
});

describePosix('F1 the guard never runs git on the host', () => {
  const planted = (name: string) => {
    const fixture = makeFixture(join(root, name));
    commitFixture(fixture.repo);
    const proof = join(root, `${name}-proof.txt`);
    git(fixture.repo, 'config', 'core.fsmonitor', `sh -c "echo pwned > ${proof}"; false`);
    return { fixture, proof };
  };

  it('control: the round 2 commands, unhardened, execute core.fsmonitor from the repo config', () => {
    const { fixture, proof } = planted('control');
    git(fixture.repo, 'ls-files', '-z');
    git(fixture.repo, 'rev-list', '--all', '--objects');
    git(fixture.repo, 'diff');
    expect(existsSync(proof)).toBe(true);
  });

  it('checkToolCall on git diff executes nothing from the repo config', () => {
    const { fixture, proof } = planted('hook');
    for (const gitClean of [true, false, undefined]) {
      bash('git diff', { cwd: fixture.repo, gitClean });
      bash('git log -p --all', { cwd: fixture.repo, gitClean });
    }
    expect(existsSync(proof)).toBe(false);
  });

  it('the preflight scan executes nothing from the repo config either', () => {
    const { fixture, proof } = planted('scan');
    expect(scanRepo(fixture.repo).clean).toBe(true);
    expect(existsSync(proof)).toBe(false);
  });

  it('protected-paths.mjs has no way to spawn a process', () => {
    const source = readFileSync(new URL('./protected-paths.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/child_process|execFile|spawn|execSync/);
  });

  it('blocks a git reader until the preflight vouches for the repo, and names the cause', () => {
    const verdict = bash('git diff', { cwd: '/w' });
    expect(verdict).toMatchObject({ blocked: true });
    expect(verdict.blocked && verdict.reason).toMatch(/preflight/);
    expect(bash('git diff', { cwd: '/w', gitClean: true }).blocked).toBe(false);
    expect(bash('git status', { cwd: '/w' }).blocked).toBe(true);
    expect(bash('git status', { cwd: '/w', gitClean: true }).blocked).toBe(false);
  });

  it.each([
    'git -C /etc log -p',
    'git -C .. log -p',
    'git -C /workspace/../etc show HEAD',
    'git --git-dir /home/node/other/.git log -p',
    'git --git-dir=/srv/x/.git diff',
    'git --work-tree /srv/x diff',
  ])('denies %s because it leaves the workspace', (command) => {
    const verdict = bash(command, { cwd: '/workspace', workspace: '/workspace', gitClean: true });
    expect(verdict).toMatchObject({ blocked: true });
    expect(verdict.blocked && verdict.reason).toMatch(/outside the workspace/);
  });

  it.each(['git -C /workspace log -p', 'git --git-dir .git log -p', 'git -C . diff'])(
    'allows %s at the workspace root and its own .git',
    (command) => {
      expect(bash(command, { cwd: '/workspace', workspace: '/workspace', gitClean: true }).blocked).toBe(false);
    },
  );

  it('the guard never stats a path outside the mapped workspace and does not follow a symlink out', () => {
    const fixture = makeFixture(join(root, 'contain'));
    commitFixture(fixture.repo);
    const outside = join(root, 'contain-outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.env'), 'K=v\n');
    symlinkSync(outside, join(fixture.repo, 'link'));
    const ctx = { cwd: '/workspace', workspace: '/workspace', root: fixture.repo, gitClean: true };
    expect(bash(`grep -r x ${outside}`, ctx).blocked).toBe(false);
    expect(bash('grep -r x link', ctx).blocked).toBe(false);
    expect(bash('grep -r x link/', ctx).blocked).toBe(false);
    expect(findProtected('/workspace/link', { home: '/h', ...ctx })).toEqual([]);
    expect(bash('grep -r x .', ctx).blocked).toBe(true);
  });
});

describePosix('F2 the preflight scans reflog, every object and submodules', () => {
  const clean = (name: string) => {
    const fixture = makeFixture(join(root, name));
    commitFixture(fixture.repo);
    return fixture;
  };

  it('control: a clean fixture passes', () => {
    expect(scanRepo(clean('p-clean').repo)).toMatchObject({ clean: true, protectedPaths: [], unreachable: 0 });
  });

  it('finds a protected file that only the reflog still reaches, after amend', () => {
    const { repo } = clean('p-amend');
    git(repo, 'add', '-f', '.env');
    git(repo, 'commit', '-qm', 'oops');
    git(repo, 'rm', '--cached', '-q', '.env');
    git(repo, 'commit', '-q', '--amend', '--allow-empty', '-m', 'fixed');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.protectedPaths).toContain('.env');
  });

  it('finds a protected file that only the reflog still reaches, after reset', () => {
    const { repo } = clean('p-reset');
    git(repo, 'add', '-f', '.env');
    git(repo, 'commit', '-qm', 'oops');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    expect(scanRepo(repo).protectedPaths).toContain('.env');
  });

  it('is clean again after reflog expire and gc --prune=now, the remediation it prints', () => {
    const { repo } = clean('p-gc');
    git(repo, 'add', '-f', '.env');
    git(repo, 'commit', '-qm', 'oops');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    const result = scanRepo(repo);
    expect(result.issues.join('\n')).toMatch(/reflog expire --expire=now --all/);
    expect(result.issues.join('\n')).toMatch(/gc --prune=now/);
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    git(repo, 'gc', '-q', '--prune=now');
    expect(scanRepo(repo).clean).toBe(true);
  });

  it('flags a dangling blob', () => {
    const { repo } = clean('p-dangling');
    git(repo, 'hash-object', '-w', '.env');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.unreachable).toBeGreaterThan(0);
  });

  it('flags alternates', () => {
    const { repo } = clean('p-alt');
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), '/somewhere/else/objects\n');
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('finds a protected file tracked in a submodule', () => {
    const sub = join(root, 'sub-src');
    mkdirSync(sub);
    git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(join(sub, '.env'), 'SUB_KEY=x\n');
    writeFileSync(join(sub, 'a.txt'), 'a\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-qm', 'sub');
    const { repo } = clean('p-sub');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
    git(repo, 'commit', '-qm', 'add sub');
    const result = scanRepo(repo);
    expect(result.clean).toBe(false);
    expect(result.protectedPaths.some((path) => path.endsWith('.env'))).toBe(true);
    expect(result.units).toBeGreaterThan(1);
  });

  it('finds a protected file in a nested repo that is not a registered submodule', () => {
    const { repo } = clean('p-nested');
    const nested = join(repo, 'tools', 'inner');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q', '-b', 'main');
    writeFileSync(join(nested, '.npmrc'), '//r/:_authToken=x\n');
    git(nested, 'add', '-f', '-A');
    git(nested, 'commit', '-qm', 'inner');
    expect(scanRepo(repo).clean).toBe(false);
  });

  it('fails closed when git cannot read the repo', () => {
    const dir = join(root, 'p-broken');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'garbage\n');
    const result = scanRepo(dir);
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/could not scan|failed|not a git dir/);
  });

  it('fails closed when git times out', () => {
    const { repo } = clean('p-timeout');
    const result = scanRepo(repo, { timeoutMs: 1 });
    expect(result.clean).toBe(false);
    expect(result.issues.join('\n')).toMatch(/could not scan/);
  });

  it('fails closed on a scan that exceeds its entry cap', () => {
    const { repo } = clean('p-cap');
    expect(scanRepo(repo, { maxEntries: 3 }).clean).toBe(false);
  });
});

describePosix('F3 an unreadable directory fails closed', () => {
  const unreadable = (name: string) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'secret'), { recursive: true });
    writeFileSync(join(dir, 'secret', '.env'), 'K=v\n');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    chmodSync(join(dir, 'secret'), 0o000);
    return dir;
  };

  it.skipIf(isRoot)('findProtected throws, the recursive search is blocked, maskMounts throws', () => {
    const dir = unreadable('unread');
    try {
      expect(() => findProtected(dir, { home: '/h', cwd: dir })).toThrow(/unreadable|EACCES|permission/i);
      expect(bash('grep -r x .', { cwd: dir })).toMatchObject({ blocked: true });
      expect(bash('find . -type f', { cwd: dir })).toMatchObject({ blocked: true });
      expect(() => maskMounts(dir, '/e', '/workspace')).toThrow(/unreadable|EACCES|permission/i);
      expect(
        checkToolCall({ tool_name: 'Grep', tool_input: { pattern: 'x', path: dir } }, { home: '/h', cwd: dir }),
      ).toMatchObject({ blocked: true });
      expect(bash('cat s*/x*', { cwd: dir }).blocked).toBe(false);
    } finally {
      chmodSync(join(dir, 'secret'), 0o755);
    }
    expect(bash('grep -r x .', { cwd: dir })).toMatchObject({ blocked: true });
  });
});

describePosix('F4 the guard server', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startGuardServer>>;
  const logPath = () => join(dir, 'events.jsonl');
  const headers = (token?: string) => ({
    'content-type': 'application/json',
    ...(token ? { 'x-guard-token': token } : {}),
  });
  const post = (body: unknown, token: string = server.token ?? '') =>
    fetch(server.hookUrl, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  const pre = (command: string) => ({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    cwd: join(dir, 'repo'),
    tool_name: 'Bash',
    tool_input: { command },
  });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'p0-3-r3srv-'));
    mkdirSync(join(dir, 'repo'));
    writeFileSync(join(dir, 'repo', '.env'), 'K=v\n');
    server = await startGuardServer({
      logPath: logPath(),
      home: dir,
      secret: 's3cret',
      maxLogBytes: 8000,
      maxDenyLogBytes: 4000,
      gitClean: true,
    });
  });
  afterAll(() => server.close());

  it('keeps the token out of the URL and takes it from a header', async () => {
    expect(server.hookUrl).not.toMatch(/s3cret|token/);
    expect(server.token).toBe('s3cret');
    expect((await post(pre('echo hi'), '')).status).toBe(401);
    expect((await post(pre('echo hi'), 'nope')).status).toBe(401);
    expect((await fetch(`${server.hookUrl}?token=s3cret`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await post(pre('echo hi'))).status).toBe(200);
  });

  it('puts the token in the settings as a header, never in a URL or a hook command line URL', () => {
    const settings = managedSettings({ hookUrl: server.hookUrl, token: 's3cret', layers: ['hook'] });
    const http = Object.values(settings.hooks ?? {})
      .flatMap((groups) => groups.flatMap((group) => group.hooks))
      .filter((hook) => hook.type === 'http');
    expect(http.length).toBeGreaterThan(0);
    for (const hook of http) {
      expect(hook.url).not.toMatch(/s3cret/);
      expect(hook.headers).toEqual({ 'X-Guard-Token': 's3cret' });
    }
  });

  it('keeps logging denies after forged events fill the event budget, and counts every deny', async () => {
    for (let i = 0; i < 200; i++)
      await post({ hook_event_name: 'PostToolUse', session_id: `forged-${i}`, filler: 'x'.repeat(20) });
    expect(readFileSync(logPath(), 'utf8')).toContain('log-truncated');
    const before = readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"decision":"deny"')).length;
    const reply = await post(pre('cat .env'));
    expect(JSON.parse(await reply.text()).hookSpecificOutput.permissionDecision).toBe('deny');
    const lines = readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"decision":"deny"'));
    expect(lines.length).toBe(before + 1);
    expect(server.stats().denies).toBeGreaterThanOrEqual(1);
    expect(server.stats().dropped).toBeGreaterThan(0);
  });

  it('counts denies it can no longer log', async () => {
    for (let i = 0; i < 100; i++) await post(pre('cat .env'));
    const stats = server.stats();
    expect(stats.denies).toBeGreaterThanOrEqual(101);
    expect(stats.deniesDropped).toBeGreaterThan(0);
    expect(statSync(logPath()).size).toBeLessThan(8000 + 4000 + 1200);
  });
});

describePosix('F5 matcher wins', () => {
  let ctx: Record<string, unknown>;
  beforeAll(() => {
    const dir = mkdtempSync(join(root, 'f5-'));
    writeFileSync(join(dir, '.env'), 'K=v\n');
    ctx = { cwd: dir, gitClean: true };
  });
  const blocked = (command: string) => bash(command, ctx).blocked;

  it.each([
    "sh -c 'cat .env'",
    'bash -c "cat .e*"',
    "zsh -c 'cat < .env'",
    "bash -lc 'git -C /etc log -p'",
    'sh -c "sh -c \'cat .env\'"',
    "env bash -c 'cat .env'",
    "sh -c 'tar cf - .env'",
  ])('recurses into %s', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it('recurses into an interpreter string for a recursive search', () => {
    const dir = mkdtempSync(join(root, 'sh-'));
    writeFileSync(join(dir, '.env'), 'K=v\n');
    expect(bash("sh -c 'grep -r K .'", { cwd: dir }).blocked).toBe(true);
    expect(bash("sh -c 'echo hi'", { cwd: dir }).blocked).toBe(false);
  });

  it.each([
    "cat $'.\\x65nv'",
    "cat $'\\056env'",
    "cat $'.\\u0065nv'",
    "cat $'\\x2eenv'",
    "cat $'.e\\156v'",
    "cat $'\\x2e\\x65\\x6e\\x76'",
  ])('decodes ANSI-C escapes in %s', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it('decodes the escapes into the word', () => {
    expect(parseCommands("cat $'.\\x65nv'")).toEqual([['cat', '.env']]);
    expect(parseCommands("echo $'a\\nb'")).toEqual([['echo', 'a\nb']]);
    expect(parseCommands("echo $'it\\'s' x")).toEqual([['echo', "it's", 'x']]);
  });

  it.each([
    'git grep --no-index KEY',
    'git grep --untracked KEY',
    'git grep -I --no-index KEY .',
    'git ls-files -o',
    'git ls-files --others',
    'git ls-files -oi --exclude-standard',
    'git diff --no-index /dev/null x',
  ])('blocks %s', (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each(['git ls-files', 'git ls-files -s', 'git grep KEY', 'git diff --stat'])('still allows %s', (command) => {
    expect(blocked(command)).toBe(false);
  });

  describe('Grep and Glob globs', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(root, 'tool-'));
      writeFileSync(join(dir, '.env'), 'K=v\n');
      writeFileSync(join(dir, 'a.ts'), 'x\n');
    });
    const grep = (glob: string) =>
      checkToolCall({ tool_name: 'Grep', tool_input: { pattern: 'K', path: dir, glob } }, { home: '/h', cwd: dir });
    const globTool = (pattern: string) =>
      checkToolCall({ tool_name: 'Glob', tool_input: { pattern, path: dir } }, { home: '/h', cwd: dir });

    it.each([
      '*env*',
      '?env',
      '[.]env',
      '.e*',
      '*',
      '**',
      '!*.ts',
      '*.ts !*.md',
      '*.{ts,env}',
      '{.env,x}',
      '*.ts,*env*',
    ])('Grep glob %s is blocked', (glob) => {
      expect(grep(glob)).toMatchObject({ blocked: true });
    });

    it.each(['*env*', '?env', '[.]env', '!*.ts'])('Glob pattern %s is blocked', (pattern) => {
      expect(globTool(pattern)).toMatchObject({ blocked: true });
    });

    it.each(['*.ts', 'a.ts', '*.{ts,js}', 'src/**/*.ts'])('Grep glob %s is allowed', (glob) => {
      expect(grep(glob)).toEqual({ blocked: false });
    });
  });
});

describe('F6 lane cleanup filters on the run id', () => {
  it('builds a filter on both the lane label and the run id, and refuses without a run id', () => {
    const args = cleanupArgs('abc123');
    expect(args.join(' ')).toContain('label=agent-works.p0-3=lane');
    expect(args.join(' ')).toContain('label=agent-works.run=abc123');
    expect(() => cleanupArgs('')).toThrow(/run id/);
    expect(() => cleanupArgs(undefined)).toThrow(/run id/);
  });
});

describe('F7 lane conditions are pure and fail when mutated', () => {
  const checks = lane as unknown as Record<string, (input: unknown) => boolean>;
  const good = {
    maskRead: { maskedCode: 0, maskedOut: '', controlLeaks: 1 },
    maskGrep: { maskedOut: 'exit=1\n', controlHits: 6 },
    gitReaders: { leaks: 0, controlOut: 'export const greeting = "hello"', trackedProtected: 0 },
    maskWrite: {
      started: true,
      controlCode: 0,
      writeCode: 1,
      writeErr: 'sh: cannot create /workspace/.env: Read-only file system',
    },
    commitA: { code: 0, names: 'README.md', leaks: 0 },
    scriptBypass: { maskedCode: 0, maskedOut: '', controlLeaks: 1, hookBlocked: false },
    noHome: { protectedHome: 0, sweepHits: '0' },
    settings: { wroteCode: 0, onFailure: 'block', version: '2.1.325 (Claude Code)', headerSet: true },
    hookAuth: { anonymousStatus: '401', wrongStatus: '401' },
    preflightContained: { hardenedProof: false, controlProof: true, cleanScan: true, dirtyScan: false },
  } as const;
  const faults: [keyof typeof good, Record<string, unknown>][] = [
    ['maskRead', { maskedOut: 'CANARY' }],
    ['maskRead', { maskedCode: 1 }],
    ['maskRead', { controlLeaks: 0 }],
    ['maskGrep', { maskedOut: './.env:K=CANARY\nexit=0\n' }],
    ['maskGrep', { controlHits: 0 }],
    ['gitReaders', { leaks: 1 }],
    ['gitReaders', { controlOut: '' }],
    ['gitReaders', { trackedProtected: 1 }],
    ['maskWrite', { writeCode: 0 }],
    ['maskWrite', { writeErr: 'Permission denied' }],
    ['maskWrite', { controlCode: 1 }],
    ['maskWrite', { started: false }],
    ['commitA', { code: 1 }],
    ['commitA', { names: '.env' }],
    ['commitA', { leaks: 2 }],
    ['scriptBypass', { maskedOut: 'CANARY' }],
    ['scriptBypass', { controlLeaks: 0 }],
    ['scriptBypass', { hookBlocked: true }],
    ['noHome', { protectedHome: 1 }],
    ['noHome', { sweepHits: '3' }],
    ['settings', { onFailure: undefined }],
    ['settings', { version: '2.1.300' }],
    ['settings', { wroteCode: 1 }],
    ['settings', { headerSet: false }],
    ['hookAuth', { anonymousStatus: '200' }],
    ['hookAuth', { wrongStatus: '200' }],
    ['preflightContained', { hardenedProof: true }],
    ['preflightContained', { controlProof: false }],
    ['preflightContained', { cleanScan: false }],
    ['preflightContained', { dirtyScan: true }],
  ];

  it.each(Object.keys(good))('%s passes on the good observation', (name) => {
    const check = checks[name] as (input: unknown) => boolean;
    expect(check(good[name as keyof typeof good])).toBe(true);
  });

  it.each(faults)('%s fails when mutated with %j', (name, fault) => {
    const check = checks[name] as (input: unknown) => boolean;
    expect(check({ ...good[name], ...fault })).toBe(false);
  });

  it('hookDecision and eventsOrdered fail on a wrong decision or order', () => {
    expect(lane.hookDecision('deny', 'deny')).toBe(true);
    expect(lane.hookDecision('allow', 'deny')).toBe(false);
    expect(lane.eventsOrdered(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'])).toBe(true);
    expect(lane.eventsOrdered(['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop'])).toBe(false);
    expect(lane.noLeak([])).toBe(true);
    expect(lane.noLeak(['CANARY_X'])).toBe(false);
    expect(lane.hookDown({ error: 'ECONNREFUSED', status: undefined })).toBe(true);
    expect(lane.hookDown({ error: undefined, status: 200 })).toBe(false);
  });
});
