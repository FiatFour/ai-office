import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { artboardSpec, canvasCompare } from './canvas-compare.mjs';
import { checkAxe, checkContrast, checkKeys, checkMotion } from './gates.mjs';
import { launch, OUT, ROOT } from './harness.mjs';
import { startFactory } from './prs.mjs';

/**
 * The merge brief page on a real HQ (server/test/fixtures/prs-hq.ts): no brief while changes are asked, a brief once
 * approved and green, opened from the ready action item, withdrawn when a late check turns red, and MERGED after a
 * person merges on the host. The page has no merge control: every link and checkbox is pressed and only GETs leave it.
 */

const TASK = 'alpha/t2';
const OTHER = 'alpha/t1';

export const BRIEF_SPEC = artboardSpec({
  name: 'MergeBrief',
  dir: join(ROOT, 'docs', 'review', 'P3-17'),
  minEntries: 8,
});

/** What the page shows, and every control on it. */
const shown = (/** @type {import('playwright').Page} */ page) =>
  page.evaluate(() => {
    const all = (/** @type {string} */ selector) => [...document.querySelectorAll(selector)];
    const text = (/** @type {Element | null} */ node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return {
      brief: document.querySelector('[data-brief]')?.getAttribute('data-brief') ?? null,
      why: document.querySelector('[data-why]')?.getAttribute('data-why') ?? null,
      banner: text(document.querySelector('.mb-banner > b')),
      stats: Object.fromEntries(
        all('[data-stat]').map((n) => [n.getAttribute('data-stat'), text(n.querySelector('b'))]),
      ),
      files: all('[data-file]').map((n) => n.getAttribute('data-file')),
      checks: all('[data-check]').map((n) => n.getAttribute('data-check')),
      evidence: Object.fromEntries(
        all('[data-evidence]').map((n) => [n.getAttribute('data-evidence'), n.getAttribute('data-state')]),
      ),
      // "not collected" alone, with no reason after it.
      unexplained: all('.mb-missing').filter((n) => text(n) === text(n.querySelector('b'))).length,
      timeline: all('.mb-timeline li').map((n) => n.getAttribute('data-verdict')),
      open: text(document.querySelector('[data-testid="mb-open"]')) || null,
      links: all('a[href]').map((n) => n.getAttribute('href') ?? ''),
      buttons: all('button, [role="button"], [onclick]').map(text),
      forms: all('form, select, textarea, input:not([type="checkbox"])').length,
      boxes: all('input[type="checkbox"]').length,
    };
  });

/**
 * Every control is a checkbox that stays in the page or a link to a page a person reads. Returns what breaks that.
 * @param {Pick<Awaited<ReturnType<typeof shown>>, 'buttons' | 'forms' | 'links'>} view
 */
export const briefControlProblems = (view) => [
  ...view.buttons.map((button) => `a button: ${button}`),
  ...(view.forms > 0 ? [`${view.forms} form controls other than checkboxes`] : []),
  ...view.links
    .filter(
      (href) =>
        href !== '#/' &&
        !/^\?[^#]*#\/prs$/.test(href) &&
        !/^https:\/\/github\.com\/acme\/app\/pull\/\d+(\/checks)?$/.test(href) &&
        !/^https:\/\/example\.invalid\/work-orders\/[\w-]+$/.test(href),
    )
    .map((href) => `a link to an unexpected place: ${href}`),
];

/**
 * Presses every link and checkbox with navigation blocked, and returns the requests that were not a GET. The page's own
 * handlers run first: only the browser's default of following a link is stopped.
 * @param {import('playwright').Page} page
 * @param {string} origin
 */
export const pressEverything = async (page, origin) => {
  /** @type {string[]} */
  const sent = [];
  const ctx = page.context();
  const note = (/** @type {import('playwright').Request} */ request) => {
    if (request.method() !== 'GET') sent.push(`${request.method()} ${request.url()}`);
  };
  ctx.on('request', note);
  await ctx.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort('blockedbyclient'),
  );
  await page.evaluate(() => {
    window.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) event.preventDefault();
    });
  });
  for (const control of await page.$$('.mb a, .mb input')) {
    await control.click();
    await control.focus();
    await page.keyboard.press('Enter');
  }
  await sleep(500);
  ctx.off('request', note);
  await ctx.unroute('**/*');
  return sent;
};

