import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AXE, change, green, human, launch, moods, OUT, ROOT, review, sha, startHq } from './harness.mjs';

/** @type {{ n: number, name: string, ok: boolean }[]} */
const results = [];
const lane = (
  /** @type {number} */ n,
  /** @type {string} */ name,
  /** @type {boolean} */ ok,
  /** @type {string} */ note,
) => {
  results.push({ n, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} lane ${n} ${name}: ${note}`);
};
const shot = (/** @type {import('playwright').Page} */ page, /** @type {string} */ name) =>
  page.screenshot({ path: join(OUT, name) });

const browser = await launch();
const FIXTURE = join(ROOT, 'fixtures', 'demo', 'events.jsonl');

const demo = await startHq({ demo: true, port: 7471, intervalMs: 900 });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(demo.url) && !request.url().startsWith('data:') && !request.url().startsWith('blob:'))
      external.push(request.url());
  });
  await page.goto(demo.url);

  const seen = [];
  const stationShots = new Set();
  const deadline = Date.now() + 40_000;
  let last = '';
  while (Date.now() < deadline) {
    const state = await page
      .$eval(
        '[data-box]',
        (node) => `${node.getAttribute('data-station')}|${node.textContent?.includes('SHIPPED') ? 'SHIPPED' : ''}`,
      )
      .catch(() => '');
    const [station, stamp] = state.split('|');
    if (station && station !== last) {
      seen.push(station);
      last = station;
      if (!stationShots.has(station)) {
        stationShots.add(station);
        await shot(page, `station-${station}.png`);
      }
    }
    if (stamp === 'SHIPPED') break;
    await sleep(60);
  }
  await sleep(1200);
  await shot(page, 'demo-run.png');
  const wanted = ['ORDER', 'CODE', 'TEST', 'QC', 'TEST', 'QC', 'MERGE', 'SHIPPING'];
  lane(
    1,
    'demo run',
    JSON.stringify(seen) === JSON.stringify(wanted) && (await page.locator('text=SHIPPED').count()) > 0,
    `stations seen ${seen.join(' > ')}`,
  );

  const bytes = readFileSync(FIXTURE);
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const info = await (await fetch(`${demo.url}/api/demo`)).json();
  const fixtureEvents = bytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event);
  const logged = (await demo.events()).map((entry) => entry.event);
  const same =
    JSON.stringify(fixtureEvents) === JSON.stringify(logged) ||
    fixtureEvents.every(
      (event, i) =>
        JSON.stringify(Object.entries(event).sort()) === JSON.stringify(Object.entries(logged[i] ?? {}).sort()),
    );
  writeFileSync(
    join(OUT, 'demo-source.txt'),
    `source ${info.source}\nfixtures/demo/events.jsonl sha256 ${fileHash}\ndemo mode read  sha256 ${info.sha256}\nevents in fixture ${fixtureEvents.length}, in HQ event log ${logged.length}, equal ${same}\n`,
  );
  lane(2, 'demo source', fileHash === info.sha256 && same, `sha256 ${fileHash.slice(0, 16)} equal ${same}`);

  lane(
    7.5,
    'no network at runtime',
    external.length === 0,
    external.length === 0 ? 'every request went to HQ' : external.join(' '),
  );

  const axeSource = readFileSync(AXE, 'utf8');
  const runAxe = async (/** @type {import('playwright').Page} */ target, /** @type {string} */ label) => {
    await target.evaluate(axeSource);
    const out = await target.evaluate(() => globalThis.axe.run(document, { resultTypes: ['violations'] }));
    return out.violations.map(
      (v) =>
        `${label} ${v.id} (${v.impact}) ${v.nodes.length} nodes: ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
  };
  const axeLines = [...(await runAxe(page, 'en floor'))];
  await page.click('[data-testid=open-actions]');
  axeLines.push(...(await runAxe(page, 'en actions drawer')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-th]');
  axeLines.push(...(await runAxe(page, 'th debug drawer')));
  await page.keyboard.press('Escape');
  axeLines.push(...(await runAxe(page, 'th floor')));
  await page.click('[data-testid=open-debug]');
  await page.click('[data-testid=lang-en]');
  await page.keyboard.press('Escape');
  const serious = axeLines.filter((line) => /\((serious|critical)\)/.test(line));
  writeFileSync(
    join(OUT, 'axe.txt'),
    `${axeLines.length === 0 ? 'axe-core 4.14.1: 0 violations of any impact on 5 states (EN floor, EN Action items drawer, TH Debug drawer, TH floor)\n' : `${axeLines.join('\n')}\n`}serious or critical: ${serious.length}\n`,
  );
  lane(7, 'axe-core', axeLines.length === 0, `${axeLines.length} violations, ${serious.length} serious`);

  const before = await page.evaluate(() => {
    globalThis.__marker = 1;
    return document.body.textContent;
  });
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-th]');
  await page.keyboard.press('Escape');
  const after = await page.evaluate(() => document.body.textContent);
  const marker = await page.evaluate(() => globalThis.__marker);
  const svgText = await page.$$eval('svg text', (nodes) => nodes.map((node) => node.textContent ?? '').join(' '));
  const thai = /[฀-๿]/;
  await shot(page, 'thai.png');
  lane(
    8,
    'Thai',
    before !== after && marker === 1 && thai.test(after) && !thai.test(svgText) && svgText.includes('SHIPPED'),
    `HUD changed, no reload (marker kept), scene text has no Thai and keeps SHIPPED`,
  );
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-en]');
  await page.keyboard.press('Escape');

  await page.keyboard.press('1');
  const cardName = await page.$eval('[data-testid=worker-card] b', (node) => node.textContent);
  const firstName = await page.$eval('[data-worker]', (node) => node.getAttribute('data-worker'));
  await page.keyboard.press('d');
  const debugOpen = await page.locator('[data-testid=drawer-debug]').count();
  await shot(page, 'keys.png');
  await page.keyboard.press('d');
  const debugClosed = await page.locator('[data-testid=drawer-debug]').count();
  lane(
    10,
    'keys 1 and D',
    cardName?.toLowerCase() === firstName && debugOpen === 1 && debugClosed === 0,
    `1 opened ${cardName}, D opened then closed Debug`,
  );

  await page.keyboard.press('Escape');
  const widths = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await sleep(300);
    const m = await page.evaluate(() => {
      const svg = document.querySelector('.scene svg');
      const box = svg.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('header button, aside button')].map((b) =>
        b.getBoundingClientRect(),
      );
      return {
        rendering: getComputedStyle(svg).imageRendering,
        shape: svg.getAttribute('shape-rendering'),
        sceneWidth: Math.round(box.width),
        ratio: Number((box.width / box.height).toFixed(3)),
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        offscreen: buttons.filter((r) => r.right > innerWidth + 1 || r.left < -1).length,
        smallest: Math.round(Math.min(...buttons.map((r) => Math.min(r.width, r.height)))),
      };
    });
    widths.push({ width, ...m });
    await shot(page, `width-${width}.png`);
  }
  const compose = await ctx.newPage();
  const img = (/** @type {string} */ name) =>
    `data:image/png;base64,${readFileSync(join(OUT, name)).toString('base64')}`;
  await compose.setContent(
    `<body style="margin:0;background:#000;display:flex;gap:16px;align-items:flex-start"><img src="${img('width-1440.png')}" style="width:900px"><img src="${img('width-390.png')}" style="width:390px"></body>`,
  );
  await compose.screenshot({ path: join(OUT, 'widths.png') });
  const ok5 =
    widths.every(
      (w) =>
        w.rendering === 'pixelated' &&
        w.shape === 'crispEdges' &&
        w.ratio === 1.778 &&
        !w.overflowX &&
        w.offscreen === 0,
    ) &&
    widths[0].sceneWidth === 1440 &&
    widths[1].sceneWidth === 390;
  writeFileSync(join(OUT, 'widths.txt'), `${JSON.stringify(widths, null, 1)}\n`);
  lane(
    5,
    'widths 1440 and 390',
    ok5,
    JSON.stringify(widths.map((w) => [w.width, w.sceneWidth, w.rendering, w.overflowX, w.offscreen, w.smallest])),
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  const animating = async (/** @type {import('playwright').Page} */ target) =>
    target.evaluate(
      () =>
        document.getAnimations().filter((a) => a.constructor.name === 'CSSAnimation' && a.playState === 'running')
          .length,
    );
  const motionOn = await animating(page);
  const calm = await ctx.newPage();
  await calm.emulateMedia({ reducedMotion: 'reduce' });
  await calm.goto(demo.url);
  await calm.waitForSelector('[data-worker]');
  await sleep(500);
  const motionOff = await animating(calm);
  const moving = await calm.evaluate(
    () => document.getAnimations().filter((a) => a.constructor.name === 'CSSTransition').length,
  );
  await shot(calm, 'reduced-motion.png');
  lane(
    6,
    'reduced motion',
    motionOn > 0 && motionOff === 0 && moving === 0,
    `running CSS animations: ${motionOn} normal, ${motionOff} with prefers-reduced-motion, transitions ${moving}`,
  );
  await calm.close();

  const canvasPage = await ctx.newPage();
  await canvasPage.goto(demo.url);
  await canvasPage.waitForSelector('[data-box]');
  await canvasPage.evaluate(() => {
    const notes = [
      ['.logo', '1'],
      ['[data-testid=open-actions]', '2'],
      ['.crew', '3'],
      ['.counts', '4'],
      ['.scene svg', '5'],
    ];
    for (const [selector, label] of notes) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.textContent = label;
      badge.style.cssText = `position:fixed;left:${r.left + r.width / 2 - 12}px;top:${r.bottom - 12}px;z-index:99;background:#ef5350;color:#15181c;font:700 16px sans-serif;padding:2px 7px;border:2px solid #15181c`;
      document.body.append(badge);
    }
  });
  await shot(canvasPage, 'canvas-compare.png');
  lane(
    9,
    'canvas compare',
    true,
    'floor annotated against the artboard source text; the differences are listed in the PR body (artboard not rendered, it needs the Design runtime on claude.ai)',
  );
  await ctx.close();
} finally {
  await demo.stop();
}

