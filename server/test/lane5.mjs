import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin/agent-works.ts');
const out = process.argv[2] ?? '/tmp/swarm-P1-1/owner';
mkdirSync(out, { recursive: true });
const work = realpathSync(mkdtempSync(join(tmpdir(), 'aw-lane5-')));
const home = join(work, 'home');
const port = 7455;
/** @param {string[]} args */
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args, '--home', home], { cwd: work, encoding: 'utf8' });

const started = cli('--no-open', '--port', String(port));
const url = `http://127.0.0.1:${port}`;
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  /** @type {number[]} */
  const frames = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => frames.push(JSON.parse(String(frame.payload)).rev));
  });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('conn')?.textContent === 'live');
  /** @type {number[]} */
  const shown = [Number(await page.textContent('[data-testid=rev]'))];
  for (const name of ['one', 'two', 'three']) {
    const root = join(work, name);
    mkdirSync(root);
    const before = shown.at(-1) ?? 0;
    await fetch(`${url}/api/factories`, { method: 'POST', body: JSON.stringify({ root }) });
    await page.waitForFunction((n) => Number(document.querySelector('[data-testid=rev]')?.textContent) > n, before);
    shown.push(Number(await page.textContent('[data-testid=rev]')));
  }
  await page.screenshot({ path: join(out, 'snapshot-rev.png') });
  const rising = shown.every((rev, i) => i === 0 || rev > (shown[i - 1] ?? 0));
  const text = `${started.stdout}${started.stderr}revision shown on the page after each registry change: ${shown.join(' -> ')}\nWebSocket frames received (rev): ${frames.join(', ')}\n${rising ? 'PASS' : 'FAIL'} lane 5: the revision goes up after each registry change\n`;
  writeFileSync(join(out, 'snapshot-rev.txt'), text);
  console.log(text);
  process.exitCode = rising ? 0 : 1;
} finally {
  await browser?.close();
  cli('stop');
}
