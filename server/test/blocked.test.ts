import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { scripted } from '../agents/scripted.ts';
import {
  BlockedLog,
  BlockedSites,
  DISTINCT_LIMIT,
  InvalidAttempt,
  MAX_SITES,
  MAX_STREAKS,
  parseAttempt,
  REPEAT_LIMIT,
  REPEAT_WINDOW_MS,
  renderBlocked,
  SITE_TTL_MS,
} from '../blocked.ts';
import { github } from '../githost/github.ts';
import { type RunningHq, startHq } from '../hq.ts';
import { cagesMode } from '../modes/cages.ts';
import type { Snapshot } from '../snapshot.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { SCRIPTS, TICKETS } from './fixtures/factory.ts';
import { hasSqlite, tempDir } from './helpers.ts';

const attempt = (over: Record<string, unknown> = {}, at = 1000) =>
  parseAttempt(
    { worker: 'nova', task: 'alpha/t1', tool: 'Bash', detail: 'cat .env', layer: 'L4', run: 'cages', ...over },
    at,
  );

describe('parseAttempt', () => {
  it('keeps worker, task, tool call and layer', () => {
    expect(attempt()).toEqual({
      worker: 'nova',
      task: 'alpha/t1',
      tool: 'Bash',
      detail: 'cat .env',
      layer: 'L4',
      run: 'cages',
      at: 1000,
    });
  });

  it('refuses a missing field and a layer that is not a code', () => {
    expect(() => attempt({ worker: '' })).toThrow(InvalidAttempt);
    expect(() => attempt({ layer: 'maybe' })).toThrow(InvalidAttempt);
    expect(() => parseAttempt('x', 0)).toThrow(InvalidAttempt);
  });

  it('strips control characters and bounds the tool call text', () => {
    const long = attempt({ detail: `a\u001b[31m\n${'b'.repeat(1000)}` });
    expect([...long.detail].some((c) => c.charCodeAt(0) < 32)).toBe(false);
    expect(long.detail.length).toBeLessThanOrEqual(240);
  });
});

describe('BlockedLog', () => {
  it('pauses a worker on the repeat limit and not before', () => {
    const log = new BlockedLog();
    const results = Array.from({ length: REPEAT_LIMIT }, () => log.record(attempt()));
    expect(results.map((r) => r.paused)).toEqual([false, false, true]);
    expect(log.paused()).toEqual(['nova']);
    expect(log.entries().map((e) => e.repeats)).toEqual([1, 2, 3]);
  });

  const varied = (n: number, over: Record<string, unknown> = {}) =>
    attempt({ tool: `CONNECT h${n}.test:443`, detail: `reason ${n}`, ...over });

  it('pauses on the tenth distinct attempt at one layer and not on the ninth', () => {
    const log = new BlockedLog();
    const paused = Array.from({ length: DISTINCT_LIMIT }, (_, n) => log.record(varied(n)).paused);
    expect(paused).toEqual([...Array(DISTINCT_LIMIT - 1).fill(false), true]);
    expect(log.paused()).toEqual(['nova']);
  });

  it('takes a changed detail or a changed port as a new distinct attempt, not as a fresh start', () => {
    const detail = new BlockedLog();
    for (let n = 0; n < DISTINCT_LIMIT; n++) detail.record(attempt({ detail: `cat .env ${n}` }));
    expect(detail.paused()).toEqual(['nova']);
    const port = new BlockedLog();
    for (let n = 0; n < DISTINCT_LIMIT; n++) port.record(attempt({ tool: `CONNECT evil.test:${n + 1}` }));
    expect(port.paused()).toEqual(['nova']);
  });

  it('counts distinct attempts per layer', () => {
    const log = new BlockedLog();
    for (let n = 0; n < DISTINCT_LIMIT - 1; n++) {
      log.record(varied(n, { layer: 'F2' }));
      log.record(varied(n, { layer: 'L4' }));
    }
    expect(log.paused()).toEqual([]);
  });

  it('counts per worker, so one worker cannot pause another', () => {
    const log = new BlockedLog();
    for (const worker of ['nova', 'vega', 'nova', 'vega']) log.record(attempt({ worker }));
    for (let n = 0; n < DISTINCT_LIMIT - 2; n++) log.record(varied(n, { worker: n % 2 ? 'nova' : 'vega' }));
    expect(log.paused()).toEqual([]);
  });

  it('resume clears the pause and both counts', () => {
    const log = new BlockedLog();
    for (let n = 0; n < DISTINCT_LIMIT - 1; n++) log.record(varied(n));
    for (let i = 0; i < REPEAT_LIMIT; i++) log.record(attempt());
    expect(log.resume('nova')).toBe(true);
    expect(log.isPaused('nova')).toBe(false);
    expect(log.record(attempt()).entry.repeats).toBe(1);
    expect(log.isPaused('nova')).toBe(false);
  });
});