/** @param {import('playwright').Browser} browser */
export const runMergeBriefLane = async (browser) => {
  /** @type {string[]} */
  const problems = [];
  const expect = (/** @type {boolean} */ holds, /** @type {string} */ what) => {
    if (!holds) problems.push(what);
  };
  mkdirSync(OUT, { recursive: true });
  const factory = await startFactory();
  /** @type {{ ok: boolean, note: string }} */
  let compare = { ok: false, note: 'not run' };
  const briefAt = (/** @type {string} */ task, lang = 'en') =>
    `${factory.url}/?lang=${lang}&task=${encodeURIComponent(task)}#/merge-brief`;
  try {
    await factory.order(TASK);
    await factory.until('CHANGES');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    /** @type {string[]} */
    const requests = [];
    ctx.on('request', (request) => requests.push(request.method()));
    const shot = (/** @type {string} */ name) =>
      page.screenshot({ path: join(OUT, `merge-brief-${name}.png`), fullPage: true });
    const gates = async (/** @type {string} */ state, /** @type {import('playwright').Page} */ on) => {
      for (const check of [checkAxe, checkContrast, checkKeys])
        problems.push(...(await check(on, `merge-brief ${state}`)).problems);
    };

    await page.goto(briefAt(TASK));
    await page.waitForSelector('[data-why="changes"]', { timeout: 20_000 });
    const early = await shown(page);
    expect(early.brief === null && early.open === null, 'a PR with changes requested shows a brief');
    await shot('changes');
    await gates('no brief', page);

    // Loaded again so the page's own timer (15 s) cannot be what brings the brief: only a push from HQ is that fast.
    await page.goto(briefAt(TASK));
    await page.waitForSelector('[data-why="changes"]');
    await factory.tell('release');
    await page.waitForSelector('[data-brief="ready"]', { timeout: 10_000 });

    await page.goto(`${factory.url}/?lang=en`);
    await page.click('[data-testid="open-actions"]');
    await page.click('[data-testid="action-brief"]');
    await page.waitForSelector('[data-brief="ready"]', { timeout: 20_000 });
    expect(
      page.url() === `${factory.url}/?lang=en&task=${encodeURIComponent(TASK)}#/merge-brief`,
      `the ready action item opened ${page.url()}`,
    );
    const ready = await shown(page);
    expect(ready.banner === 'READY TO MERGE', `the banner reads ${ready.banner}`);
    expect(
      ready.stats.files === '2' && ready.stats.approvals === '1 / 1' && ready.stats.rounds === '2',
      `stats ${JSON.stringify(ready.stats)}`,
    );
    expect(ready.files.join() === 'docs/note.md,src/note.txt', `files ${ready.files}`);
    expect(ready.checks.join() === 'ci', `checks ${ready.checks}`);
    expect(
      JSON.stringify(ready.evidence) ===
        JSON.stringify({
          ci_runs: 'collected',
          test_output: 'not_collected',
          screenshots: 'not_collected',
          logs: 'not_collected',
        }),
      `evidence ${JSON.stringify(ready.evidence)}`,
    );
    expect(ready.unexplained === 0, 'a "not collected" with no reason');
    expect(ready.timeline.join() === 'changes,approve', `timeline ${ready.timeline}`);
    expect(ready.open === 'Open on GitHub to merge (0/3 checked)', `the link reads ${ready.open}`);
    expect(ready.boxes === 3, `${ready.boxes} checkboxes`);
    problems.push(...briefControlProblems(ready));
    await shot('ready');
    await gates('ready', page);
    const calm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const still = await calm.newPage();
    await still.goto(briefAt(TASK));
    await still.waitForSelector('[data-brief="ready"]');
    problems.push(...(await checkMotion(still, 'merge-brief reduced-motion')).problems);
    await still.goto(briefAt(TASK, 'th'));
    await still.waitForSelector('[data-brief="ready"]');
    await gates('ready th', still);
    await still.screenshot({ path: join(OUT, 'merge-brief-ready-th.png'), fullPage: true });
    await calm.close();

    const writes = async () => (await factory.tell('calls')).filter((call) => !call.startsWith('GET '));
    const before = await writes();
    const sent = await pressEverything(page, factory.url);
    expect(sent.length === 0, `pressing the controls sent ${sent}`);
    expect((await writes()).join() === before.join(), 'pressing the controls made HQ write to the host');
    for (const other of ctx.pages()) if (other !== page) await other.close();

    await page.goto(briefAt(TASK));
    await page.waitForSelector('[data-brief="ready"]');
    for (const box of await page.$$('input[type="checkbox"]')) await box.check();
    const ticked = await shown(page);
    expect(ticked.open === 'Open on GitHub to merge ✓', `with every box ticked the link reads ${ticked.open}`);
    for (const box of await page.$$('input[type="checkbox"]')) await box.uncheck();

    // The commit ids and the clock change on every run, so the committed comparison image pins them.
    await page.$$eval('.mb-timeline code, .mb-card code', (nodes) => {
      for (const node of nodes) node.textContent = 'commit';
    });
    await page.$$eval('.mb-timeline time', (nodes) => {
      for (const node of nodes) node.textContent = '19:31';
    });
    await page.$eval('.mb-brief > .mb-mute', (node) => {
      node.textContent = 'Checks and reviews read from GitHub at 19:58.';
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    compare = await canvasCompare(browser, page, { inventory: {}, text: '' }, BRIEF_SPEC);

    await factory.order(OTHER);
    await page.goto(briefAt(OTHER));
    await page.waitForSelector('[data-brief="ready"]', { timeout: 20_000 });
    await factory.tell(`red aw/${OTHER}`);
    await page.waitForSelector('[data-why]', { timeout: 40_000 });
    const withdrawn = await shown(page);
    expect(
      withdrawn.brief === null && withdrawn.open === null,
      'the brief stayed after a late check turned red on its head',
    );
    await shot('withdrawn');

    await page.goto(briefAt(TASK));
    await page.waitForSelector('[data-brief="ready"]', { timeout: 20_000 });
    await factory.tell('merge 1');
    await page.waitForSelector('[data-brief="merged"]', { timeout: 40_000 });
    const merged = await shown(page);
    expect(
      merged.banner === 'MERGED' && merged.open === 'Open on GitHub',
      `after the merge: ${merged.banner}, ${merged.open}`,
    );
    problems.push(...briefControlProblems(merged));
    await shot('merged');

    expect(
      requests.every((method) => method === 'GET'),
      'the browser sent a request that is not a GET',
    );
    const calls = await factory.tell('calls');
    const logged = factory.apiLog().map(({ method, path }) => `${method} ${path}`);
    expect(
      logged.some((call) => call.startsWith('POST /repos/acme/app/pulls/1/reviews')),
      'the API call log holds no review, so it cannot show what HQ did',
    );
    const merges = [...calls, ...logged].filter((call) => /\/merges?(\?|\/|$)/.test(call));
    expect(merges.length === 0, `HQ called a merge endpoint: ${merges}`);
    await ctx.close();
  } finally {
    await factory.stop();
  }
  return {
    ok: problems.length === 0,
    compare,
    note:
      problems.length === 0
        ? `no brief while changes were asked, opened from the ready action item, withdrawn on a late red check, MERGED after a person merged on the host. Controls are checkboxes and links, the browser sent GET only, no merge call in the host log. Screenshots in ${OUT}`
        : problems.join('; '),
  };
};

if (import.meta.main) {
  const browser = await launch();
  try {
    const verdict = await runMergeBriefLane(browser).catch((error) => ({
      ok: false,
      note: String(error.message ?? error).split('\n')[0],
      compare: { ok: false, note: 'not run' },
    }));
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} merge brief lane: ${verdict.note}`);
    console.log(`${verdict.compare.ok ? 'PASS' : 'FAIL'} merge brief artboard compare: ${verdict.compare.note}`);
    process.exitCode = verdict.ok && verdict.compare.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
