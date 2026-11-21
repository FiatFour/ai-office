import { describe, expect, it } from 'vitest';
import { attachCommand, LABEL, mountSource, parseClientMessage, runCommand } from './term-server.mjs';

const attachArgs = ['exec', '-it', 'aw-1', 'tmux', '-u', 'attach-session', '-t', 'aw'];

describe('attachCommand', () => {
  it.each([
    [{ engine: 'docker', host: 'linux' }, 'docker'],
    [{ engine: 'podman', host: 'linux' }, 'podman'],
    [{ engine: 'docker', host: 'darwin' }, 'docker'],
    [{ engine: 'docker', host: 'win32' }, 'docker.exe'],
    [{ engine: 'podman', host: 'win32' }, 'podman.exe'],
  ] as const)('%o runs %s exec -it into the tmux session', (target, file) => {
    expect(attachCommand(target, { cage: 'aw-1', session: 'aw' })).toEqual({ file, args: attachArgs });
  });
});

describe('runCommand', () => {
  it('labels the cage and mounts the workspace read-only with docker on Linux', () => {
    const { file, args } = runCommand(
      { engine: 'docker', host: 'linux' },
      { cage: 'aw-1', image: 'img', workspace: '/home/me/repo' },
    );
    expect(file).toBe('docker');
    expect(args).toEqual([
      'run',
      '-d',
      '--init',
      '--name',
      'aw-1',
      '--label',
      LABEL,
      '--mount',
      'type=bind,source=/home/me/repo,target=/work,readonly',
      'img',
    ]);
  });

  it('passes a Windows drive path to docker.exe by default', () => {
    const { file, args } = runCommand(
      { engine: 'docker', host: 'win32' },
      { cage: 'aw-1', image: 'img', workspace: 'c:\\Users\\me\\repo' },
    );
    expect(file).toBe('docker.exe');
    expect(args).toContain('type=bind,source=C:\\Users\\me\\repo,target=/work,readonly');
  });

  it('passes a /mnt path to docker.exe when the daemon runs inside WSL', () => {
    const { args } = runCommand(
      { engine: 'docker', host: 'win32' },
      { cage: 'aw-1', image: 'img', workspace: 'D:\\a\\repo', mountStyle: 'wsl' },
    );
    expect(args).toContain('type=bind,source=/mnt/d/a/repo,target=/work,readonly');
  });

  it('uses podman.exe with the same argv shape on Windows', () => {
    const { file, args } = runCommand(
      { engine: 'podman', host: 'win32' },
      { cage: 'aw-1', image: 'img', workspace: 'C:\\repo' },
    );
    expect(file).toBe('podman.exe');
    expect(args).toContain('type=bind,source=C:\\repo,target=/work,readonly');
  });
});

describe('mountSource', () => {
  it.each([
    ['/home/me/repo/', 'posix', '/home/me/repo'],
    ['C:\\Users\\me\\repo', 'windows', 'C:\\Users\\me\\repo'],
    ['c:/Users/me/repo', 'windows', 'C:\\Users\\me\\repo'],
    ['/mnt/c/Users/me/repo', 'windows', 'C:\\Users\\me\\repo'],
    ['/c/Users/me/repo', 'windows', 'C:\\Users\\me\\repo'],
    ['/mnt/d', 'windows', 'D:\\'],
    ['C:\\Users\\me\\repo', 'wsl', '/mnt/c/Users/me/repo'],
    ['/mnt/c/Users/me/repo', 'wsl', '/mnt/c/Users/me/repo'],
    ['D:\\', 'wsl', '/mnt/d'],
  ] as const)('%s as %s is %s', (hostPath, style, expected) => {
    expect(mountSource(hostPath, style)).toBe(expected);
  });

  it('rejects a path with a comma, which would split the --mount value', () => {
    expect(() => mountSource('/home/me/a,b', 'posix')).toThrow(/comma/);
  });
});

describe('parseClientMessage', () => {
  it('accepts input and resize frames', () => {
    expect(parseClientMessage('{"type":"input","data":"ls\\r"}')).toEqual({ type: 'input', data: 'ls\r' });
    expect(parseClientMessage('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  it.each([
    'not json',
    '{"type":"input","data":5}',
    '{"type":"resize","cols":0,"rows":40}',
    '{"type":"resize","cols":12.5,"rows":40}',
    '{"type":"exec","cmd":"rm -rf /"}',
    'null',
  ])('drops %s', (raw) => {
    expect(parseClientMessage(raw)).toBeUndefined();
  });
});
