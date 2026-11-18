import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAsset } from '../../server/assets.ts';
import { type RunningHq, startHq } from '../../server/hq.ts';
import { demoMode, loadDemo } from '../../server/modes/demo.ts';
import { hasSqlite, tempDir } from '../../server/test/helpers.ts';

const FIXTURE = join(import.meta.dirname, '../../fixtures/demo/events.jsonl');
const running: RunningHq[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((hq) => hq.close()));
});

const boot = async (options: { demo?: boolean; assets?: string; readOnly?: string } = {}): Promise<RunningHq> => {
  const hq = await startHq({
    home: tempDir('demo'),
    port: 0,
    ...(options.demo === true ? { mode: demoMode(loadDemo(FIXTURE, 'fixtures/demo/events.jsonl'), 5) } : {}),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  running.push(hq);
  return hq;
};

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ok()).toBe(true);
};

describe('built assets', () => {
  const root = tempDir('assets');
  writeFileSync(join(root, 'index.html'), '<p>floor</p>');
  writeFileSync(join(root, 'app.js'), 'export {}');

  it('serves the index for / and a file by its type', () => {
    expect(readAsset(root, '/')?.body.toString()).toBe('<p>floor</p>');
    expect(readAsset(root, '/app.js')?.type).toBe('text/javascript; charset=utf-8');
  });

  it('refuses a path that leaves the folder and a missing file', () => {
    expect(readAsset(root, '/../package.json')).toBeNull();
    expect(readAsset(root, '/%2e%2e/package.json')).toBeNull();
    expect(readAsset(root, '/%00')).toBeNull();
    expect(readAsset(root, '/nope.js')).toBeNull();
    expect(readAsset(root, '/%E0%A4%A')).toBeNull();
  });

  it('refuses a path with no leading slash that climbs out of the folder', () => {
    const inner = join(root, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'a.js'), 'x');
    expect(readAsset(inner, '../app.js')).toBeNull();
    expect(readAsset(inner, 'a.js')?.body.toString()).toBe('x');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink to a file outside the folder and one inside it', () => {
    const outside = join(tempDir('outside'), 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'leak.txt'));
    symlinkSync(join(root, 'app.js'), join(root, 'alias.js'));
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'b.js'), 'b');
    symlinkSync(join(root, 'sub'), join(root, 'linked-dir'));
    expect(readAsset(root, '/leak.txt')).toBeNull();
    expect(readAsset(root, '/alias.js')).toBeNull();
    expect(readAsset(root, '/linked-dir/b.js')).toBeNull();
    expect(readAsset(root, '/sub/b.js')?.body.toString()).toBe('b');
  });

  it.skipIf(!hasSqlite)('HQ serves only GET requests for assets', async () => {
    const hq = await boot({ assets: root });
    for (const method of ['POST', 'PUT', 'DELETE'])
      expect((await fetch(`${hq.url}/app.js`, { method })).status).toBe(404);
  });

  it.skipIf(!hasSqlite)(
    'HQ answers every response with nosniff and a policy that allows no inline script',
    async () => {
      const hq = await boot({ assets: root });
      for (const path of ['/', '/app.js', '/api/health', '/api/missing']) {
        const res = await fetch(`${hq.url}${path}`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        const policy = res.headers.get('content-security-policy') ?? '';
        expect(policy).toContain("default-src 'self'");
        expect(policy).toContain("script-src 'self';");
        expect(policy).not.toContain('unsafe-inline');
        expect(policy).not.toMatch(/https?:\/\//);
      }
      const forbidden = await fetch(`${hq.url}/app.js`, { headers: { origin: 'http://evil.test' } });
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.get('x-content-type-options')).toBe('nosniff');
    },
  );

  it.skipIf(!hasSqlite)(
    'the plain dashboard allows its one inline script and style by hash, nothing else',
    async () => {
      const hq = await boot();
      const res = await fetch(`${hq.url}/`);
      const html = await res.text();
      const policy = res.headers.get('content-security-policy') ?? '';
      const hashOf = (tag: string) =>
        `'sha256-${createHash('sha256')
          .update(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1] ?? '')
          .digest('base64')}'`;
      expect(policy).toContain(`script-src 'self' ${hashOf('script')};`);
      expect(policy).toContain(`style-src 'self' ${hashOf('style')};`);
      expect(policy).not.toContain('unsafe-inline');
    },
  );

  it.skipIf(!hasSqlite)('the policy on every kind of response is exactly the one the floor needs', async () => {
    const hq = await boot({ assets: root });
    const dashboard = await boot();
    const directives = (policy: string) =>
      Object.fromEntries(
        policy
          .split(';')
          .map((part) => part.trim().split(/\s+/))
          .filter(([name]) => name !== '')
          .map(([name, ...values]) => [name, values]),
      );
    for (const url of [
      `${hq.url}/`,
      `${hq.url}/app.js`,
      `${hq.url}/api/health`,
      `${hq.url}/api/missing`,
      `${dashboard.url}/`,
    ]) {
      const parsed = directives((await fetch(url)).headers.get('content-security-policy') ?? '');
      expect(Object.keys(parsed).sort()).toEqual([
        'base-uri',
        'connect-src',
        'default-src',
        'font-src',
        'form-action',
        'frame-ancestors',
        'img-src',
        'object-src',
        'script-src',
        'style-src',
      ]);
      expect(parsed['connect-src']).toEqual(["'self'", 'ws://127.0.0.1:*', 'ws://localhost:*']);
      expect(parsed['frame-ancestors']).toEqual(["'none'"]);
      expect(parsed['object-src']).toEqual(["'none'"]);
      expect(parsed['base-uri']).toEqual(["'none'"]);
      expect(parsed['form-action']).toEqual(["'none'"]);
      expect(parsed['default-src']).toEqual(["'self'"]);
      expect(parsed['img-src']).toEqual(["'self'", 'data:']);
      expect(parsed['font-src']).toEqual(["'self'"]);
    }
  });

  it.skipIf(!hasSqlite)('HQ serves them on GET and keeps the API', async () => {
    const hq = await boot({ assets: root });
    expect(await (await fetch(`${hq.url}/`)).text()).toBe('<p>floor</p>');
    expect((await fetch(`${hq.url}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect(((await (await fetch(`${hq.url}/api/health`)).json()) as { ok: boolean }).ok).toBe(true);
    expect((await fetch(`${hq.url}/api/missing`)).status).toBe(404);
  });
});

describe.skipIf(!hasSqlite)('demo mode', () => {
  it('replays the recorded run through the reducer and the same snapshot path, ending shipped', async () => {
    const hq = await boot({ demo: true });
    await until(() => hq.snapshot().state.boxes['alpha/p12c']?.state === 'shipped');
    const snapshot = hq.snapshot();
    expect(snapshot.state.shipments['alpha/p12c']?.state).toBe('departed');
    expect(snapshot.rev).toBeGreaterThanOrEqual(16);
  });

  it('records every fixture event in the HQ event log in order', async () => {
    const hq = await boot({ demo: true });
    const expected = readFileSync(FIXTURE, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: unknown }).event);
    await until(() => hq.snapshot().state.boxes['alpha/p12c']?.state === 'shipped');
    const logged = ((await (await fetch(`${hq.url}/api/events?after=0`)).json()) as { events: { event: unknown }[] })
      .events;
    expect(logged.map((entry) => entry.event)).toEqual(expected);
  });

  it('says which file it replays and the hash of those bytes', async () => {
    const hq = await boot({ demo: true });
    const info = (await (await fetch(`${hq.url}/api/demo`)).json()) as Record<string, unknown>;
    expect(info.source).toBe('fixtures/demo/events.jsonl');
    expect(info.sha256).toBe(createHash('sha256').update(readFileSync(FIXTURE)).digest('hex'));
    expect(info.total).toBe(16);
  });

  it('reports how many events it has replayed so far', async () => {
    const hq = await boot({ demo: true });
    await until(() => hq.snapshot().state.boxes['alpha/p12c']?.state === 'shipped');
    expect(((await (await fetch(`${hq.url}/api/demo`)).json()) as { replayed: number }).replayed).toBe(16);
  });

  it('a normal HQ has no /api/demo', async () => {
    const hq = await boot();
    expect((await fetch(`${hq.url}/api/demo`)).status).toBe(404);
  });

  it('names the file and the line of a fixture line that is not an event or not JSON', () => {
    const dir = tempDir('badfixture');
    const good = '{"seq":1,"event":{"source":"human","kind":"add_worker","worker":"nova"}}';
    writeFileSync(join(dir, 'e.jsonl'), `${good}\n\n{"seq":2,"event":{"source":"human","kind":"nope"}}\n`);
    expect(() => loadDemo(join(dir, 'e.jsonl'), 'x.jsonl')).toThrow(/^x\.jsonl line 3: /);
    writeFileSync(join(dir, 'f.jsonl'), `${good}\nnot json\n`);
    expect(() => loadDemo(join(dir, 'f.jsonl'), 'x.jsonl')).toThrow(/^x\.jsonl line 2: not a JSON line/);
    expect(() => loadDemo(join(dir, 'missing.jsonl'), 'x.jsonl')).toThrow(/cannot read/);
  });

  it('skips a line of only spaces or tabs and still counts it in the line numbers', () => {
    const dir = tempDir('blankfixture');
    const good = '{"seq":1,"event":{"source":"human","kind":"add_worker","worker":"nova"}}';
    writeFileSync(join(dir, 'g.jsonl'), `${good}\n  \t \n\n`);
    expect(loadDemo(join(dir, 'g.jsonl'), 'x.jsonl').events).toHaveLength(1);
    writeFileSync(join(dir, 'h.jsonl'), `${good}\n \t\nnot json\n`);
    expect(() => loadDemo(join(dir, 'h.jsonl'), 'x.jsonl')).toThrow(/^x\.jsonl line 3: not a JSON line/);
  });
});

describe.skipIf(!hasSqlite)('demo mode is read-only', () => {
  const MESSAGE = 'demo mode is read-only';
  const event = { source: 'human', kind: 'add_worker', worker: 'mallory' };
  const writes: [string, string, unknown][] = [
    ['POST', '/api/events', event],
    ['POST', '/api/factories', { root: '/tmp/x' }],
    ['POST', '/api/repos', { factory: 'x', path: '/tmp/x' }],
    ['POST', '/api/stop', {}],
    ['POST', '/api/cages', { task: 't', worker: 'w', source: 's' }],
    ['DELETE', '/api/cages/anything', undefined],
    ['PUT', '/api/events', event],
    ['POST', '/api/anything-else', {}],
  ];

  it.each(writes)('%s %s is refused with 403 and says why', async (method, path, body) => {
    const hq = await boot({ demo: true, readOnly: MESSAGE });
    const res = await fetch(`${hq.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(MESSAGE);
    expect(hq.snapshot().state.staff.mallory).toBeUndefined();
  });

  it('still replays the recorded run and answers reads', async () => {
    const hq = await boot({ demo: true, readOnly: MESSAGE });
    await until(() => hq.snapshot().state.boxes['alpha/p12c']?.state === 'shipped');
    expect((await fetch(`${hq.url}/api/health`)).status).toBe(200);
    expect((await fetch(`${hq.url}/api/demo`)).status).toBe(200);
    expect((await fetch(`${hq.url}/api/missing`)).status).toBe(404);
  });

  it('a normal HQ still takes writes', async () => {
    const hq = await boot();
    const res = await fetch(`${hq.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
  });
});
