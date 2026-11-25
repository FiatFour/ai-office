import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

export const ROOT = join(import.meta.dirname, '..', '..');
export const OUT = process.env.OUT ?? '/tmp/swarm-P1-3/owner';
mkdirSync(OUT, { recursive: true });

const BIN = join(ROOT, 'bin', 'agent-works.ts');

/** Synthetic screens (lane 11b) live in `src/screens/zz-gate-*`. Nothing but that lane may see them: the registry listing and the parity test skip them unless this flag is set. */
export const FIXTURE_PREFIX = 'zz-gate-';
export const FIXTURE_FLAG = 'AW_GATE_FIXTURES';
/** The files among `files` (repo-relative paths) that belong to a synthetic screen. A tracked one would build into the app. */
export const syntheticFiles = (/** @type {string[]} */ files) => files.filter((file) => file.includes(FIXTURE_PREFIX));

/** Every HQ this process started and has not stopped, from the moment it is spawned (not when it answers), so an interrupted run can stop them. */
const live = new Set(/** @type {Array<() => Promise<void>>} */ ([]));
/** Every child still running, so a process that exits without cleaning up does not leave an HQ behind. */
const children = new Set(/** @type {Set<import('node:child_process').ChildProcess>} */ (new Set()));
let halted = false;
/** Temp homes of HQs not yet stopped, removed on exit so a process.exit does not leave `aw-e2e-*` folders behind. */
const homes = new Set(/** @type {Set<string>} */ (new Set()));
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
  for (const home of homes) {
    // Windows holds the files of a child that is still dying, so retry; a home that stays must not change the exit code.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  }
});
/** Stops every HQ, including one that is still starting, and refuses to start another. */
export const haltHq = () => {
  halted = true;
  return Promise.all([...live].map((stop) => stop())).then(() => undefined);
};
export const stopAllHq = haltHq;

/**
 * One shared way for a script to handle SIGINT and SIGTERM. The first signal runs `cleanup` (bounded by `limitMs`), then exits with `code`.
 * A second signal exits at once, so a cleanup that hangs cannot trap the operator.
 * @param {{ cleanup: () => Promise<void>, exit: (code: number) => void, limitMs?: number }} options
 */
export const interruptible = ({ cleanup, exit, limitMs = 15_000 }) => {
  let stopping = false;
  return {
    get stopping() {
      return stopping;
    },
    on: (/** @type {number} */ code) => () => {
      if (stopping) {
        exit(code);
        return;
      }
      stopping = true;
      const limit = new Promise((resolve) => setTimeout(resolve, limitMs).unref());
      Promise.race([cleanup().catch(() => {}), limit]).finally(() => exit(code));
    },
  };
};

/**
 * What an interrupted gates run does, in order: stop the HQs, close the browser (bounded), then `restore` the tree, also when a step failed.
 * @param {{ browser: { close: () => Promise<unknown> }, restore: () => void, stopHqs?: () => Promise<unknown> }} options
 */
export const interruptedCleanup =
  ({ browser, restore, stopHqs = stopAllHq }) =>
  async () => {
    try {
      await stopHqs();
      await within(
        browser.close().catch(() => {}),
        10_000,
      );
    } finally {
      restore();
    }
  };

/** @template T @param {Promise<T>} work @param {number} ms @returns {Promise<T | undefined>} undefined when it took longer */
export const within = (work, ms) =>
  Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms, undefined).unref())]);

/**
 * @param {{ demo?: boolean, port: number, intervalMs?: number, args?: string[] }} options `args` go to `serve` after the port and home, for example a mode and its config
 */