describe('BlockedLog window', () => {
  const MINUTE = 60_000;

  it('pauses slow retries that never put three inside any ten minutes', () => {
    const log = new BlockedLog();
    const paused = [0, 9, 18].map((minute) => log.record(attempt({}, minute * MINUTE)).paused);
    expect(paused).toEqual([false, false, true]);
  });

  it('pauses slow varied attempts', () => {
    const log = new BlockedLog();
    for (let n = 0; n < DISTINCT_LIMIT; n++) log.record(attempt({ detail: `d${n}` }, n * 9 * MINUTE));
    expect(log.paused()).toEqual(['nova']);
  });

  it('forgets a streak once the window passes with no denial', () => {
    const log = new BlockedLog();
    log.record(attempt({}, 0));
    log.record(attempt({}, 1000));
    const late = log.record(attempt({}, 1000 + REPEAT_WINDOW_MS));
    expect(late).toMatchObject({ paused: false, entry: { repeats: 1 } });
  });

  it('drops expired streaks, so quiet workers cost no memory', () => {
    const log = new BlockedLog();
    for (let n = 0; n < 5; n++) log.record(attempt({ worker: `w${n}` }, n));
    log.record(attempt({}, 5 + REPEAT_WINDOW_MS));
    expect(log.size()).toEqual({ streaks: 1, keys: 1 });
  });

  it('keeps both maps under their caps through a flood, and evicts the longest quiet streak first', () => {
    const log = new BlockedLog();
    log.record(attempt({ worker: 'quiet' }, 0));
    for (let n = 0; n < 1000; n++) log.record(attempt({ detail: `d${n}` }, 1));
    expect(log.size()).toEqual({ streaks: 2, keys: DISTINCT_LIMIT });
    log.record(attempt({ worker: 'busy' }, 2));
    for (let n = 0; n < MAX_STREAKS - 2; n++) log.record(attempt({ worker: `w${n}` }, 3));
    log.record(attempt({ worker: 'busy' }, 4));
    log.record(attempt({ worker: 'one-more' }, 5));
    expect(log.size().streaks).toBe(MAX_STREAKS);
    expect(log.record(attempt({ worker: 'busy' }, 6)).paused).toBe(true);
    expect(log.record(attempt({ worker: 'quiet' }, 7)).entry.repeats).toBe(1);
  });

  it('pauses within nineteen denials whatever the details and gaps under the window', () => {
    const step = fc.record({ detail: fc.integer({ min: 0, max: 30 }), gap: fc.nat({ max: REPEAT_WINDOW_MS - 1 }) });
    const most = (REPEAT_LIMIT - 1) * (DISTINCT_LIMIT - 1) + 1;
    fc.assert(
      fc.property(fc.array(step, { minLength: most, maxLength: most }), (steps) => {
        const log = new BlockedLog();
        let at = 0;
        for (const { detail, gap } of steps) {
          at += gap;
          log.record(attempt({ detail: `d${detail}` }, at));
          expect(log.size().keys).toBeLessThanOrEqual(DISTINCT_LIMIT);
        }
        expect(log.isPaused('nova')).toBe(true);
      }),
    );
  });
});