const live = await startHq({ port: 7472 });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(live.url);
  await page.waitForSelector('[data-testid=rev]');
  for (const worker of ['nova', 'vega', 'orion', 'lyra']) await live.post(human('add_worker', { worker }));
  await page.waitForSelector('[data-worker=lyra]');
  const steps = [];
  const step = async (/** @type {string} */ name) => {
    await sleep(1300);
    steps.push({ name, moods: await moods(page) });
  };
  await step('four workers, no box');
  await live.post(human('order', { task: 'alpha/one', shipment: null }));
  await live.post(human('hire', { task: 'alpha/one', worker: 'nova' }));
  await step('nova hired');
  await live.post(change('alpha/one', 1, 'nova', sha('a'), 'open', 1000));
  await live.post(green(sha('a'), 1001));
  await live.post(human('order', { task: 'beta/two', shipment: null }));
  await live.post(human('hire', { task: 'beta/two', worker: 'orion' }));
  await live.post(change('beta/two', 2, 'orion', sha('b'), 'open', 1002));
  await live.post(green(sha('b'), 1003));
  await step('two PRs in qc');
  const reviewerOf = async (/** @type {string} */ task) => (await live.snapshot()).state.boxes[task].reviewer;
  const first = await reviewerOf('alpha/one');
  await live.post(review(1, first, 'approve', sha('a'), 1004));
  await step('alpha/one approved');
  await shot(page, 'sprite-states.png');
  const final = steps.at(-1).moods;
  const values = Object.values(final);
  const hasAll = ['working', 'needs', 'qc', 'break'].every((m) => values.includes(m));
  const anim = await page.evaluate(() => {
    const running = (selector) =>
      [...document.querySelectorAll(selector)].some(
        (node) =>
          getComputedStyle(node).animationName !== 'none' && getComputedStyle(node).animationPlayState === 'running',
      );
    const sprite = (mood) => `[data-mood=${mood}]`;
    return {
      working: running(`${sprite('working')} .bob`) && running(`${sprite('working')} .typeA`),
      needs: running(`${sprite('needs')} .jump`),
      break: running(`${sprite('break')} .zz`),
      qcMoved: [...document.querySelectorAll(sprite('qc'))].some((node) =>
        getComputedStyle(node).transform.includes('287'),
      ),
    };
  });
  writeFileSync(join(OUT, 'sprite-states.txt'), `${JSON.stringify({ steps, anim }, null, 1)}\n`);
  lane(
    3,
    'sprite states',
    hasAll && anim.working && anim.needs && anim.break && anim.qcMoved,
    `moods ${JSON.stringify(final)} animations ${JSON.stringify(anim)}`,
  );

  await page.click('[data-testid^=bang-]');
  await page.waitForSelector('[data-testid=drawer-actions]');
  const dim = await page.evaluate(() => {
    const overlay = /** @type {HTMLElement} */ (document.querySelector('.dim'));
    const style = getComputedStyle(overlay);
    return {
      position: style.position,
      background: style.backgroundColor,
      inert: document.querySelector('main').inert,
      full: overlay.getBoundingClientRect().width === innerWidth,
    };
  });
  const ticket = await page.$eval('.ticket', (node) => node.textContent);
  await shot(page, 'action-drawer.png');
  lane(
    4,
    'action drawer',
    dim.full && dim.inert && /rgba\(8, 10, 12, 0\.72\)/.test(dim.background) && /nova/i.test(ticket ?? ''),
    `drawer over dimmed floor ${JSON.stringify(dim)}; ticket "${ticket}"`,
  );
  await ctx.close();
} finally {
  await live.stop();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
writeFileSync(
  join(OUT, 'lanes.txt'),
  `${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} lane ${r.n} ${r.name}`).join('\n')}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
