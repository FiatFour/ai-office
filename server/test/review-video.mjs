import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin/agent-works.ts');
const out = process.argv[2] ?? '/tmp/swarm-P1-1/owner';
mkdirSync(out, { recursive: true });
const work = realpathSync(mkdtempSync(join(tmpdir(), 'aw-video-')));
const home = join(work, 'home');
const repo = join(work, 'demo-repo');
mkdirSync(repo);
const git = (/** @type {string[]} */ ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('commit', '-qm', 'init', '--allow-empty');
git('remote', 'add', 'origin', 'git@github.com:acme/demo-repo.git');
const port = 7460;

const page = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#101418"><pre id=t style="color:#d8dee9;font:15px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:18px;margin:0;white-space:pre-wrap"></pre><script>
const t=document.getElementById('t');const s=new WebSocket('ws://'+location.host);s.onmessage=e=>{t.textContent+=JSON.parse(e.data);scrollTo(0,document.body.scrollHeight)};</script>`;
const http = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
const wss = new WebSocketServer({ server: http });
await new Promise((r) => http.listen(0, '127.0.0.1', () => r(undefined)));
const say = (/** @type {string} */ text) => {
  for (const c of wss.clients) c.send(JSON.stringify(text));
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
const type = async (args, env = {}) => {
  const line = `$ agent-works ${args.join(' ')}\n`;
  for (const ch of line) {
    say(ch);
    await sleep(45);
  }
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args, '--home', home], {
      cwd: repo,
      env: { ...process.env, ...env },
    });
    child.stdout.on('data', (d) => say(String(d)));
    child.stderr.on('data', (d) => say(String(d)));
    child.on('close', (code) => {
      say(`[exit ${code}]\n\n`);
      resolve(undefined);
    });
  });
  await sleep(3200);
};

process.env.AGENT_WORKS_CAGE_IMAGE ??= 'aw-test-cage:1';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1000, height: 680 },
  recordVideo: { dir: join(work, 'video'), size: { width: 1000, height: 680 } },
});
const tab = await ctx.newPage();
await tab.goto(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (http.address()).port}`);
await sleep(600);
try {
  await type(['--no-open', '--port', String(port)]);
  await type(['ls']);
  await tab.screenshot({ path: join(out, 'review-start-ls.png') });
  await type(['doctor']);
  await type(['doctor'], { DOCKER_HOST: 'unix:///nonexistent-aw.sock', AGENT_WORKS_ENGINE: 'docker' });
  await tab.screenshot({ path: join(out, 'review-doctor-fail.png') });
  await type(['cage', 'start', '--task', 'acme/demo', '--worker', 'nova']);
  await type(['stop']);
  await tab.screenshot({ path: join(out, 'review-stop.png') });
} finally {
  await ctx.close();
  await browser.close();
  http.close();
}
const [webm] = readdirSync(join(work, 'video'));
renameSync(join(work, 'video', webm ?? ''), join(out, 'P1-1-review.webm'));
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-i',
  join(out, 'P1-1-review.webm'),
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-an',
  join(out, 'P1-1-review.mp4'),
]);
writeFileSync(
  join(out, 'review-video.txt'),
  'terminal page driven by real agent-works runs, recorded with Playwright and encoded with ffmpeg\n',
);
console.log('wrote', join(out, 'P1-1-review.mp4'));
