import { describe, expect, it } from 'vitest';
import type { Engine } from '../../sandbox/engine.ts';
import { bindSource, mount } from '../../sandbox/export.ts';
import { raiseFirewall } from '../../sandbox/firewall.ts';
import { tempDir } from '../helpers.ts';

const win = (path: string): string => bindSource(path, 'win32');

describe('bindSource', () => {
  it('turns a drive path into the /mnt path a WSL daemon reads', () => {
    const cases: Array<[string, string]> = [
      ['C:\\x\\y', '/mnt/c/x/y'],
      ['C:/x/y', '/mnt/c/x/y'],
      ['c:\\x\\y', '/mnt/c/x/y'],
      ['D:\\Users\\Runner Admin\\My Project', '/mnt/d/Users/Runner Admin/My Project'],
      [
        'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\contract-docker-ab12',
        '/mnt/c/Users/RUNNER~1/AppData/Local/Temp/contract-docker-ab12',
      ],
      ['C:\\a,b\\c', '/mnt/c/a,b/c'],
      ['C:\\x\\', '/mnt/c/x'],
      ['C:/x//y///', '/mnt/c/x/y'],
      ['C:\\', '/mnt/c'],
      ['C:/', '/mnt/c'],
      ['C:', '/mnt/c'],
      ['\\\\?\\C:\\x\\y', '/mnt/c/x/y'],
      ['Z:\\Ünï\\café', '/mnt/z/Ünï/café'],
    ];
    for (const [from, to] of cases) expect(win(from), from).toBe(to);
  });

  it('maps a UNC share the way wslpath does and a WSL share to its Linux path', () => {
    expect(win('\\\\server\\share\\dir\\')).toBe('//server/share/dir');
    expect(win('\\\\server\\share')).toBe('//server/share');
    expect(win('\\\\?\\UNC\\server\\share\\dir')).toBe('//server/share/dir');
    expect(win('\\\\wsl$\\Debian\\home\\agent\\repo')).toBe('/home/agent/repo');
    expect(win('\\\\wsl.localhost\\Debian\\home\\agent\\')).toBe('/home/agent');
    expect(win('\\\\wsl.localhost\\Debian')).toBe('/');
  });

  it('leaves a path that is already POSIX, and a drive-relative one, as given', () => {
    for (const path of ['/mnt/c/x/y', '/home/agent/repo', '/', 'C:foo', 'relative\\dir'])
      expect(win(path), path).toBe(path);
  });

  it('leaves every path alone on linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const)
      for (const path of ['C:\\x\\y', 'C:/x', '/tmp/a b', '\\\\server\\share'])
        expect(bindSource(path, platform), `${platform} ${path}`).toBe(path);
  });
});

describe('mount', () => {
  it('builds its bind from the translated path', () => {
    expect(mount('C:\\Users\\a b\\repo', '/work', false, 'win32')).toEqual([
      '--mount',
      'type=bind,src=/mnt/c/Users/a b/repo,dst=/work',
    ]);
    expect(mount('C:\\r', '/src', true, 'win32')).toEqual(['--mount', 'type=bind,src=/mnt/c/r,dst=/src,readonly']);
  });

  it('keeps the host argument unchanged on linux', () => {
    expect(mount('/tmp/a b/repo', '/work', true, 'linux')).toEqual([
      '--mount',
      'type=bind,src=/tmp/a b/repo,dst=/work,readonly',
    ]);
  });

  it('quotes a path with a comma or a quote so the mount is not split', () => {
    expect(mount('/tmp/a,b', '/work', false, 'linux')).toEqual(['--mount', 'type=bind,"src=/tmp/a,b",dst=/work']);
    expect(mount('C:\\a,b\\"c"', '/work', false, 'win32')).toEqual([
      '--mount',
      'type=bind,"src=/mnt/c/a,b/""c""",dst=/work',
    ]);
  });
});

describe('firewall proxy binds', () => {
  it('binds the proxy code and the allowlist through the mount builder', async () => {
    const calls: string[][] = [];
    const engine = {
      name: 'docker',
      ok: async (args: string[]) => {
        calls.push(args);
        return '[]';
      },
      follow: () => ({ stop: () => {} }),
    } as unknown as Engine;
    const dir = tempDir('firewall-binds');
    await raiseFirewall({ engine, project: 'p', hq: 'h', image: 'i', dir, allowlist: [], onDenial: () => {} }).catch(
      () => {},
    );
    const run = calls.find((args) => args[0] === 'run') ?? [];
    expect(run).not.toContain('-v');
    const binds = run.filter((arg) => arg.startsWith('type=bind'));
    expect(binds).toHaveLength(2);
    expect(binds[0]).toMatch(/dst=\/proxy,readonly$/);
    expect(binds[1]).toBe(`type=bind,src=${bindSource(dir)},dst=/etc/agent-works,readonly`);
  });
});
