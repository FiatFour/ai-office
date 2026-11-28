import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXES } from '../../server/preflight/host.ts';
import { artboardSpec, canvasCompare } from './canvas-compare.mjs';
import { launch, OUT, ROOT, startHqFree } from './harness.mjs';

/**
 * Stop docker, see the FAIL and its fix, on a real HQ and the real docker CLI.
 * The machine's daemon is never touched: HQ talks to it through a socket this lane owns (`DOCKER_HOST`), and "stop docker" closes that socket.
 * The cage image is one that does not exist, so every passing state also carries a WARN that must not block START.
 */

const DAEMON = '/var/run/docker.sock';
const NO_IMAGE = 'aw-preflight-absent:none';

/** A unix socket that forwards to the real daemon and can be taken away. */
const relay = (/** @type {string} */ path) => {
  /** @type {Set<import('node:net').Socket>} */
  const open = new Set();
  const server = createServer((client) => {
    const daemon = connect(DAEMON);
    for (const socket of [client, daemon]) {
      open.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        open.delete(socket);
        client.destroy();
        daemon.destroy();
      });
    }
    client.pipe(daemon);
    daemon.pipe(client);
  });
  return {
    start: () => new Promise((resolve) => server.listen(path, () => resolve(undefined))),
    stop: async () => {
      if (!server.listening) return;
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      rmSync(path, { force: true });
    },
  };
};

/** @param {import('playwright').Page} page */
const shown = async (page) => {
  await page.waitForSelector('.pf[data-phase="done"]', { timeout: 60_000 });
  const rows = await page.$$eval('[data-check]', (nodes) =>
    nodes.map((node) => [
      node.getAttribute('data-check'),
      { status: node.getAttribute('data-status'), fix: node.querySelector('code')?.textContent ?? null },
    ]),
  );
  return {
    checks: Object.fromEntries(rows),
    verdict: await page.getAttribute('[data-verdict]', 'data-verdict'),
    start: await page.isEnabled('[data-testid="pf-start"]'),
  };
};

export const PREFLIGHT_SPEC = artboardSpec({
  name: 'Preflight',
  dir: join(ROOT, 'docs', 'review', 'P3-10'),
  minEntries: 12,
});

/**
 * The Preflight artboard against the built screen, on the artboard's own computer (Windows) with docker not answering.
 * Check details and the engine list name this machine's versions, temp folders and installed engines, so they are replaced before the inventory is taken.
 * @param {import('playwright').Browser} browser
 */