describe('BlockedSites', () => {
  const site = (n: number | string, allow = true) => ({
    site: `h${n}.test:443`,
    host: `h${n}.test`,
    port: 443,
    agent: 'nova',
    allow,
  });

  it('counts a site and keeps it refused once any denial of it could not be allowed', () => {
    const sites = new BlockedSites();
    sites.note(site(1, false), 0);
    sites.note(site(1, true), 1);
    expect(sites.list(2)).toEqual([{ ...site(1, false), count: 2 }]);
  });

  it('stays under its cap, dropping the longest quiet site that Allow could open', () => {
    const sites = new BlockedSites();
    for (let n = 0; n < MAX_SITES * 3; n++) sites.note(site(n), n);
    const held = sites.list(MAX_SITES * 3);
    expect(held).toHaveLength(MAX_SITES);
    expect(held[0]?.host).toBe(`h${MAX_SITES * 2}.test`);
  });

  it('never forgets a refused site to make room, so a flood cannot bring its Allow back', () => {
    const sites = new BlockedSites(3);
    sites.note(site('evil', false), 0);
    for (let n = 0; n < 20; n++) sites.note(site(n), 1 + n);
    expect(sites.get('hevil.test:443', 30)?.allow).toBe(false);
    for (let n = 0; n < 20; n++) sites.note(site(`v${n}`, false), 30 + n);
    expect(sites.list(60).map((s) => s.host)).toEqual(['hevil.test', 'hv0.test', 'hv1.test']);
  });

  it('expires a site that has been quiet for its time to live', () => {
    const sites = new BlockedSites();
    sites.note(site(1), 0);
    sites.note(site(2), 5);
    expect(sites.get('h1.test:443', SITE_TTL_MS - 1)).toBeDefined();
    expect(sites.list(SITE_TTL_MS).map((s) => s.host)).toEqual(['h2.test']);
  });
});

describe('renderBlocked', () => {
  it('escapes a hostile tool call and names worker, tool call and layer', () => {
    const log = new BlockedLog();
    log.record(attempt({ detail: '<script>alert(1)</script>' }));
    const page = renderBlocked(log.entries(), []);
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;');
    expect(page).toContain('nova');
    expect(page).toContain('Bash');
    expect(page).toContain('L4');
  });
});

const running: RunningHq[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((hq) => hq.close()));
});

