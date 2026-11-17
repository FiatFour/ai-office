import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

export const ROOT = join(import.meta.dirname, '..', '..');
export const OUT = process.env.OUT ?? '/tmp/swarm-P1-3/owner';
mkdirSync(OUT, { recursive: true });

const BIN = join(ROOT, 'bin', 'agent-works.ts');

/**
 * @param {{ demo?: boolean, port: number, intervalMs?: number }} options
 */
export const startHq = async ({ demo = false, port, intervalMs = 1500 }) => {
  const home = mkdtempSync(join(tmpdir(), 'aw-e2e-'));
  const args = demo
    ? [BIN, '--demo', '--no-open', '--port', String(port)]
    : [BIN, 'serve', '--port', String(port), '--home', home];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, AGENT_WORKS_HOME: home, AGENT_WORKS_DEMO_INTERVAL_MS: String(intervalMs) },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('HQ did not start');
    await sleep(100);
  }
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 5000);
    });
    rmSync(home, { recursive: true, force: true });
  };
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

export const launch = () => chromium.launch();

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

/** @param {import('playwright').Page} page @param {string} label */
export const runAxe = async (page, label) => {
  await page.evaluate(readFileSync(AXE, 'utf8'));
  const out = await page.evaluate(() => globalThis.axe.run(document, { resultTypes: ['violations', 'incomplete'] }));
  const nodes = (/** @type {any[]} */ rules) =>
    rules.flatMap((rule) =>
      rule.nodes.map((node) => `${label} ${rule.id} (${rule.impact ?? 'n/a'}) ${node.target.join(' ')}`),
    );
  return { violations: nodes(out.violations), incomplete: nodes(out.incomplete) };
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
