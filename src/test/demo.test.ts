import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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

const boot = async (options: { demo?: boolean; assets?: string } = {}): Promise<RunningHq> => {
  const hq = await startHq({
    home: tempDir('demo'),
    port: 0,
    ...(options.demo === true ? { mode: demoMode(loadDemo(FIXTURE, 'fixtures/demo/events.jsonl'), 5) } : {}),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
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

  it('refuses a fixture line that is not an event', () => {
    const dir = tempDir('badfixture');
    writeFileSync(join(dir, 'e.jsonl'), '{"seq":1,"event":{"source":"human","kind":"nope"}}\n');
    expect(() => loadDemo(join(dir, 'e.jsonl'), 'x')).toThrow();
  });
});
