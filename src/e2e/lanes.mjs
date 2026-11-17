import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { canvasCompare, pageText } from './canvas-compare.mjs';
import {
  change,
  green,
  human,
  launch,
  moods,
  OUT,
  ROOT,
  review,
  runAxe,
  sceneLabelContrast,
  sha,
  startHq,
} from './harness.mjs';

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

let labels = [];
let demoText = '';
const axe = { violations: [], incomplete: [], states: [] };
const audit = async (/** @type {import('playwright').Page} */ target, /** @type {string} */ label) => {
  const out = await runAxe(target, label);
  axe.violations.push(...out.violations);
  axe.incomplete.push(...out.incomplete);
  axe.states.push(label);
};
const demo = await startHq({ demo: true, port: 7471, intervalMs: 900 });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const blocked = [];
  await ctx.route(/.*/, (route) => {
    const url = route.request().url();
    if (url.startsWith(demo.url)) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  const policyErrors = [];
  page.on('console', (message) => {
    if (/Content Security Policy|violates the following/i.test(message.text())) policyErrors.push(message.text());
  });
  const first = await page.goto(demo.url);
  const firstHeaders = first.headers();

  const seen = [];
  const where = {};
  const stationShots = new Set();
  const deadline = Date.now() + 40_000;
  let last = '';
  while (Date.now() < deadline) {
    const state = await page
      .$eval(
        '[data-box]',
        (node) =>
          `${node.getAttribute('data-station')}|${node.textContent?.includes('SHIPPED') ? 'SHIPPED' : ''}|${/translate\(([\d.]+)px/.exec(node.style.transform)?.[1]}`,
      )
      .catch(() => '');
    const [station, stamp, x] = state.split('|');
    if (station && station !== last) {
      seen.push(station);
      last = station;
      where[station] = Number(x);
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
  const gantry = { TEST: [250, 267], QC: [276, 298], MERGE: [305, 319] };
  const onGantry = Object.entries(gantry).every(([station, [from, to]]) => {
    const x = where[station] === undefined ? Number.NaN : where[station] + 4.5;
    return x >= from && x <= to;
  });
  lane(
    1,
    'demo run',
    JSON.stringify(seen) === JSON.stringify(wanted) && (await page.locator('text=SHIPPED').count()) > 0 && onGantry,
    `stations seen ${seen.join(' > ')}; box x at TEST ${where.TEST}, QC ${where.QC}, MERGE ${where.MERGE} (gantries 250-267, 276-298, 305-319)`,
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

  const outside = blocked.length;
  const probe = await ctx.newPage();
  await probe.goto('http://192.0.2.1:9/').catch(() => {});
  await probe.close();
  const blockerWorks = blocked.length === outside + 1;
  lane(
    7.5,
    'no network at runtime',
    outside === 0 &&
      blockerWorks &&
      policyErrors.length === 0 &&
      firstHeaders['x-content-type-options'] === 'nosniff' &&
      /script-src 'self';/.test(firstHeaders['content-security-policy'] ?? ''),
    `${outside} requests to a host other than HQ (blocked and counted; the blocker itself ${blockerWorks ? 'caught' : 'MISSED'} a probe to 192.0.2.1), ${policyErrors.length} CSP violations ${policyErrors.join(' ').slice(0, 300)}, nosniff and script-src 'self' on /`,
  );

  await audit(page, 'demo EN floor (SHIPPED, all on break)');
  await page.click('[data-testid=open-actions]');
  await audit(page, 'demo EN Action items drawer (empty)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-th]');
  await audit(page, 'demo TH Debug drawer');
  await page.keyboard.press('Escape');
  await audit(page, 'demo TH floor');
  labels = await sceneLabelContrast(page);
  await page.click('[data-testid=open-debug]');
  await page.click('[data-testid=lang-en]');
  await page.keyboard.press('Escape');

  const toastText = () => page.$eval('.toast span', (node) => node.textContent);
  const htmlLang = () => page.evaluate(() => document.documentElement.lang);
  const toastEn = await toastText();
  const before = await page.evaluate(() => {
    globalThis.__marker = 1;
    return document.body.textContent;
  });
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-th]');
  await page.keyboard.press('Escape');
  const after = await page.evaluate(() => document.body.textContent);
  const marker = await page.evaluate(() => globalThis.__marker);
  const toastTh = await toastText();
  const navTh = await page.$eval('header nav', (node) => node.getAttribute('aria-label'));
  const langTh = await htmlLang();
  const svgText = await page.$$eval('svg text', (nodes) => nodes.map((node) => node.textContent ?? '').join(' '));
  const thai = /[฀-๿]/;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h2.pixel' });
  const heading = await page.$eval('h2.pixel', (node) => node.textContent ?? '');
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  const families = fonts.map((font) => font.familyName);
  await shot(page, 'thai.png');
  await page.reload();
  await page.waitForSelector('[data-worker]');
  const keptTh = {
    lang: await htmlLang(),
    text: thai.test(await page.evaluate(() => document.body.textContent ?? '')),
  };
  lane(
    8,
    'Thai',
    before !== after &&
      marker === 1 &&
      thai.test(after) &&
      !thai.test(svgText) &&
      svgText.includes('SHIPPED') &&
      langTh === 'th' &&
      thai.test(toastTh ?? '') &&
      !/merged and shipped/.test(toastTh ?? '') &&
      /merged and shipped/.test(toastEn ?? '') &&
      thai.test(heading) &&
      families.includes('Sarabun') &&
      families.every((family) => ['Sarabun', 'Silkscreen'].includes(family)) &&
      keptTh.lang === 'th' &&
      keptTh.text &&
      navTh === 'เมนู HQ',
    `HUD changed with no reload (marker kept), html lang ${langTh}, toast re-rendered in Thai ("${toastTh}"), scene text has no Thai and keeps SHIPPED, Thai in .pixel drawn with ${families.join(' + ')}, Thai kept after a reload (lang ${keptTh.lang}), nav label "${navTh}"`,
  );
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-en]');
  const langEn = await htmlLang();
  lane(8.5, 'html lang follows the switch', langEn === 'en', `back to ${langEn}`);
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

  demoText = await pageText(page);
  await ctx.close();
} finally {
  await demo.stop();
}

const live = await startHq({ port: 7472 });
let builtShot = '';
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
  const bangs = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('[data-testid^=bang-]')].map((node) =>
      node.getAttribute('data-testid')?.slice(5),
    ),
    art: [...document.querySelectorAll('[data-worker]')]
      .filter((node) => [...node.querySelectorAll('text')].some((text) => text.textContent === '!'))
      .map((node) => node.getAttribute('data-worker')),
  }));
  const needing = Object.entries(final)
    .filter(([, mood]) => mood === 'needs')
    .map(([name]) => name);
  writeFileSync(join(OUT, 'sprite-states.txt'), `${JSON.stringify({ steps, anim, bangs }, null, 1)}\n`);
  lane(
    3,
    'sprite states',
    hasAll &&
      anim.working &&
      anim.needs &&
      anim.break &&
      anim.qcMoved &&
      JSON.stringify(bangs.buttons) === JSON.stringify(needing) &&
      JSON.stringify(bangs.art) === JSON.stringify(needing),
    `moods ${JSON.stringify(final)} animations ${JSON.stringify(anim)}; "!" button on ${bangs.buttons}, "!" art on ${bangs.art}, workers that need you ${needing}`,
  );

  await audit(page, 'live EN floor (Needs you, At QC, Working, On break)');
  await page.click('[data-testid=bang-nova]');
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
  await audit(page, 'live EN Action items drawer (one ticket for nova)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await audit(page, 'live EN floor with the worker card open');
  await page.keyboard.press('Escape');
  await page.click('[data-testid=open-debug]');
  await page.click('[data-testid=lang-th]');
  await page.keyboard.press('Escape');
  await audit(page, 'live TH floor (Needs you)');
  await page.keyboard.press('d');
  await page.click('[data-testid=lang-en]');
  await page.keyboard.press('Escape');

  const incompleteTargets = [...new Set(axe.incomplete.map((line) => line.replace(/^.*? (\S+ \(\S+\) )/, '$1')))];
  const firewall = labels.find((row) => row.text === 'FIREWALL');
  const lowest = [...labels].sort((a, b) => a.ratio - b.ratio).slice(0, 8);
  writeFileSync(
    join(OUT, 'axe.txt'),
    [
      `axe-core 4.14.1 on ${axe.states.length} states:`,
      ...axe.states.map((state) => `  ${state}`),
      `violations of any impact: ${axe.violations.length}`,
      ...axe.violations.map((line) => `  ${line}`),
      `incomplete (axe could not decide, NOT passes): ${axe.incomplete.length} nodes over ${axe.states.length} states, ${incompleteTargets.length} distinct rule/target pairs`,
      ...axe.incomplete.map((line) => `  ${line}`),
      '',
      'Estimated contrast of the scene labels (SVG text against the rect painted under it, an estimate, not axe):',
      ...lowest.map((row) => `  ${row.ratio}:1  "${row.text}" size ${row.size}  rgb(${row.fg}) on rgb(${row.bg})`),
      `  FIREWALL art label: ${firewall?.ratio}:1 (needs 4.5)`,
      '',
    ].join('\n'),
  );
  lane(
    7,
    'axe-core',
    axe.violations.length === 0 && firewall !== undefined && firewall.ratio >= 4.5,
    `${axe.violations.length} violations on ${axe.states.length} states, ${axe.incomplete.length} incomplete nodes recorded in axe.txt (undecided, not passed), FIREWALL art label ${firewall?.ratio}:1`,
  );

  const sprites = async (/** @type {import('playwright').Page} */ target) =>
    target.$$eval('[data-worker]', (nodes) => nodes.length);
  const motion = await ctx.newPage();
  const calm = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  ).newPage();
  for (const target of [motion, calm]) {
    await target.goto(live.url);
    await target.waitForSelector('[data-worker]');
  }
  const counting = (/** @type {string} */ kind) =>
    document.getAnimations().filter((a) => a.constructor.name === kind && a.playState === 'running').length;
  const watch = async (/** @type {import('playwright').Page} */ target, /** @type {number} */ ms) => {
    const peak = { CSSAnimation: 0, CSSTransition: 0 };
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const kind of /** @type {const} */ (['CSSAnimation', 'CSSTransition']))
        peak[kind] = Math.max(peak[kind], await target.evaluate(counting, kind));
      await sleep(30);
    }
    return peak;
  };
  const watching = Promise.all([watch(motion, 3600), watch(calm, 3600)]);
  await sleep(300);
  await live.post(human('order', { task: 'gamma/three', shipment: null }));
  await sleep(500);
  await live.post(human('hire', { task: 'gamma/three', worker: 'vega' }));
  await sleep(500);
  await live.post(change('gamma/three', 3, 'vega', sha('c'), 'open', 1010));
  await sleep(500);
  await live.post(green(sha('c'), 1011));
  const [moving, still] = await watching;
  await shot(calm, 'reduced-motion.png');
  lane(
    6,
    'reduced motion',
    moving.CSSAnimation > 0 && moving.CSSTransition > 0 && still.CSSAnimation === 0 && still.CSSTransition === 0,
    `sampled every 30 ms for 3.6 s while a box moved through four stations: peak running CSS animations ${moving.CSSAnimation} and transitions ${moving.CSSTransition} normally, ${still.CSSAnimation} and ${still.CSSTransition} with prefers-reduced-motion`,
  );
  await calm.context().close();
  await motion.close();

  for (const worker of ['atlas', 'juno', 'kai']) await live.post(human('add_worker', { worker }));
  await page.waitForFunction(() => document.querySelectorAll('.crew li').length === 7);
  await sleep(500);
  const crew = await page.$$eval('.crew li', (nodes) => nodes.length);
  const drawn = await sprites(page);
  lane(
    3.5,
    'six cages, seven workers',
    crew === 7 && drawn === 6,
    `roster lists ${crew} workers, the scene draws ${drawn} (one per cage)`,
  );

  await page.setViewportSize({ width: 1440, height: 980 });
  await sleep(300);
  builtShot = join(OUT, 'floor-live.png');
  await page.screenshot({ path: builtShot });
  const verdict = await canvasCompare(browser, page, builtShot, demoText);
  lane(9, 'canvas compare', verdict.ok, verdict.note);
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
