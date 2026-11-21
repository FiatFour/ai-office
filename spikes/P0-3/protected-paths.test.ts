import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

import { checkToolCall, isProtectedPath } from './protected-paths.mjs';

let ctx: { home: string; cwd: string };
let cleanDir: string;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'p0-3-'));
  const cwd = join(root, 'repo');
  cleanDir = join(root, 'clean');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(cleanDir);
  writeFileSync(join(cwd, '.env'), 'KEY=fake\n');
  writeFileSync(join(cwd, '.env.example'), 'KEY=\n');
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export {}\n');
  writeFileSync(join(cleanDir, 'a.ts'), 'export {}\n');
  ctx = { home: '/home/test', cwd };
});

const bash = (command: string) => checkToolCall({ tool_name: 'Bash', tool_input: { command } }, ctx);

describe('isProtectedPath', () => {
  it.each([
    '.env',
    'a/b/.env',
    '.env.local',
    '.env.production',
    'server.pem',
    'tls.key',
    'id_rsa',
    'id_ed25519',
    '.npmrc',
    '.git-credentials',
    'credentials.json',
    'my-secret.json',
    'prod.tfvars',
    'kubeconfig-dev',
    'secrets.json',
    '~/.ssh/id_ed25519',
    '~/.ssh/config',
    '~/.aws/credentials',
    '~/.config/gh/hosts.yml',
    '~/.docker/config.json',
    '~/.kube/config',
    '$HOME/.ssh/known_hosts',
  ])('protects %s', (path) => {
    expect(isProtectedPath(path, ctx)).toBe(true);
  });

  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    'id_ed25519.pub',
    'server.pub',
    'src/a.ts',
    'environment.md',
    '~/.config/gh/config.yml',
    'package.json',
  ])('allows %s', (path) => {
    expect(isProtectedPath(path, ctx)).toBe(false);
  });
});

describePosix('checkToolCall on Bash', () => {
  it.each([
    'cat .env',
    'cp .env /tmp/x',
    'grep -r KEY .',
    'grep -rn KEY',
    'grep --recursive KEY src .',
    'rg KEY',
    'cat < .env',
    'cat ~/.ssh/id_ed25519',
    'echo hi && cat .env',
    'cat "./.env"',
    "cat '.env'",
    'cat $HOME/.ssh/id_ed25519',
    'head -c 10 .env',
    'tee out < .env',
    'X=.env; cat $X',
    'cat .e""nv',
    'base64 .env',
  ])('blocks %s', (command) => {
    expect(bash(command).blocked).toBe(true);
  });

  it.each(['cat .env.example', 'cat src/a.ts', 'ls -la', 'echo hello', 'grep -r KEY src'])('allows %s', (command) => {
    expect(bash(command)).toEqual({ blocked: false });
  });

  it('allows a recursive grep in a directory without protected files', () => {
    expect(
      checkToolCall({ tool_name: 'Bash', tool_input: { command: 'grep -r KEY .' } }, { ...ctx, cwd: cleanDir }),
    ).toEqual({
      blocked: false,
    });
  });

  it('names the matched token in the reason', () => {
    const result = bash('cat .env');
    expect(result).toMatchObject({ blocked: true });
    expect(result.blocked && result.reason).toContain('.env');
  });
});

describePosix('checkToolCall on file tools', () => {
  it.each([
    ['Read', { file_path: '.env' }],
    ['Read', { file_path: '/home/node/.ssh/id_ed25519' }],
    ['Edit', { file_path: 'sub/.env' }],
    ['Write', { file_path: '.env' }],
    ['Grep', { path: '.', pattern: 'KEY' }],
    ['Glob', { pattern: '**/.env' }],
  ])('blocks %s %j', (tool_name, tool_input) => {
    expect(checkToolCall({ tool_name, tool_input }, { ...ctx, home: '/home/node' }).blocked).toBe(true);
  });

  it('allows Read of a normal file and of .env.example', () => {
    expect(checkToolCall({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, ctx)).toEqual({
      blocked: false,
    });
    expect(checkToolCall({ tool_name: 'Read', tool_input: { file_path: '.env.example' } }, ctx)).toEqual({
      blocked: false,
    });
  });

  it('ignores tools it does not know', () => {
    expect(checkToolCall({ tool_name: 'TodoWrite', tool_input: { todos: [] } }, ctx)).toEqual({ blocked: false });
  });
});
