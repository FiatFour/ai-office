import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { human, launch, OUT, ROOT, startHqFree } from './harness.mjs';

/**
 * Ten distinct denials pause a worker, on a real HQ, a real cage and the real proxy.
 * The cage claims another worker's name on every request. The hosts are unlisted, so the proxy refuses them without a lookup and nothing leaves this computer.
 */

const IMAGE = 'aw-test-cage:1';
const CONTEXT = join(ROOT, 'server', 'test', 'sandbox');
const run = promisify(execFile);

const ensureImage = () => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
  } catch {
    execFileSync('docker', ['build', '-t', IMAGE, '-f', join(CONTEXT, 'Containerfile.test'), CONTEXT], {
      stdio: 'inherit',
    });
  }
};

/** @param {string} dir */
const fixture = (dir) => {
  const source = join(dir, 'source');
  mkdirSync(source);
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(source, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
  const config = join(dir, 'cages-config.json');
  writeFileSync(
    config,
    JSON.stringify({
      host: 'github',
      repo: 'acme/app',
      base: 'main',
      source,
      author: 'nova',
      reviewer: 'vega',
      tickets: { 'alpha/t1': { kind: 'chore', title: 't', body: 'b' } },
      pollMs: 3_600_000,
      firewall: { policy: 'locked', workers: { nova: ['own.invalid'] } },
    }),
  );
  return { source, config };
};

/** One CONNECT from inside the cage to the proxy, under the claimed name. @param {string} container @param {string} host */
const connectFrom = async (container, host) => {
  const script = `const u=new URL(process.env.HTTPS_PROXY);const r=require('http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'${host}:443',headers:{'Proxy-Authorization':'Basic '+Buffer.from('vega:x').toString('base64')},timeout:8000});r.on('connect',s=>{console.log(s.statusCode);process.exit(0)});r.on('error',e=>{console.log(e.code);process.exit(0)});r.end()`;
  return (await run('docker', ['exec', container, 'node', '-e', script])).stdout.trim();
};

/** @param {string} url @param {string} path @param {unknown} body */
const post = async (url, path, body) => {
  const res = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`POST ${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
};

/** @param {import('playwright').Browser} browser */
export const runFirewallLane = async (browser) => {
  /** @type {string[]} */
  const problems = [];
  const expect = (/** @type {boolean} */ holds, /** @type {string} */ what) => {
    if (!holds) problems.push(what);
  };
  ensureImage();
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'aw-fw-'));
  const { source, config } = fixture(dir);
  const hq = await startHqFree({
    args: ['--mode', 'cages', '--config', config],
    env: { AGENT_WORKS_CAGE_IMAGE: IMAGE, AGENT_WORKS_ENGINE: 'docker', AGENT_WORKS_PROJECT: 'agent-works-e2e-fw' },
  });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${hq.url}/?lang=en`);
    const counter = page.locator('[data-testid="firewall-count"]');
    const reads = async (/** @type {string} */ text) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await counter.textContent().catch(() => null)) === text) return;
        await page.waitForTimeout(100);
      }
      problems.push(`the FIREWALL counter reads "${await counter.textContent().catch(() => null)}", not "${text}"`);
    };
    await hq.post(human('add_worker', { worker: 'nova' }));
    await reads('0 BLOCKED · 2 ALLOWED');
    const { container } = await post(hq.url, '/api/cages', { task: 'alpha/t1', worker: 'nova', source });

    expect((await connectFrom(container, 'own.invalid')) === '502', "nova's own rule did not let its cage through");
    for (let n = 1; n <= 9; n += 1)
      expect((await connectFrom(container, `h${n}.example`)) === '403', `h${n}.example was not refused`);
    await reads('9 BLOCKED · 2 ALLOWED');
    const nine = await hq.snapshot();
    expect(nine.paused.length === 0, `paused after 9 distinct denials: ${nine.paused}`);
    await connectFrom(container, 'h10.example');
    await reads('10 BLOCKED · 2 ALLOWED');
    const ten = await hq.snapshot();
    expect(ten.paused.join() === 'nova', `paused after 10 distinct denials: "${ten.paused}"`);
    expect(
      ten.blocked.length === 10 && ten.blocked.every((/** @type {any} */ b) => b.worker === 'nova'),
      `the denials are not all nova's: ${ten.blocked.map((/** @type {any} */ b) => b.worker)}`,
    );
    await page.screenshot({ path: join(OUT, 'firewall-floor.png') });
    const listed = await page.context().newPage();
    await listed.goto(`${hq.url}/blocked`);
    expect((await listed.textContent('.paused')) === 'Paused: nova', '/blocked does not say that nova is paused');
    await listed.screenshot({ path: join(OUT, 'firewall-blocked.png') });

    await post(hq.url, '/api/actions/allow', { host: 'h1.example' });
    await reads('9 BLOCKED · 3 ALLOWED');
    expect((await hq.snapshot()).paused.join() === 'nova', 'Allow resumed the worker');
    await post(hq.url, '/api/workers/resume', { worker: 'nova' });
    expect((await hq.snapshot()).paused.length === 0, 'resume did not clear the pause');
  } finally {
    await hq.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    ok: problems.length === 0,
    note:
      problems.length === 0
        ? `nine distinct denials left nova running, the tenth paused it, all ten under its own name although the cage claimed vega; its own rule passed; the floor counter followed; Allow did not resume. Screenshots in ${OUT}`
        : problems.join('; '),
  };
};

if (import.meta.main) {
  const browser = await launch();
  try {
    const verdict = await runFirewallLane(browser).catch((error) => ({
      ok: false,
      note: String(error.message ?? error).split('\n')[0],
    }));
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} firewall lane: ${verdict.note}`);
    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