export const startHq = async ({ demo = false, port, intervalMs = 1500, args: extra = [] }) => {
  if (halted) throw new Error('HQ start refused: the run is stopping');
  const home = mkdtempSync(join(tmpdir(), 'aw-e2e-'));
  homes.add(home);
  const args = demo
    ? [BIN, '--demo', '--no-open', '--port', String(port)]
    : [BIN, 'serve', '--port', String(port), '--home', home, ...extra];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, AGENT_WORKS_HOME: home, AGENT_WORKS_DEMO_INTERVAL_MS: String(intervalMs) },
    stdio: 'ignore',
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const stop = async () => {
    live.delete(stop);
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
      child.once('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
    homes.delete(home);
  };
  live.add(stop);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const abandon = (/** @type {string} */ why) => {
    live.delete(stop);
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
    homes.delete(home);
    return new Error(why);
  };
  for (;;) {
    if (gone()) throw abandon(`HQ exited on port ${port}`);
    try {
      if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {}
    if (Date.now() > deadline) throw abandon('HQ did not start');
    await sleep(100);
  }
  return {
    url,
    stop,
    snapshot: async () => (await fetch(`${url}/api/snapshot`)).json(),
    events: async () => (await (await fetch(`${url}/api/events?after=0`)).json()).events,
    post: async (/** @type {unknown} */ event) => {
      const res = await fetch(`${url}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (!res.ok) throw new Error(`POST /api/events ${res.status} ${await res.text()}`);
    },
  };
};

/** A port the OS says is free right now: bind port 0 and read it back. */
export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });

/**
 * Another process can take the port between `freePort` and the bind, so a failed start gets a new port.
 * @template T @param {(port: number) => Promise<T>} start @param {number} [tries] @param {() => Promise<number>} [pick]
 */
export const withFreePort = async (start, tries = 5, pick = /** @type {() => Promise<number>} */ (freePort)) => {
  /** @type {unknown} */
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await start(await pick());
    } catch (error) {
      last = error;
    }
  }
  throw last;
};

/** @param {Omit<Parameters<typeof startHq>[0], 'port'>} [options] */
export const startHqFree = (options = {}) => withFreePort((port) => startHq({ ...options, port }));

/** @param {import('playwright').LaunchOptions} [options] */
export const launch = (options = {}) => chromium.launch(options);

export const REPO = 'acme/app';
export const human = (/** @type {string} */ kind, /** @type {object} */ rest) => ({ source: 'human', kind, ...rest });
export const sha = (/** @type {string} */ seed) => seed.repeat(40).slice(0, 40);

/** @param {string} task @param {number} number @param {string} author @param {string} head @param {'open'|'merged'} state @param {number} at */
export const change = (task, number, author, head, state, at) => ({
  source: 'webhook',
  kind: 'change',
  repo: REPO,
  headRepo: REPO,
  number,
  branch: `aw/${task}`,
  author,
  state,
  headSha: head,
  at,
});
export const green = (/** @type {string} */ head, /** @type {number} */ at) => ({
  source: 'webhook',
  kind: 'check',
  repo: REPO,
  headSha: head,
  name: 'ci',
  state: 'success',
  at,
});
export const review = (
  /** @type {number} */ number,
  /** @type {string} */ reviewer,
  /** @type {string} */ verdict,
  /** @type {string} */ head,
  /** @type {number} */ at,
) => ({
  source: 'webhook',
  kind: 'review',
  repo: REPO,
  number,
  reviewer,
  verdict,
  headSha: head,
  at,
});

export const moods = (/** @type {import('playwright').Page} */ page) =>
  page.$$eval('[data-worker]', (nodes) =>
    Object.fromEntries(nodes.map((node) => [node.getAttribute('data-worker'), node.getAttribute('data-mood')])),
  );

export const AXE = join(ROOT, 'src', 'node_modules', 'axe-core', 'axe.min.js');

export const NEEDS_CHIP = { fg: '#f5f3ec', bg: '#ef5350', ratio: 3.14 };

/**
 * The one named exception to the 4.5 to 1 contrast gate: the canvas "Needs you" chip
 * (cream on #ef5350, 3.14 to 1). It matches only a color-contrast node that is a
 * chip with data-mood="needs", with exactly those colours and that ratio.
 * @param {string} rule @param {any} node
 */
export const isNeedsChip = (rule, node) => {
  const data = node.any?.[0]?.data;
  return (
    rule === 'color-contrast' &&
    /class="chip"/.test(node.html) &&
    /data-mood="needs"/.test(node.html) &&
    data?.fgColor === NEEDS_CHIP.fg &&
    data?.bgColor === NEEDS_CHIP.bg &&
    Math.abs(data?.contrastRatio - NEEDS_CHIP.ratio) < 0.01
  );
};

/** @param {import('playwright').Page} page @param {string} label */
export const runAxe = async (page, label) => {
  await page.evaluate(readFileSync(AXE, 'utf8'));
  const out = await page.evaluate(() => globalThis.axe.run(document, { resultTypes: ['violations', 'incomplete'] }));
  const line = (/** @type {any} */ rule, /** @type {any} */ node) =>
    `${label} ${rule.id} (${rule.impact ?? 'n/a'}) ${node.target.join(' ')}`;
  const nodes = (/** @type {any[]} */ rules, /** @type {(rule: string, node: any) => boolean} */ keep) =>
    rules.flatMap((rule) => rule.nodes.filter((node) => keep(rule.id, node)).map((node) => line(rule, node)));
  return {
    violations: nodes(out.violations, (rule, node) => !isNeedsChip(rule, node)),
    exceptions: nodes(out.violations, isNeedsChip),
    incomplete: nodes(out.incomplete, () => true),
    blocking: nodes(
      out.violations.filter((/** @type {any} */ rule) => rule.impact === 'serious' || rule.impact === 'critical'),
      (rule, node) => !isNeedsChip(rule, node),
    ),
  };
};

const luminance = (/** @type {number[]} */ [r, g, b]) => {
  const f = (/** @type {number} */ v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrastRatio = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

/**
 * @param {import('playwright').Page} page
 */
export const sceneLabelContrast = async (page) => {
  const rows = await page.evaluate(() => {
    const svg = document.querySelector('.scene svg');
    if (svg === null) return [];
    const hex = (/** @type {string} */ value) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const rgb = getComputedStyle(probe)
        .color.match(/[\d.]+/g)
        ?.map(Number) ?? [0, 0, 0];
      probe.remove();
      return rgb.slice(0, 3);
    };
    const fillOf = (/** @type {Element} */ rect) => {
      const raw = rect.getAttribute('fill') ?? '';
      const ref = /url\(#(\w+)\)/.exec(raw);
      if (ref === null) return raw;
      return svg.querySelector(`#${ref[1]} rect`)?.getAttribute('fill') ?? '';
    };
    const all = [...svg.querySelectorAll('rect, text')];
    const out = [];
    for (const [index, node] of all.entries()) {
      if (node.tagName !== 'text' || !node.textContent?.trim()) continue;
      const box = node.getBoundingClientRect();
      const [cx, cy] = [box.left + box.width / 2, box.top + box.height / 2];
      const under = all
        .slice(0, index)
        .reverse()
        .find((other) => {
          if (
            other.tagName !== 'rect' ||
            Number(other.getAttribute('opacity') ?? 1) < 0.8 ||
            other.getAttribute('fill') === 'url(#mesh)'
          )
            return false;
          const r = other.getBoundingClientRect();
          return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom && r.width > 3 && r.height > 3;
        });
      if (under === undefined) continue;
      out.push({
        text: node.textContent.trim(),
        fg: hex(node.getAttribute('fill') ?? '#000'),
        bg: hex(fillOf(under)),
        size: Number(node.getAttribute('font-size')),
      });
    }
    return out;
  });
  return rows.map((row) => ({ ...row, ratio: Number(contrastRatio(row.fg, row.bg).toFixed(2)) }));
};
