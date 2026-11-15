/// <reference lib="dom" />
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { ENGINES } from './term-server.mjs';

/**
 * @typedef {import('playwright').Page} Page
 * @typedef {{ pass: boolean, detail: string }} LaneResult
 * @typedef {{ page: Page, url: string, out: string, label: string, engineFile: string, cage: string, shot: (page: Page, slug: string) => Promise<string> }} LaneContext
 * @typedef {{ slug: string, run: (ctx: LaneContext) => Promise<LaneResult> }} Lane
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tag = () => Math.random().toString(36).slice(2, 8);

/** @param {Page} page */
const screenLines = (page) =>
  page.evaluate(() => {
    const buffer = /** @type {any} */ (window).aw.term.buffer.active;
    const lines = [];
    for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    return lines;
  });

/**
 * @param {Page} page
 * @param {(line: string) => boolean} match
 */
async function waitForLine(page, match, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await screenLines(page)).find((line) => match(line.trimEnd()));
    if (hit !== undefined) return hit.trimEnd();
    await page.waitForTimeout(100);
  }
  return undefined;
}

/** @param {Page} page @param {string} state */
const waitForState = (page, state, timeout = 15_000) =>
  page.waitForFunction((s) => /** @type {any} */ (window).aw?.state() === s, state, { timeout });

/** @param {Page} page @param {string} text */
async function typeLine(page, text) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** @param {Page} page @param {string} url */
async function openTerminal(page, url) {
  await page.goto(url);
  await waitForState(page, 'open');
  await page.waitForTimeout(300);
  await page.locator('.xterm').click();
  await typeLine(page, 'clear');
  await page.waitForTimeout(300);
}

/** @param {Page} page @param {string} cmd */
async function runAndRead(page, cmd, marker = `m${tag()}`) {
  await typeLine(page, `${cmd} | sed 's/^/${marker}:/'`);
  const line = await waitForLine(page, (l) => l.startsWith(`${marker}:`));
  return line?.slice(marker.length + 1);
}

/** @param {number[]} samples */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (/** @type {number} */ q) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
  return { n: samples.length, min: at(0), p50: at(0.5), p95: at(0.95), max: at(1) };
}

