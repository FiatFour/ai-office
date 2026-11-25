import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notReadyLines, screenGates } from './gates.mjs';
import { ROOT, startHqFree } from './harness.mjs';

/**
 * Lane 11b: registers synthetic screens end to end, the way a screen ticket does, and proves the registry and the gates cope with them.
 * Each fixture is a folder `src/screens/zz-gate-<name>/` (and for one of them a locale file in each language), written for the run, built, and removed after.
 * A real screen ticket edits nothing outside its own folder and its two locale files, which is what the good fixtures do.
 */

const SCREENS = join(ROOT, 'src', 'screens');
const LOCALES = join(ROOT, 'src', 'locales');
const PREFIX = 'zz-gate-';

const screen = (/** @type {string} */ id, /** @type {string} */ body, /** @type {string} */ extra = '', head = '') =>
  `${head}\nexport const screen = { id: '${id}', ${extra} Component: () => (${body}) };\n`;

const GOOD = `import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const Late = () => {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setOn(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return (
    <main style={{ padding: 24, background: '#fff', color: '#15181c' }}>
      <h1>{t('zz-gate-good.title')}</h1>
      <p style={{ backgroundImage: 'linear-gradient(#ffffff, #eeeeee)', color: '#222222' }}>text on a light gradient</p>
      <p className="fx-clip" style={{ backgroundImage: 'linear-gradient(#000, #000)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>clipped text</p>
      {on ? <span data-fixture-ready>late</span> : null}
    </main>
  );
};

export const screen = {
  id: 'zz-gate-good',
  ready: '[data-fixture-ready]',
  contrastAllow: [{ selector: '.fx-clip', reason: 'the text is its own gradient, it cannot be sampled' }],
  Component: Late,
};
`;

const main = (/** @type {string} */ text) =>
  `<main style={{ padding: 24, background: '#fff', color: '#15181c' }}><h1>${text}</h1></main>`;

/** @type {Record<string, string>} */
const FIXTURES = {
  good: GOOD,
  plain: screen('zz-gate-plain', main('plain')),
  never: screen('zz-gate-never', main('never'), "ready: '#never-appears',"),
  badid: screen('zz-gate-bad', main('badid')),
  throws: "throw new Error('boom at load');\nexport const screen = { id: 'zz-gate-throws', Component: () => null };\n",
  render: screen('zz-gate-render', "(() => { throw new Error('boom at render'); })()"),
  noreason: screen(
    'zz-gate-noreason',
    `<main style={{ padding: 24, background: '#fff' }}><p className="fx-clip" style={{ backgroundImage: 'linear-gradient(#000, #000)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>clipped text</p></main>`,
    "contrastAllow: [{ selector: '.fx-clip', reason: ' ' }],",
  ),
  clipped: screen(
    'zz-gate-clipped',
    `<main style={{ padding: 24, background: '#fff' }}><p style={{ backgroundImage: 'linear-gradient(#000, #000)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>clipped text</p></main>`,
  ),
};

const fixtureFolders = () => (existsDir(SCREENS) ? readdirSync(SCREENS).filter((name) => name.startsWith(PREFIX)) : []);
const existsDir = (/** @type {string} */ dir) => {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
};

const remove = () => {
  for (const name of fixtureFolders()) rmSync(join(SCREENS, name), { recursive: true, force: true });
  for (const lang of ['en', 'th']) rmSync(join(LOCALES, lang, `${PREFIX}good.json`), { force: true });
};

const build = () => {
  const out = spawnSync('pnpm', ['--filter', '@agent-works/floor', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (out.status !== 0) throw new Error(`floor build failed: ${out.stdout}${out.stderr}`.slice(0, 600));
};

/** @param {import('playwright').Browser} browser */
export const runFixtureLane = async (browser) => {
  /** @type {string[]} */
  const problems = [];
  const expect = (/** @type {boolean} */ holds, /** @type {string} */ what) => {
    if (!holds) problems.push(what);
  };
  remove();
  try {
    for (const [name, source] of Object.entries(FIXTURES)) {
      mkdirSync(join(SCREENS, `${PREFIX}${name}`), { recursive: true });
      writeFileSync(join(SCREENS, `${PREFIX}${name}`, 'screen.tsx'), source);
    }
    writeFileSync(join(LOCALES, 'en', `${PREFIX}good.json`), '{ "title": "Fixture screen" }\n');
    writeFileSync(join(LOCALES, 'th', `${PREFIX}good.json`), '{ "title": "หน้าทดสอบ" }\n');
    build();
    const hq = await startHqFree();
    try {
      const run = (/** @type {string} */ name) =>
        screenGates({ browser, url: hq.url, screen: `${PREFIX}${name}`, readyMs: 4000 });
      const floor = await browser.newPage();
      await floor.goto(`${hq.url}/?lang=en`);
      const floorUp = await floor
        .waitForSelector('[data-testid=rev]', { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      expect(floorUp, 'the floor did not draw while broken screens were registered');
      await floor.close();

      const good = await run('good');
      expect(good.ok, `a screen with its own ready selector fails: ${good.problems.join('; ')}`);
      expect(
        good.notes.some((note) => note.includes('the text is its own gradient')),
        'the allowlist reason is not in the notes',
      );
      const plain = await run('plain');
      expect(plain.ok, `a screen with no ready field fails on the default ready root: ${plain.problems.join('; ')}`);

      const never = await run('never');
      expect(never.notReady === 'not ready', `a screen that never becomes ready: ${never.notReady}`);
      expect(
        notReadyLines([{ screen: `${PREFIX}never`, notReady: never.notReady }])[0] ===
          `FAIL lane 11 ${PREFIX}never: not ready`,
        'the not ready line is not named',
      );

      /** @type {Array<[string, string]>} */
      const causes = [
        ['badid', 'screen zz-gate-bad: exports id zz-gate-bad, expected zz-gate-badid'],
        ['throws', 'screen zz-gate-throws: failed to load: boom at load'],
        ['render', 'screen zz-gate-render: failed to render: boom at render'],
      ];
      for (const [name, cause] of causes) {
        const found = await run(name);
        expect(found.notReady === cause, `${name}: expected "${cause}", got "${found.notReady}"`);
        expect(
          found.console.some((line) => line.includes(cause)),
          `${name}: the cause is not in the console errors`,
        );
      }

      const noReason = await run('noreason');
      expect(
        noReason.problems.some((problem) => problem.includes('not measurable')),
        `an allowlist entry with no reason excused text: ${noReason.problems.join('; ')}`,
      );

      const clipped = await run('clipped');
      expect(
        clipped.problems.some((problem) => problem.includes('not measurable')),
        `text it cannot measure and nobody allowlisted did not fail: ${clipped.problems.join('; ')}`,
      );
    } finally {
      await hq.stop();
    }
  } finally {
    remove();
    build();
  }
  return {
    ok: problems.length === 0,
    note:
      problems.length === 0
        ? `${Object.keys(FIXTURES).length} synthetic screens registered end to end: own and default ready, never ready named, wrong id, throwing module and throwing render each named in the page and the console while the floor kept drawing, unmeasurable text failed unless allowlisted`
        : problems.join('; '),
  };
};
