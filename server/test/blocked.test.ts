import { afterEach, describe, expect, it } from 'vitest';
import { scripted } from '../agents/scripted.ts';
import { BlockedLog, InvalidAttempt, parseAttempt, REPEAT_LIMIT, REPEAT_WINDOW_MS, renderBlocked } from '../blocked.ts';
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

  it('does not pause on different attempts', () => {
    const log = new BlockedLog();
    for (const detail of ['cat .env', 'cat .ssh', 'cat .npmrc', 'cat .aws']) log.record(attempt({ detail }));
    expect(log.paused()).toEqual([]);
  });

  it('counts a repeat per worker, so one worker cannot pause another', () => {
    const log = new BlockedLog();
    for (const worker of ['nova', 'vega', 'nova', 'vega']) log.record(attempt({ worker }));
    expect(log.paused()).toEqual([]);
  });

  it('resume clears the pause and the count', () => {
    const log = new BlockedLog();
    for (let i = 0; i < REPEAT_LIMIT; i++) log.record(attempt());
    expect(log.resume('nova')).toBe(true);
    expect(log.isPaused('nova')).toBe(false);
    expect(log.record(attempt()).entry.repeats).toBe(1);
  });
});

describe('BlockedLog window and operator decision', () => {
  it('counts only the attempts of the last window, so a repeat hours later does not add up', () => {
    const log = new BlockedLog();
    log.record(attempt({}, 0));
    log.record(attempt({}, 1000));
    const late = log.record(attempt({}, REPEAT_WINDOW_MS + 5000));
    expect(late.paused).toBe(false);
    expect(late.entry.repeats).toBe(1);
    expect(log.paused()).toEqual([]);
  });

  it('lists an attempt that waits on the operator without ever pausing for it', () => {
    const log = new BlockedLog();
    for (let i = 0; i < REPEAT_LIMIT * 3; i++)
      log.record(attempt({ tool: 'CONNECT pypi.org:443' }, i), { counts: false });
    expect(log.paused()).toEqual([]);
    expect(log.entries().at(-1)?.repeats).toBe(REPEAT_LIMIT * 3);
  });

  it('cleared resumes the workers a tool paused, drops its counts, and leaves other pauses alone', () => {
    const log = new BlockedLog();
    for (let i = 0; i < REPEAT_LIMIT; i++) log.record(attempt({ tool: 'CONNECT a.test:443' }, i));
    for (let i = 0; i < REPEAT_LIMIT; i++) log.record(attempt({ worker: 'vega', tool: 'CONNECT b.test:443' }, i));
    expect(log.paused()).toEqual(['nova', 'vega']);
    expect(log.cleared('CONNECT a.test:443', 'cat .env')).toEqual(['nova']);
    expect(log.paused()).toEqual(['vega']);
    expect(log.record(attempt({ tool: 'CONNECT a.test:443' }, 10)).entry.repeats).toBe(1);
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

  it('does not pause a worker whose retries wait on an Allow (3 pypi.org denials)', async () => {
    const { hq, deny } = await denialHq();
    for (let i = 0; i < REPEAT_LIMIT + 2; i++) deny('pypi.org', 'not-allowlisted');
    expect(hq.snapshot().blocked).toHaveLength(REPEAT_LIMIT + 2);
    expect(hq.snapshot().blocked.at(-1)?.repeats).toBe(REPEAT_LIMIT + 2);
    expect(hq.snapshot().paused).toEqual([]);
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

  it('Allow on a not-allowlisted site opens it and leaves a pause for another cause alone', async () => {
    const opened: string[] = [];
    const { hq, deny } = await denialHq({ mode: cagesWithEgress(async (site) => void opened.push(site)) });
    for (let i = 0; i < REPEAT_LIMIT; i++) deny('meta.ssrf.test', 'non-public-address');
    deny('pypi.org', 'not-allowlisted');
    const answer = await send(hq, '/api/actions/allow', { host: 'pypi.org' });
    expect(answer.json).toEqual({ allowed: 'pypi.org:443' });
    expect(opened).toEqual(['pypi.org:443']);
    expect(hq.snapshot().paused).toEqual(['nova']);
  });

  it('a pause is lifted by Allow only when its recorded cause was a not-allowlisted denial', () => {
    const log = new BlockedLog();
    for (let i = 0; i < REPEAT_LIMIT; i++)
      log.record(attempt({ tool: 'CONNECT x.test:443', detail: 'non-public-address' }, i));
    expect(log.cleared('CONNECT x.test:443', 'not-allowlisted')).toEqual([]);
    expect(log.paused()).toEqual(['nova']);
    expect(log.cleared('CONNECT x.test:443', 'non-public-address')).toEqual(['nova']);
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
