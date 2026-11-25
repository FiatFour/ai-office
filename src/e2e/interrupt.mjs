import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT } from './harness.mjs';

/**
 * Interrupts `node src/e2e/gates.mjs` while lane 11b has its synthetic screens in the tree, and checks what it leaves.
 * 1. SIGINT: the tree has no `src/screens/zz-gate-*` or `zz-gate-*.json`, `src/dist` was rebuilt without them, no HQ of that run is alive, and the unit tests that read the tree pass.
 * 2. SIGKILL (nothing can clean up): the next run does not fail on the leftovers, the unit tests still pass, and the next run puts the tree right.
 * Run: `node src/e2e/interrupt.mjs`. It prints one PASS or FAIL line per check and exits non-zero on a FAIL.
 */

const SCREENS = join(ROOT, 'src', 'screens');
const LOCALES = join(ROOT, 'src', 'locales');
const DIST = join(ROOT, 'src', 'dist');

const leftovers = () => [
  ...(existsSync(SCREENS) ? readdirSync(SCREENS).filter((name) => name.startsWith('zz-gate-')) : []),
  ...['en', 'th'].flatMap((lang) =>
    readdirSync(join(LOCALES, lang))
      .filter((name) => name.startsWith('zz-gate-'))
      .map((name) => `${lang}/${name}`),
  ),
];

const distHasFixtures = () => {
  const walk = (/** @type {string} */ dir) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
        )
      : [];
  return walk(DIST).some((file) => readFileSync(file).includes('zz-gate-good'));
};

const alive = (/** @type {string} */ marker) => spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;

const units = () =>
  spawnSync('pnpm', ['vitest', 'run', 'src/test/screens.test.ts', 'src/test/i18n-parity.test.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

/** Starts a gates run and sends `signal` once lane 11b has built its synthetic screens into `src/dist`. */
const interrupt = async (/** @type {NodeJS.Signals} */ signal, /** @type {string} */ tmp) => {
  const child = spawn(process.execPath, ['src/e2e/gates.mjs'], {
    cwd: ROOT,
    env: { ...process.env, TMPDIR: tmp },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
  const deadline = Date.now() + 240_000;
  while (!distHasFixtures()) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('lane 11b never built its screens');
    await sleep(200);
  }
  await sleep(1500);
  child.kill(signal);
  return /** @type {Promise<{ code: number | null, sig: string | null }>} */ (exited);
};

const fails = /** @type {string[]} */ ([]);
const check = (/** @type {boolean} */ holds, /** @type {string} */ what) => {
  console.log(`${holds ? 'PASS' : 'FAIL'} interrupt: ${what}`);
  if (!holds) fails.push(what);
};

const base = process.env.TMPDIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(join(base, 'aw-interrupt-'));
try {
  const gone = await interrupt('SIGINT', tmp);
  check(gone.code === 130, `SIGINT ends the run with 130 (got ${gone.code} ${gone.sig})`);
  check(leftovers().length === 0, `SIGINT leaves no synthetic file (${leftovers().join(', ')})`);
  check(!distHasFixtures(), 'SIGINT leaves src/dist built without the synthetic screens');
  await sleep(500);
  check(!alive(tmp), 'SIGINT leaves no HQ of the run alive');
  check(units().status === 0, 'screens and parity tests pass after SIGINT');

  await interrupt('SIGKILL', tmp);
  check(leftovers().length > 0, 'SIGKILL leaves synthetic files (the case the next run must survive)');
  check(units().status === 0, 'screens and parity tests pass with synthetic files left in the tree');
  spawnSync('pkill', ['-f', tmp]);
  const next = spawnSync(process.execPath, ['src/e2e/gates.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  });
  check(next.status === 0, `the next run passes after SIGKILL: ${(next.stdout.match(/FAIL[^\n]*/) ?? [''])[0]}`);
  check(!/FAIL lane 11/.test(next.stdout), 'the next run prints no FAIL lane 11 line');
  check(leftovers().length === 0 && !distHasFixtures(), 'the next run leaves the tree clean');
} finally {
  spawnSync('pkill', ['-f', tmp]);
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(fails.length === 0 ? 0 : 1);
