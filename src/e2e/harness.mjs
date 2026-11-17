import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
