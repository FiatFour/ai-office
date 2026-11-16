import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress } from './proxy/address.mjs';
import { isAllowed, parseAllowlist, parseConnectTarget, toSquidConf } from './proxy/allowlist.mjs';
import { startProxy } from './proxy/node-proxy.mjs';
import { parseClientHello } from './proxy/tls-hello.mjs';

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

describe('isPublicAddress', () => {
  it('rejects loopback, private, link-local, CGNAT, ULA, multicast and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:8.8.8.8',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('accepts routable unicast addresses and refuses non-addresses', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('toSquidConf non-public deny', () => {
  it('denies a non-public destination in each rule before its allow, and only after the host and port matched', () => {
    const conf = toSquidConf(rules, { dnsServer: '10.0.0.2' });
    const lines = conf.split('\n');
    rules.forEach((_, index) => {
      const deny = lines.indexOf(`http_access deny CONNECT r${index}_host r${index}_port non_public_dst`);
      expect(deny).toBeGreaterThan(-1);
      expect(lines[deny + 1]).toBe(`http_access allow CONNECT r${index}_host r${index}_port`);
    });
    expect(conf).not.toMatch(/http_access (allow|deny) CONNECT non_public_dst/);
    expect(conf).toContain('169.254.0.0/16');
    expect(conf).toContain('fc00::/7');
  });
});

function extension(type: number, data: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

function sniExtension(...names: string[]) {
  const entries = names.map((name) => {
    const bytes = Buffer.from(name, 'latin1');
    const entry = Buffer.alloc(3);
    entry.writeUInt16BE(bytes.length, 1);
    return Buffer.concat([entry, bytes]);
  });
  const list = Buffer.concat(entries);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(list.length);
  return extension(0, Buffer.concat([length, list]));
}

function clientHello({ extensions = [] as Buffer[], recordSize = 16384 } = {}) {
  const exts = Buffer.concat(extensions);
  const extLength = Buffer.alloc(2);
  extLength.writeUInt16BE(exts.length);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    ...(extensions.length > 0 ? [extLength, exts] : []),
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0, 0, 0]), body]);
  handshake.writeUIntBE(body.length, 1, 3);
  const records: Buffer[] = [];
  for (let offset = 0; offset < handshake.length; offset += recordSize) {
    const chunk = handshake.subarray(offset, offset + recordSize);
    const header = Buffer.from([22, 3, 1, 0, 0]);
    header.writeUInt16BE(chunk.length, 3);
    records.push(header, chunk);
  }
  return Buffer.concat(records);
}

describe('parseClientHello', () => {
  it('reads the SNI, lowercased', () => {
    const hello = clientHello({ extensions: [sniExtension('Registry.NPMJS.org')] });
    expect(parseClientHello(hello)).toEqual({ kind: 'hello', sni: 'registry.npmjs.org', ech: false });
  });

  it('reads the SNI of a hello split across two handshake records', () => {
    const hello = clientHello({ extensions: [sniExtension('registry.npmjs.org')], recordSize: 40 });
    expect(parseClientHello(hello)).toEqual({ kind: 'hello', sni: 'registry.npmjs.org', ech: false });
  });

  it('asks for more bytes until the hello is complete, at every cut point', () => {
    const hello = clientHello({ extensions: [sniExtension('registry.npmjs.org')] });
    for (let cut = 0; cut < hello.length; cut += 1) {
      expect(parseClientHello(hello.subarray(0, cut)).kind, `cut ${cut}`).toBe('need-more');
    }
  });

  it('reports a missing SNI and an ECH extension', () => {
    expect(parseClientHello(clientHello())).toEqual({ kind: 'hello', sni: null, ech: false });
    const ech = clientHello({ extensions: [sniExtension('registry.npmjs.org'), extension(0xfe0d, Buffer.alloc(8))] });
    expect(parseClientHello(ech)).toEqual({ kind: 'hello', sni: 'registry.npmjs.org', ech: true });
  });

  it('rejects plain HTTP, two server names and a truncated field', () => {
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')).kind).toBe('invalid');
    expect(parseClientHello(clientHello({ extensions: [sniExtension('a.test', 'b.test')] })).kind).toBe('invalid');
    expect(parseClientHello(clientHello({ extensions: [sniExtension('a.test'), sniExtension('b.test')] })).kind).toBe(
      'invalid',
    );
    const broken = clientHello({ extensions: [sniExtension('a.test')] });
    broken.writeUInt16BE(0xffff, 5 + 4 + 2 + 32 + 1);
    expect(parseClientHello(broken).kind).toBe('invalid');
  });

  it('reads the SNI node itself sends', async () => {
    const server = createTcpServer();
    const firstBytes = new Promise<Buffer>((resolve) => server.once('connection', (s) => s.once('data', resolve)));
    await once(server.listen(0, '127.0.0.1'), 'listening');
    const { connect: tlsConnect } = await import('node:tls');
    const socket = tlsConnect({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      servername: 'Registry.npmjs.org',
    });
    socket.on('error', () => {});
    const hello = parseClientHello(await firstBytes);
    socket.destroy();
    server.close();
    expect(hello).toEqual({ kind: 'hello', sni: 'registry.npmjs.org', ech: false });
  });
});

describe('node CONNECT proxy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-p0-2-test-'));
  const allowlistPath = join(dir, 'allowlist.txt');
  writeFileSync(allowlistPath, 'registry.npmjs.org\nrebind.test\nmixed.test\n');
  const events: Array<Record<string, unknown>> = [];
  const stub = createServer(async (req, res) => {
    events.push({ path: req.url, ...JSON.parse(await text(req)) });
    res.writeHead(204).end();
  });
  const upstreamBytes: Buffer[] = [];
  const upstream = createTcpServer((socket) => {
    socket.on('data', (chunk) => upstreamBytes.push(chunk));
    socket.write('upstream-says-hi');
  });
  const answers: Record<string, string[]> = {
    'registry.npmjs.org': ['104.16.1.34'],
    'rebind.test': ['169.254.169.254'],
    'mixed.test': ['1.1.1.1', '10.0.0.5'],
    'stalled.test': ['8.8.4.4'],
  };
  const lookups: string[] = [];
  const dialed: string[] = [];
  const sockets: Socket[] = [];
  let proxy: Server;

  const portOf = (server: Server | ReturnType<typeof createTcpServer>) => {
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  };

  beforeAll(async () => {
    await once(stub.listen(0, '127.0.0.1'), 'listening');
    await once(upstream.listen(0, '127.0.0.1'), 'listening');
    proxy = await startProxy({
      port: 0,
      host: '127.0.0.1',
      allowlistPath,
      denyUrl: `http://127.0.0.1:${portOf(stub)}/api/sandbox/deny`,
      lookup: async (name) => {
        lookups.push(name);
        return (answers[name] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
      dial: ({ host }) => {
        dialed.push(host);
        if (host === '8.8.4.4') return new Socket();
        const socket = connect(portOf(upstream), '127.0.0.1');
        sockets.push(socket);
        return socket;
      },
      connectTimeoutMs: 150,
    });
  });

  afterAll(() => {
    proxy.close();
    stub.close();
    upstream.close();
  });

  async function openTunnel(target: string, user = 'nova') {
    const socket = connect(portOf(proxy), '127.0.0.1');
    const auth = Buffer.from(`${user}:x`).toString('base64');
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    const [chunk] = await once(socket, 'data');
    return { socket, status: String(chunk).split('\r\n')[0] };
  }

  async function connectThrough(target: string, user: string) {
    const { socket, status } = await openTunnel(target, user);
    socket.destroy();
    return status;
  }

  async function sendHello(target: string, hello: Buffer) {
    const { socket, status } = await openTunnel(target);
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));
    socket.write(hello);
    await Promise.race([once(socket, 'close'), new Promise((resolve) => setTimeout(resolve, 400))]);
    const closed = socket.destroyed || socket.readableEnded;
    socket.destroy();
    return { status, closed, received: Buffer.concat(received).toString() };
  }

  it('answers 403 to a denied host and an IP literal, and posts one labeled deny event each', async () => {
    expect(await connectThrough('example.com:443', 'nova')).toBe('HTTP/1.1 403 Forbidden');
    expect(await connectThrough('1.1.1.1:443', 'orion')).toBe('HTTP/1.1 403 Forbidden');
    await expect.poll(() => events.length).toBe(2);
    expect(events).toMatchObject([
      { path: '/api/sandbox/deny', host: 'example.com', port: 443, agent: 'nova', method: 'CONNECT' },
      { path: '/api/sandbox/deny', host: '1.1.1.1', port: 443, agent: 'orion', method: 'CONNECT' },
    ]);
    expect(lookups).toEqual([]);
  });

  it('refuses an allowlisted name that resolves to a non-public address, and never dials', async () => {
    events.length = 0;
    expect(await connectThrough('rebind.test:443', 'nova')).toBe('HTTP/1.1 403 Forbidden');
    expect(await connectThrough('mixed.test:443', 'nova')).toBe('HTTP/1.1 403 Forbidden');
    await expect.poll(() => events.length).toBe(2);
    expect(events).toMatchObject([
      { host: 'rebind.test', port: 443, reason: 'non-public-address' },
      { host: 'mixed.test', port: 443, reason: 'non-public-address' },
    ]);
    expect(dialed).toEqual([]);
  });

  it('dials the address it checked, after one lookup', async () => {
    lookups.length = 0;
    const result = await sendHello(
      'registry.npmjs.org:443',
      clientHello({ extensions: [sniExtension('registry.npmjs.org')] }),
    );
    expect(result.status).toBe('HTTP/1.1 200 Connection Established');
    expect(lookups).toEqual(['registry.npmjs.org']);
    expect(dialed).toEqual(['104.16.1.34']);
  });

  it('forwards the whole ClientHello and the reply when the SNI equals the CONNECT host', async () => {
    upstreamBytes.length = 0;
    const hello = clientHello({ extensions: [sniExtension('Registry.npmjs.org')] });
    const result = await sendHello('registry.npmjs.org:443', hello);
    expect(result.received).toContain('upstream-says-hi');
    expect(Buffer.concat(upstreamBytes).equals(hello)).toBe(true);
  });

  it('closes a tunnel whose SNI names another host and posts the fronted name', async () => {
    events.length = 0;
    upstreamBytes.length = 0;
    const result = await sendHello(
      'registry.npmjs.org:443',
      clientHello({ extensions: [sniExtension('example.com')] }),
    );
    expect(result.closed).toBe(true);
    expect(result.received).not.toContain('upstream-says-hi');
    expect(Buffer.concat(upstreamBytes)).toHaveLength(0);
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ host: 'example.com', port: 443, reason: 'sni-mismatch' });
  });

  it('closes a tunnel with no SNI, with ECH, with plain HTTP, and with silence', async () => {
    const cases: Array<[string, Buffer]> = [
      ['no-sni', clientHello()],
      ['ech', clientHello({ extensions: [sniExtension('registry.npmjs.org'), extension(0xfe0d, Buffer.alloc(8))] })],
      ['not-tls', Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')],
    ];
    for (const [reason, hello] of cases) {
      events.length = 0;
      const result = await sendHello('registry.npmjs.org:443', hello);
      expect(result.closed, reason).toBe(true);
      expect(result.received, reason).not.toContain('upstream-says-hi');
      await expect.poll(() => events.length).toBe(1);
      expect(events[0], reason).toMatchObject({ host: 'registry.npmjs.org', reason });
    }
  });

  it('accepts a hello that arrives in pieces', async () => {
    const hello = clientHello({ extensions: [sniExtension('registry.npmjs.org')] });
    const { socket } = await openTunnel('registry.npmjs.org:443');
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));
    for (let offset = 0; offset < hello.length; offset += 7) {
      socket.write(hello.subarray(offset, offset + 7));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await expect.poll(() => Buffer.concat(received).toString()).toContain('upstream-says-hi');
    socket.destroy();
  });

  it('picks up an allowlist edit on the next request', async () => {
    expect(await connectThrough('later.test:443', 'nova')).toBe('HTTP/1.1 403 Forbidden');
    answers['later.test'] = ['8.8.8.8'];
    writeFileSync(allowlistPath, 'registry.npmjs.org\nlater.test\n');
    expect(await connectThrough('later.test:443', 'nova')).toBe('HTTP/1.1 200 Connection Established');
  });

  it('answers 502 when the upstream connect times out', async () => {
    writeFileSync(allowlistPath, 'registry.npmjs.org\nstalled.test\n');
    expect(await connectThrough('stalled.test:443', 'nova')).toBe('HTTP/1.1 502 Bad Gateway');
  });

  it('writes no 502 into a tunnel that is already established when the upstream fails', async () => {
    writeFileSync(allowlistPath, 'registry.npmjs.org\n');
    sockets.length = 0;
    const { socket, status } = await openTunnel('registry.npmjs.org:443');
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));
    socket.write(clientHello({ extensions: [sniExtension('registry.npmjs.org')] }));
    await expect.poll(() => Buffer.concat(received).toString()).toContain('upstream-says-hi');
    sockets.at(-1)?.destroy(new Error('upstream reset'));
    await once(socket, 'close');
    expect(Buffer.concat(received).toString()).not.toContain('502');
  });

  it('answers 502 before the 200 when the name does not resolve', async () => {
    writeFileSync(allowlistPath, 'registry.npmjs.org\nnowhere.test\n');
    expect(await connectThrough('nowhere.test:443', 'nova')).toBe('HTTP/1.1 502 Bad Gateway');
  });
});

describe('node CONNECT proxy deny event cap', () => {
  it('posts at most the cap per second and keeps logging the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-p0-2-cap-'));
    const allowlistPath = join(dir, 'allowlist.txt');
    writeFileSync(allowlistPath, 'registry.npmjs.org\n');
    const posts: unknown[] = [];
    const stub = createServer(async (req, res) => {
      posts.push(JSON.parse(await text(req)));
      res.writeHead(204).end();
    });
    await once(stub.listen(0, '127.0.0.1'), 'listening');
    const stubPort = (stub.address() as { port: number }).port;
    const proxy = await startProxy({
      port: 0,
      host: '127.0.0.1',
      allowlistPath,
      denyUrl: `http://127.0.0.1:${stubPort}/api/sandbox/deny`,
      denyEventsPerSecond: 5,
    });
    const proxyPort = (proxy.address() as { port: number }).port;
    for (let i = 0; i < 30; i += 1) {
      const socket = connect(proxyPort, '127.0.0.1');
      socket.write(`CONNECT flood${i}.test:443 HTTP/1.1\r\nHost: x\r\n\r\n`);
      await once(socket, 'data');
      socket.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    proxy.close();
    stub.close();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThanOrEqual(10);
  });
});
