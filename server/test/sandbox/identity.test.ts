import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startProxy } from '../../sandbox/proxy/node-proxy.mjs';
import { tempDir } from '../helpers.ts';

describe('the proxy names a cage by its address', () => {
  const dir = tempDir('identity');
  const allowlistPath = join(dir, 'allowlist.txt');
  const cagesPath = join(dir, 'cages.json');
  writeFileSync(allowlistPath, 'registry.npmjs.org\n');
  const denied: Array<{ agent: string; host: string }> = [];
  let proxy: Server;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      if (line.startsWith('{"deny":')) denied.push((JSON.parse(line) as { deny: (typeof denied)[number] }).deny);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    proxy = await startProxy({ port: 0, host: '127.0.0.1', allowlistPath, cagesPath, lookup: async () => [] });
  });
  afterAll(() => {
    proxy.close();
    vi.restoreAllMocks();
  });

  const register = (cages: unknown) => writeFileSync(cagesPath, JSON.stringify(cages));

  /** 403 is a refusal; 502 means the allowlist let the name through to the lookup, which answers nothing. */
  const ask = async (host: string, claim: string, method = 'CONNECT') => {
    const socket = connect((proxy.address() as { port: number }).port, '127.0.0.1');
    const auth = Buffer.from(`${claim}:x`).toString('base64');
    const target = method === 'CONNECT' ? `${host}:443` : `http://${host}/`;
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    const [chunk] = await once(socket, 'data');
    socket.destroy();
    return Number(String(chunk).split(' ')[1]);
  };
  const lastDenied = () => denied.at(-1)?.agent;

  it('reports the registered worker, whatever name the cage claims, on CONNECT and on plain HTTP', async () => {
    register({ '127.0.0.1': { agent: 'nova', allow: [] } });
    expect(await ask('evil.test', 'someone-else')).toBe(403);
    expect(lastDenied()).toBe('nova');
    expect(await ask('evil.test', 'another', 'GET')).toBe(403);
    expect(lastDenied()).toBe('nova');
  });

  it('gives a worker its own rules and no other worker them, even one that claims its name', async () => {
    register({ '127.0.0.1': { agent: 'nova', allow: ['pypi.org'] } });
    expect(await ask('pypi.org', 'x')).toBe(502);
    register({ '127.0.0.1': { agent: 'vega', allow: [] }, '10.9.9.9': { agent: 'nova', allow: ['pypi.org'] } });
    expect(await ask('pypi.org', 'nova')).toBe(403);
    expect(lastDenied()).toBe('vega');
  });

  it('names an unregistered address unknown and gives it only the project rules', async () => {
    register({});
    expect(await ask('pypi.org', 'nova')).toBe(403);
    expect(lastDenied()).toBe('unknown');
    expect(await ask('registry.npmjs.org', 'nova')).toBe(502);
  });

  it('does not fall back to the claimed name when the registry is unreadable', async () => {
    writeFileSync(cagesPath, '{');
    expect(await ask('pypi.org', 'nova')).toBe(403);
    expect(lastDenied()).toBe('unknown');
  });

  it('keeps the claimed name only where no registry exists', async () => {
    rmSync(cagesPath);
    expect(await ask('pypi.org', 'nova')).toBe(403);
    expect(lastDenied()).toBe('nova');
  });
});