/** @type {Lane[]} */
const LANES = [
  {
    slug: 'echo',
    async run({ page, label, shot }) {
      await typeLine(page, 'echo hi');
      const hit = await waitForLine(page, (l) => l === 'hi');
      return {
        pass: hit !== undefined,
        detail: `"hi" line ${hit === undefined ? 'missing' : 'shown'}; ${await shot(page, `${label}-echo`)}`,
      };
    },
  },
  {
    slug: 'mount',
    async run({ page }) {
      const listing = await runAndRead(page, 'ls /work/Containerfile');
      return {
        pass: listing === '/work/Containerfile',
        detail: `bind mount shows ${listing ?? 'nothing'} in the cage`,
      };
    },
  },
  {
    slug: 'resize',
    async run({ page, shot }) {
      const before = await runAndRead(page, 'tput cols');
      const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
      await page.setViewportSize({ width: Math.round(viewport.width * 0.6), height: viewport.height });
      await page.waitForTimeout(800);
      const browserCols = await page.evaluate(() => /** @type {any} */ (window).aw.term.cols);
      await typeLine(page, 'clear');
      const after = await runAndRead(page, 'tput cols');
      const file = await shot(page, 'resize');
      await page.setViewportSize(viewport);
      await page.waitForTimeout(500);
      const pass = Number(after) === browserCols && Number(after) !== Number(before);
      return { pass, detail: `tput cols ${before} -> ${after}, xterm cols ${browserCols}; ${file}` };
    },
  },
  {
    slug: 'reconnect',
    async run({ page, shot }) {
      const marker = `scroll-${tag()}`;
      await typeLine(page, `echo ${marker}`);
      await waitForLine(page, (l) => l === marker);
      const pidBefore = await runAndRead(page, 'echo $$');
      await page.evaluate(() => /** @type {any} */ (window).aw.drop());
      await waitForState(page, 'reconnecting', 5_000);
      await waitForState(page, 'open');
      await page.waitForTimeout(500);
      const pidAfter = await runAndRead(page, 'echo $$');
      const tmuxHistory = await runAndRead(page, `tmux capture-pane -p -S - | grep -c '^${marker}$'`);
      const viewerHistory = (await screenLines(page)).some((l) => l.trimEnd() === marker);
      const file = await shot(page, 'reconnect');
      const pass = pidBefore !== undefined && pidBefore === pidAfter && Number(tmuxHistory) >= 1 && viewerHistory;
      return {
        pass,
        detail: `shell pid ${pidBefore} -> ${pidAfter}; tmux scrollback has marker ${tmuxHistory}x; viewer still shows marker ${viewerHistory}; ${file}`,
      };
    },
  },
  {
    slug: 'two-viewers',
    async run({ page, url, shot }) {
      const second = await page.context().newPage();
      await second.goto(url);
      await waitForState(second, 'open');
      const marker = `shared-${tag()}`;
      await page.bringToFront();
      await page.locator('.xterm').click();
      await typeLine(page, `echo ${marker}`);
      const [inFirst, inSecond] = await Promise.all([
        waitForLine(page, (l) => l === marker),
        waitForLine(second, (l) => l === marker),
      ]);
      const files = [await shot(page, 'two-viewers-typing-tab'), await shot(second, 'two-viewers')];
      await second.close();
      await page.waitForTimeout(300);
      return {
        pass: inFirst !== undefined && inSecond !== undefined,
        detail: `typing tab ${inFirst !== undefined}, second tab ${inSecond !== undefined}; ${files.join(', ')}`,
      };
    },
  },
  {
    slug: 'thai',
    async run({ page, shot }) {
      const thai = 'สวัสดีครับ ภาษาไทย';
      await typeLine(page, 'clear');
      await page.waitForTimeout(300);
      await typeLine(page, `printf '%s\\n' '${thai}'`);
      const hit = await waitForLine(page, (l) => l === thai);
      const width = await runAndRead(page, `printf '%s' '${thai}' | wc -m`);
      return {
        pass: hit !== undefined,
        detail: `output line ${hit === undefined ? 'missing or mangled' : 'matches'}; cage counts ${width} code points; ${await shot(page, 'thai')}`,
      };
    },
  },
  {
    slug: 'ctrl-c',
    async run({ page, shot }) {
      await typeLine(page, 'sleep 100');
      await page.waitForTimeout(1000);
      const started = Date.now();
      await page.keyboard.press('Control+C');
      const marker = `after-${tag()}`;
      await typeLine(page, `echo ${marker}`);
      const hit = await waitForLine(page, (l) => l === marker, 5_000);
      const elapsed = Date.now() - started;
      return {
        pass: hit !== undefined && elapsed < 5_000,
        detail: `prompt back in ${elapsed} ms; ${await shot(page, 'ctrl-c')}`,
      };
    },
  },
  {
    slug: 'perf',
    async run({ page, out, label }) {
      await typeLine(page, 'clear');
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const term = w.aw.term;
        const probe = {
          samples: /** @type {number[]} */ ([]),
          parsed: /** @type {number[]} */ ([]),
          t0: 0,
          target: -1,
          parsedTarget: -1,
        };
        const position = () =>
          (term.buffer.active.baseY + term.buffer.active.cursorY) * term.cols + term.buffer.active.cursorX;
        document.addEventListener(
          'keydown',
          () => {
            probe.t0 = performance.now();
            probe.target = position() + 1;
            probe.parsedTarget = probe.target;
          },
          true,
        );
        term.onWriteParsed(() => {
          if (probe.parsedTarget >= 0 && position() >= probe.parsedTarget) {
            probe.parsed.push(performance.now() - probe.t0);
            probe.parsedTarget = -1;
          }
        });
        term.onRender(() => {
          if (probe.target >= 0 && position() >= probe.target) {
            probe.samples.push(performance.now() - probe.t0);
            probe.target = -1;
          }
        });
        w.awProbe = probe;
      });
      const keys = 'abcdefghijklmnopqrstuvwxyz';
      for (let i = 0; i < 200; i++) {
        await page.keyboard.press(keys[i % keys.length] ?? 'a');
        await page.waitForFunction((n) => /** @type {any} */ (window).awProbe.samples.length >= n, i + 1, {
          timeout: 5_000,
        });
      }
      await page.keyboard.press('Control+U');
      const { samples, parsed } = /** @type {{ samples: number[], parsed: number[] }} */ (
        await page.evaluate(() => /** @type {any} */ (window).awProbe)
      );
      const rendered = summarize(samples);
      const arrived = summarize(parsed);
      writeFileSync(
        path.join(out, `perf-${label}.json`),
        JSON.stringify({ label, rendered, arrived, samples, parsed }, null, 2),
      );
      const budget = process.platform === 'win32' ? 100 : 50;
      const fmt = (/** @type {ReturnType<typeof summarize>} */ s) =>
        `n=${s.n} p50=${s.p50.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)} ms`;
      return {
        pass: rendered.n === 200 && rendered.p95 <= budget,
        detail: `key to render ${fmt(rendered)}; key to parsed echo ${fmt(arrived)}; budget p95<=${budget} ms`,
      };
    },
  },
  {
    slug: 'cage-stop',
    async run({ page, out, engineFile, cage, shot }) {
      spawnSync(engineFile, ['stop', '-t', '1', cage], { stdio: 'ignore' });
      await waitForState(page, 'closed', 20_000);
      await page.waitForTimeout(1000);
      const file = await shot(page, 'cage-stop');
      const listing =
        process.platform === 'win32'
          ? spawnSync(
              'pwsh',
              [
                '-NoProfile',
                '-Command',
                'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
              ],
              { encoding: 'utf8' },
            ).stdout
          : spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout;
      const orphans = listing.split(/\r?\n/).filter((l) => l.includes(`exec -it ${cage}`));
      writeFileSync(
        path.join(out, 'cage-stop.txt'),
        `${listing}\n\norphans matching "exec -it ${cage}":\n${orphans.join('\n')}\n`,
      );
      const status = await page.locator('#status').textContent();
      return {
        pass: orphans.length === 0,
        detail: `page status "${status}"; ${orphans.length} orphan exec processes; ${file}`,
      };
    },
  },
];