export const comparePreflight = async (browser) => {
  const hq = await startHqFree({
    env: {
      AGENT_WORKS_HOST: 'windows',
      AGENT_WORKS_ENGINE: 'docker',
      DOCKER_HOST: `unix://${join(tmpdir(), 'aw-no-docker.sock')}`,
    },
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${hq.url}/?lang=en#/preflight`);
    await shown(page);
    await page.$$eval('.pf-detail', (nodes) => {
      for (const node of nodes) node.textContent = 'detail';
    });
    await page.$eval('[data-testid="pf-engines"]', (node) => {
      node.textContent = 'engines';
    });
    const verdict = await canvasCompare(browser, page, { inventory: {}, text: '' }, PREFLIGHT_SPEC);
    await ctx.close();
    return verdict;
  } finally {
    await hq.stop();
  }
};

/** @param {import('playwright').Browser} browser */
export const runPreflightLane = async (browser) => {
  /** @type {string[]} */
  const problems = [];
  const expect = (/** @type {boolean} */ holds, /** @type {string} */ what) => {
    if (!holds) problems.push(what);
  };
  if (!existsSync(DAEMON)) return { ok: false, note: `not run: no docker socket at ${DAEMON}` };
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'aw-pf-'));
  const socket = relay(join(dir, 'docker.sock'));
  const env = {
    DOCKER_HOST: `unix://${join(dir, 'docker.sock')}`,
    AGENT_WORKS_ENGINE: 'docker',
    AGENT_WORKS_CAGE_IMAGE: NO_IMAGE,
  };
  const newPage = async () => (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const shot = (/** @type {import('playwright').Page} */ page, /** @type {string} */ name) =>
    page.screenshot({ path: join(OUT, `preflight-${name}.png`), fullPage: true });
  try {
    await socket.start();
    const hq = await startHqFree({ env });
    try {
      const page = await newPage();
      const press = (/** @type {string} */ selector) =>
        Promise.all([page.waitForResponse((res) => res.url().endsWith('/api/preflight')), page.click(selector)]);
      await page.goto(`${hq.url}/?lang=en#/preflight`);
      const up = await shown(page);
      const fixKind = (await hq.snapshot()).host.os;
      expect(up.checks.engine?.status === 'PASS', `docker up: engine is ${up.checks.engine?.status}`);
      expect(up.checks.image?.status === 'WARN', `the missing image is ${up.checks.image?.status}, not WARN`);
      expect(up.verdict === 'warned' && up.start, `a WARN blocked START: verdict ${up.verdict}, enabled ${up.start}`);
      await shot(page, 'docker-up');

      await socket.stop();
      await press('[data-testid="pf-rerun"]');
      const down = await shown(page);
      expect(down.checks.engine?.status === 'FAIL', `docker stopped: engine is ${down.checks.engine?.status}`);
      expect(
        down.checks.engine?.fix === FIXES.engineDown(fixKind),
        `docker stopped: the fix reads ${down.checks.engine?.fix}`,
      );
      expect(down.checks.image?.status === 'SKIP', `docker stopped: image is ${down.checks.image?.status}`);
      expect(down.verdict === 'blocked' && !down.start, `a FAIL did not block START: enabled ${down.start}`);
      expect((await hq.snapshot()).host.engines?.[0]?.running === false, 'the snapshot still says docker runs');
      await shot(page, 'docker-stopped');

      await socket.start();
      await press('[data-check="engine"] button');
      const back = await shown(page);
      expect(back.checks.engine?.status === 'PASS' && back.start, 'Check again did not see docker come back');

      await socket.stop();
      await press('[data-testid="pf-start"]');
      const late = await shown(page);
      expect(
        page.url().endsWith('#/preflight') && !late.start && late.checks.engine?.status === 'FAIL',
        `START on an old report left for the floor after docker stopped: ${page.url()}`,
      );

      await socket.start();
      await press('[data-testid="pf-rerun"]');
      await shown(page);
      await press('[data-testid="pf-start"]');
      const left = await page
        .waitForSelector('[data-testid="mode-chip"]', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      expect(left, 'START did not open the floor with only a WARN');
      await shot(page, 'floor-chip');

      await page.goto(`${hq.url}/?lang=th#/preflight`);
      await socket.stop();
      await press('[data-testid="pf-rerun"]');
      await shown(page);
      await shot(page, 'docker-stopped-th');
      await page.context().close();
    } finally {
      await hq.stop();
    }

    for (const [fake, kind] of /** @type {const} */ ([
      ['windows', 'windows'],
      ['macos', 'macos'],
      ['linux', 'linux'],
    ])) {
      const other = await startHqFree({ env: { ...env, AGENT_WORKS_HOST: fake } });
      try {
        const page = await newPage();
        await page.goto(`${other.url}/?lang=en#/preflight`);
        const seen = await shown(page);
        expect(
          seen.checks.engine?.fix === FIXES.engineDown(kind),
          `${fake}: the stopped engine fix reads ${seen.checks.engine?.fix}`,
        );
        await shot(page, `docker-stopped-${fake}`);
        await page.context().close();
      } finally {
        await other.stop();
      }
    }
  } finally {
    await socket.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    ok: problems.length === 0,
    note:
      problems.length === 0
        ? `docker up: engine PASS, image WARN, START enabled. Socket closed: engine FAIL with this OS's fix, START disabled, and a START press on an older report stayed put. Socket back: Check again passed and START opened the floor. Fix text per OS on windows, macos, linux. Screenshots in ${OUT}`
        : problems.join('; '),
  };
};

if (import.meta.main) {
  const browser = await launch();
  try {
    const verdict = await runPreflightLane(browser).catch((error) => ({
      ok: false,
      note: String(error.message ?? error).split('\n')[0],
    }));
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} preflight lane: ${verdict.note}`);
    const compare = await comparePreflight(browser);
    console.log(`${compare.ok ? 'PASS' : 'FAIL'} preflight artboard compare: ${compare.note}`);
    process.exitCode = verdict.ok && compare.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
