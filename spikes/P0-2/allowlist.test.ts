import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowed, parseAllowlist, parseConnectTarget, toSquidConf } from './proxy/allowlist.mjs';
import { startProxy } from './proxy/node-proxy.mjs';

const rules = parseAllowlist(`
# registries
registry.npmjs.org
*.pythonhosted.org
api.example.dev:8443
`);

describe('isAllowed', () => {
  it('matches an exact host on the default port 443 only', () => {
    expect(isAllowed(rules, 'registry.npmjs.org', 443)).toBe(true);
    expect(isAllowed(rules, 'REGISTRY.npmjs.org.', 443)).toBe(true);
    expect(isAllowed(rules, 'registry.npmjs.org', 80)).toBe(false);
    expect(isAllowed(rules, 'npmjs.org', 443)).toBe(false);
    expect(isAllowed(rules, 'registry.npmjs.org.evil.test', 443)).toBe(false);
  });

  it('matches an explicit port', () => {
    expect(isAllowed(rules, 'api.example.dev', 8443)).toBe(true);
    expect(isAllowed(rules, 'api.example.dev', 443)).toBe(false);
  });

  it('matches subdomains of a wildcard but not its apex or a lookalike', () => {
    expect(isAllowed(rules, 'files.pythonhosted.org', 443)).toBe(true);
    expect(isAllowed(rules, 'a.b.pythonhosted.org', 443)).toBe(true);
    expect(isAllowed(rules, 'pythonhosted.org', 443)).toBe(false);
    expect(isAllowed(rules, 'evilpythonhosted.org', 443)).toBe(false);
  });

  it('denies IP literals, v4 and v6', () => {
    expect(isAllowed(rules, '104.16.1.34', 443)).toBe(false);
    expect(isAllowed(rules, '[2606:4700::6810:122]', 443)).toBe(false);
    expect(isAllowed(parseAllowlist('*.0.1'), '10.0.0.1', 443)).toBe(false);
  });

  it('rejects IP literals and malformed rules in the allowlist itself', () => {
    expect(() => parseAllowlist('1.1.1.1')).toThrow(/not a host rule/);
    expect(() => parseAllowlist('*.*.example.com')).toThrow(/not a host rule/);
    expect(() => parseAllowlist('exa mple.com')).toThrow(/not a host rule/);
  });
});

describe('parseConnectTarget', () => {
  it('reads host:port and bracketed IPv6', () => {
    expect(parseConnectTarget('registry.npmjs.org:443')).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(parseConnectTarget('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(parseConnectTarget('registry.npmjs.org')).toBeNull();
    expect(parseConnectTarget('host:0')).toBeNull();
    expect(parseConnectTarget('host:70000')).toBeNull();
  });
});

describe('toSquidConf', () => {
  it('emits anchored regex ACLs paired with each rule port and denies the rest', () => {
    const conf = toSquidConf(rules, { dnsServer: '10.0.0.2' });
    expect(conf).toContain('acl r0_host dstdom_regex -n -i ^registry\\.npmjs\\.org$');
    expect(conf).toContain('acl r1_host dstdom_regex -n -i \\.pythonhosted\\.org$');
    expect(conf).toContain('acl r2_port port 8443');
    expect(conf).toContain('dns_nameservers 10.0.0.2');
    expect(conf.trimEnd().endsWith('http_access deny all')).toBe(true);
  });
});

describe('node CONNECT proxy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-p0-2-test-'));
  const allowlistPath = join(dir, 'allowlist.txt');
  writeFileSync(allowlistPath, 'registry.npmjs.org\n');
  const events: unknown[] = [];
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      events.push({ path: req.url, ...JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  let proxy: Server;

  const portOf = (server: Server) => {
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  };

  beforeAll(async () => {
    await once(stub.listen(0, '127.0.0.1'), 'listening');
    proxy = await startProxy({
      port: 0,
      host: '127.0.0.1',
      allowlistPath,
      denyUrl: `http://127.0.0.1:${portOf(stub)}/api/sandbox/deny`,
    });
  });

  afterAll(() => {
    proxy.close();
    stub.close();
  });

  async function connectThrough(target: string, user: string) {
    const socket = connect(portOf(proxy), '127.0.0.1');
    const auth = Buffer.from(`${user}:x`).toString('base64');
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    const [chunk] = await once(socket, 'data');
    socket.destroy();
    return String(chunk).split('\r\n')[0];
  }

  it('answers 403 to a denied host and an IP literal, and posts one labeled deny event each', async () => {
    expect(await connectThrough('example.com:443', 'nova')).toBe('HTTP/1.1 403 Forbidden');
    expect(await connectThrough('1.1.1.1:443', 'orion')).toBe('HTTP/1.1 403 Forbidden');
    await expect.poll(() => events.length).toBe(2);
    expect(events).toMatchObject([
      { path: '/api/sandbox/deny', host: 'example.com', port: 443, agent: 'nova', method: 'CONNECT' },
      { path: '/api/sandbox/deny', host: '1.1.1.1', port: 443, agent: 'orion', method: 'CONNECT' },
    ]);
  });

  it('picks up an allowlist edit on the next request', async () => {
    expect(await connectThrough('localhost:9', 'nova')).toBe('HTTP/1.1 403 Forbidden');
    writeFileSync(allowlistPath, 'registry.npmjs.org\nlocalhost:9\n');
    expect(await connectThrough('localhost:9', 'nova')).toBe('HTTP/1.1 502 Bad Gateway');
  });
});