/** @param {string} engineFile @param {string[]} args */
function startServer(engineFile, args) {
  const server = spawn(process.execPath, [path.join(here, 'term-server.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let log = '';
    server.stdout.on('data', (chunk) => {
      log += chunk;
      process.stdout.write(chunk);
      const url = /listening (\S+)/.exec(log)?.[1];
      if (url) resolve({ server, url });
    });
    server.on('exit', (code) => reject(new Error(`term-server exited with ${code} before listening (${engineFile})`)));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string', default: 'docker' },
      port: { type: 'string', default: '7681' },
      cage: { type: 'string', default: 'aw-p0-5' },
      label: { type: 'string', default: process.platform },
      out: { type: 'string', default: path.join(process.cwd(), 'p0-5-lanes') },
      only: { type: 'string' },
      'mount-style': { type: 'string' },
    },
  });
  const engine = values.engine === 'podman' ? 'podman' : 'docker';
  const host = /** @type {'linux' | 'darwin' | 'win32'} */ (process.platform);
  const engineFile = ENGINES[engine][host];
  const out = path.resolve(values.out);
  mkdirSync(out, { recursive: true });
  const only = values.only?.split(',');
  const lanes = LANES.filter((lane) => !only || only.includes(lane.slug));

  const { server, url } = /** @type {{ server: import('node:child_process').ChildProcess, url: string }} */ (
    await startServer(engineFile, [
      ...['--engine', engine, '--port', values.port, '--cage', values.cage],
      ...(values['mount-style'] ? ['--mount-style', values['mount-style']] : []),
    ])
  );
  const browser = await chromium.launch();
  /** @type {string[]} */
  const report = [];
  let failed = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await openTerminal(page, url);
    const shot = async (/** @type {Page} */ p, /** @type {string} */ slug) => {
      const file = path.join(out, `${slug}.png`);
      await p.screenshot({ path: file });
      return file;
    };
    for (const lane of lanes) {
      const result = await lane
        .run({ page, url, out, label: values.label, engineFile, cage: values.cage, shot })
        .catch((/** @type {Error} */ error) => ({ pass: false, detail: `threw ${error.message}` }));
      if (!result.pass) failed++;
      const line = `${result.pass ? 'PASS' : 'FAIL'} ${values.label} ${lane.slug}: ${result.detail}`;
      report.push(line);
      console.log(line);
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    spawnSync(engineFile, ['rm', '-f', values.cage], { stdio: 'ignore' });
  }
  writeFileSync(path.join(out, `lanes-${values.label}.txt`), `${report.join('\n')}\n`);
  process.exitCode = failed ? 1 : 0;
}

await main();