const send = async (hq: RunningHq, path: string, body: unknown) => {
  const res = await fetch(`${hq.url}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe.skipIf(!hasSqlite)('HQ blocked attempts', () => {
  it('lists posted attempts in the snapshot and on /blocked, and pauses the repeating worker', async () => {
    const hq = await startHq({ home: tempDir('blocked'), port: 0 });
    running.push(hq);
    const body = { worker: 'nova', task: 'alpha/t1', tool: 'Bash', detail: 'cat .env', layer: 'L4', run: 'cages' };
    const answers = [];
    for (let i = 0; i < REPEAT_LIMIT; i++) answers.push((await send(hq, '/api/sandbox/blocked', body)).json);
    expect(answers.map((a) => a.justPaused)).toEqual([false, false, true]);
    const snap: Snapshot = hq.snapshot();
    expect(snap.blocked).toHaveLength(REPEAT_LIMIT);
    expect(snap.paused).toEqual(['nova']);
    const page = await (await fetch(`${hq.url}/blocked`)).text();
    expect(page).toContain('BLOCKED ATTEMPTS (3)');
    expect(page).toContain('Paused: nova');
    expect((await send(hq, '/api/sandbox/blocked', { worker: 'nova' })).status).toBe(400);
    expect((await send(hq, '/api/workers/resume', { worker: 'nova' })).json).toEqual({ resumed: true });
    expect(hq.snapshot().paused).toEqual([]);
  });

  const denialHq = async (extra: { mode?: ReturnType<typeof cagesMode>; allow?: (site: string) => void } = {}) => {
    const sink: { push: (d: { host: string; port: number; agent: string; reason: string; at: string }) => void } = {
      push: () => {},
    };
    const hq = await startHq({
      home: tempDir('blocked'),
      port: 0,
      makeDriver: async (_hq, onDenial) => {
        sink.push = onDenial;
        return null;
      },
      ...(extra.mode === undefined ? {} : { mode: extra.mode }),
    });
    running.push(hq);
    await fetch(`${hq.url}/api/cages`, { method: 'POST', body: JSON.stringify({}) });
    return {
      hq,
      deny: (host: string, reason: string, port = 443) => sink.push({ host, port, agent: 'nova', reason, at: 'now' }),
    };
  };

  it('records a firewall denial as an F2 attempt', async () => {
    const { hq, deny } = await denialHq();
    deny('example.com', 'sni-mismatch');
    expect(hq.snapshot().blocked[0]).toMatchObject({ worker: 'nova', layer: 'F2', tool: 'CONNECT example.com:443' });
  });

  it('pauses a worker on three denials of one unlisted host (3 pypi.org denials)', async () => {
    const { hq, deny } = await denialHq();
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) deny('pypi.org', 'not-allowlisted');
    expect(hq.snapshot().paused).toEqual([]);
    deny('pypi.org', 'not-allowlisted');
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  it('pauses a worker on ten distinct unlisted hosts and counts them in the firewall zone', async () => {
    const { hq, deny } = await denialHq();
    for (let n = 0; n < DISTINCT_LIMIT - 1; n++) deny(`h${n}.example`, 'not-allowlisted');
    expect(hq.snapshot().paused).toEqual([]);
    expect(hq.snapshot().firewall).toEqual({ blocked: DISTINCT_LIMIT - 1, allowed: 4 });
    deny('h9.example', 'not-allowlisted');
    expect(hq.snapshot().paused).toEqual(['nova']);
    expect(hq.snapshot().firewall).toEqual({ blocked: DISTINCT_LIMIT, allowed: 4 });
  });

  it('pushes the state after the last denial of a burst to open floors', async () => {
    const { hq, deny } = await denialHq();
    const seen: Snapshot[] = [];
    const socket = new WebSocket(`${hq.url.replace('http', 'ws')}/api/ws`);
    socket.on('message', (data) => seen.push(JSON.parse(String(data)) as Snapshot));
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    for (let n = 0; n < DISTINCT_LIMIT; n++) deny(`h${n}.example`, 'not-allowlisted');
    await expect.poll(() => seen.at(-1)?.paused).toEqual(['nova']);
    expect(seen.at(-1)?.firewall?.blocked).toBe(DISTINCT_LIMIT);
    socket.close();
  });

  it('keeps the website items under their cap through a flood of hosts', async () => {
    const { hq, deny } = await denialHq({ mode: cagesWithEgress(async () => {}) });
    for (let n = 0; n < MAX_SITES + 50; n++) deny(`h${n}.example`, 'not-allowlisted');
    expect(hq.snapshot().actions.filter((a) => a.kind === 'website')).toHaveLength(MAX_SITES);
  });

  it('still pauses a worker that repeats a denial no Allow can fix', async () => {
    const { hq, deny } = await denialHq();
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('meta.ssrf.test', 'non-public-address');
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  it('pauses on a wildcard-style name the Allow action refuses, because no Allow is pending for it', async () => {
    const { hq, deny } = await denialHq();
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('*.evil.test', 'not-allowlisted');
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  const cagesWithEgress = (allow: (site: string) => Promise<void>) => {
    const fake = new FakeGithub();
    const agent = scripted({ scripts: SCRIPTS, retryMs: 10 });
    return cagesMode({
      host: github({ repo: 'acme/app', base: 'main', send: fake.transport('aw-nova'), log: () => {} }),
      reviewHost: github({ repo: 'acme/app', base: 'main', send: fake.transport('vega'), log: () => {} }),
      repo: 'acme/app',
      base: 'main',
      tickets: TICKETS,
      author: 'nova',
      reviewer: 'vega',
      workers: { nova: agent, vega: agent },
      egress: { allow },
      pollMs: 600_000,
    });
  };

  it('offers no Allow for a denial that is not about the allowlist, and the pause stays', async () => {
    const opened: string[] = [];
    const { hq, deny } = await denialHq({ mode: cagesWithEgress(async (site) => void opened.push(site)) });
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('meta.ssrf.test', 'non-public-address');
    expect(hq.snapshot().paused).toEqual(['nova']);
    expect((await send(hq, '/api/actions/allow', { host: 'meta.ssrf.test' })).status).toBe(400);
    expect(opened).toEqual([]);
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  it('offers no Allow for a fronting attempt reported under the SNI host', async () => {
    const opened: string[] = [];
    const { hq, deny } = await denialHq({ mode: cagesWithEgress(async (site) => void opened.push(site)) });
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('evil.test', 'sni-mismatch');
    expect(hq.snapshot().paused).toEqual(['nova']);
    expect((await send(hq, '/api/actions/allow', { host: 'evil.test' })).status).toBe(400);
    expect(opened).toEqual([]);
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  it('Allow on a not-allowlisted site opens it and never resumes a worker', async () => {
    const opened: string[] = [];
    const { hq, deny } = await denialHq({ mode: cagesWithEgress(async (site) => void opened.push(site)) });
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('meta.ssrf.test', 'non-public-address');
    deny('pypi.org', 'not-allowlisted');
    const answer = await send(hq, '/api/actions/allow', { host: 'pypi.org' });
    expect(answer.json).toEqual({ allowed: 'pypi.org:443' });
    expect(opened).toEqual(['pypi.org:443']);
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  it('keeps a site non-Allow-able once any denial for it was not a not-allowlisted one', async () => {
    const opened: string[] = [];
    const { hq, deny } = await denialHq({ mode: cagesWithEgress(async (site) => void opened.push(site)) });
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('evil.test', 'sni-mismatch');
    deny('evil.test', 'not-allowlisted');
    expect(hq.snapshot().actions.filter((a) => a.kind === 'website')).toMatchObject([
      { site: 'evil.test:443', allow: false, count: REPEAT_LIMIT + 1 },
    ]);
    expect((await send(hq, '/api/actions/allow', { host: 'evil.test' })).status).toBe(400);
    expect(opened).toEqual([]);
  });

  it('stops starting work for a paused worker', async () => {
    const fake = new FakeGithub();
    const agent = scripted({ scripts: SCRIPTS, retryMs: 10 });
    const hq = await startHq({
      home: tempDir('blocked'),
      port: 0,
      mode: cagesMode({
        host: github({ repo: 'acme/app', base: 'main', send: fake.transport('aw-nova'), log: () => {} }),
        reviewHost: github({ repo: 'acme/app', base: 'main', send: fake.transport('vega'), log: () => {} }),
        repo: 'acme/app',
        base: 'main',
        tickets: TICKETS,
        author: 'nova',
        reviewer: 'vega',
        workers: { nova: agent, vega: agent },
        pollMs: 600_000,
      }),
    });
    running.push(hq);
    const body = { worker: 'nova', tool: 'Bash', detail: 'cat .env', layer: 'L4' };
    for (let i = 0; i < REPEAT_LIMIT; i++) await send(hq, '/api/sandbox/blocked', body);
    await send(hq, '/api/tickets', { id: 'alpha/t2' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.prs).toHaveLength(0);
    await send(hq, '/api/workers/resume', { worker: 'nova' });
    const deadline = Date.now() + 4000;
    while (fake.prs.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.prs).toHaveLength(1);
  });
});
