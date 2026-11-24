import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { contrastRatio, human, launch, NEEDS_CHIP, ROOT, runAxe, startHq } from './harness.mjs';

/**
 * The screen gate kit. Every screen ticket calls `screenGates` against its own route on a real HQ.
 * Four gates: axe (zero serious or critical), text contrast (4.5 to 1), no raw locale key on screen in en or th,
 * and no running animation under prefers-reduced-motion. Key parity between en and th is a unit test (src/test/i18n-parity.test.ts).
 * `selfTest` breaks each gate on purpose and requires it to fail.
 */

export const MIN_CONTRAST = 4.5;

const SETTLE_MS = 800;
const RAW_KEY = /^([a-z][\w-]*)(\.[a-zA-Z][\w-]*)+$/;

const COLLECT_TEXT = () => {
  const probe = /** @type {CanvasRenderingContext2D} */ (
    document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  );
  const norm = (/** @type {string} */ color) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data];
  };
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    const el = node.parentElement;
    if (text === '' || el === null) continue;
    if (el.closest('svg, script, style, [disabled], [hidden]') !== null) continue;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || style.visibility !== 'visible') continue;
    let opacity = 1;
    const layers = [];
    let unknown = false;
    for (let up = /** @type {Element | null} */ (el); up !== null; up = up.parentElement) {
      const cs = getComputedStyle(up);
      opacity *= Number(cs.opacity);
      if (unknown || layers.some((layer) => layer[3] === 255)) continue;
      if (cs.backgroundImage !== 'none') unknown = true;
      const bg = norm(cs.backgroundColor);
      if ((bg[3] ?? 0) > 0) layers.push(bg);
    }
    if (!layers.some((layer) => layer[3] === 255)) layers.push([255, 255, 255, 255]);
    const fg = norm(style.color);
    rows.push({
      text: text.slice(0, 40),
      html: el.outerHTML.slice(0, 160),
      fg: [fg[0], fg[1], fg[2], (fg[3] ?? 255) * opacity],
      layers,
      unknown,
    });
  }
  return rows;
};

/** @param {number[][]} stack top first, each [r, g, b, a 0 to 255] @returns {number[]} */
const flatten = (stack) =>
  stack.reduceRight((under, over) => {
    const alpha = (over[3] ?? 255) / 255;
    return [0, 1, 2].map((k) => (over[k] ?? 0) * alpha + (under[k] ?? 0) * (1 - alpha)).concat([255]);
  });

/** @param {{ fg: number[], layers: number[][] }} row */
export const rowRatio = ({ fg, layers }) => {
  const bg = flatten(layers);
  const ink = flatten([fg, bg]);
  return Number(contrastRatio(ink, bg).toFixed(2));
};

/** @param {{ html: string, fg: number[], layers: number[][] }} row @param {number} ratio */
const isNeedsChipRow = (row, ratio) => {
  const hex = (/** @type {string} */ h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const [fg, bg] = [hex(NEEDS_CHIP.fg), hex(NEEDS_CHIP.bg)];
  return (
    /class="chip"/.test(row.html) &&
    /data-mood="needs"/.test(row.html) &&
    [0, 1, 2].every((k) => row.fg[k] === fg[k] && flatten(row.layers)[k] === bg[k]) &&
    Math.abs(ratio - NEEDS_CHIP.ratio) < 0.01
  );
};

/**
 * @param {Array<{ text: string, html: string, fg: number[], layers: number[][], unknown: boolean }>} rows
 * @param {string} label
 * @returns {{ problems: string[], exceptions: string[], unchecked: number }}
 */
export const contrastProblems = (rows, label) => {
  const problems = [];
  const exceptions = [];
  let unchecked = 0;
  for (const row of rows) {
    if (row.unknown) {
      unchecked += 1;
      continue;
    }
    const ratio = rowRatio(row);
    if (ratio >= MIN_CONTRAST) continue;
    const found = `${label} "${row.text}" ${ratio}:1, needs ${MIN_CONTRAST}:1`;
    (isNeedsChipRow(row, ratio) ? exceptions : problems).push(found);
  }
  return { problems, exceptions, unchecked };
};

/** A raw key is dotted words whose first word is a locale namespace, so a file name or a version on screen is not one. */
/** @param {string[]} texts @param {string} label @param {string[]} [namespaces] */
export const rawKeyProblems = (texts, label, namespaces = localeNamespaces()) =>
  texts
    .filter((text) => namespaces.includes(RAW_KEY.exec(text)?.[1] ?? ''))
    .map((text) => `${label} shows the raw key "${text}"`);

export const localeNamespaces = () =>
  readdirSync(join(ROOT, 'src', 'locales', 'en'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5));

/** @param {{ running: string[], smil: number }} found @param {string} label */
export const motionProblems = ({ running, smil }, label) => [
  ...running.map((name) => `${label} runs ${name} under prefers-reduced-motion`),
  ...(smil > 0 ? [`${label} has ${smil} SVG animation elements under prefers-reduced-motion`] : []),
];

/** @param {import('playwright').Page} page @param {string} label */
export const checkAxe = async (page, label) => {
  const out = await runAxe(page, label);
  return { problems: out.blocking, notes: [`${out.violations.length} axe violations of any impact`] };
};

/** @param {import('playwright').Page} page @param {string} label */
export const checkContrast = async (page, label) => {
  const out = contrastProblems(await page.evaluate(COLLECT_TEXT), label);
  return {
    problems: out.problems,
    notes: [
      ...out.exceptions.map((found) => `named exception (Needs-you chip): ${found}`),
      ...(out.unchecked > 0 ? [`${out.unchecked} text nodes over a gradient or image were not measured`] : []),
    ],
  };
};

/** @param {import('playwright').Page} page @param {string} label */
export const checkKeys = async (page, label) => {
  const texts = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
      out.push(node.textContent?.trim() ?? '');
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]'))
      out.push(
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
        el.getAttribute('placeholder') ?? '',
      );
    return out;
  });
  return { problems: rawKeyProblems(texts, label), notes: [] };
};

/** A page opened with `reducedMotion: 'reduce'`. Samples every 100 ms for 1.2 s after the settle. */
/** @param {import('playwright').Page} page @param {string} label */
export const checkMotion = async (page, label) => {
  const sample = () => ({
    running: document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map(
        (a) =>
          `${a.constructor.name} ${/** @type {any} */ (a).animationName ?? /** @type {any} */ (a).transitionProperty ?? a.id}`,
      ),
    smil: document.querySelectorAll('svg animate, svg animateTransform, svg animateMotion, svg set').length,
  });
  const running = new Set();
  let smil = 0;
  for (let i = 0; i < 12; i += 1) {
    const found = await page.evaluate(sample);
    for (const name of found.running) running.add(name);
    smil = Math.max(smil, found.smil);
    await sleep(100);
  }
  return { problems: motionProblems({ running: [...running], smil }, label), notes: [] };
};

/**
 * @param {{ browser: import('playwright').Browser, url: string, screen?: string, ready?: string, langs?: string[] }} options
 * `screen` is a registered screen id (route `#/<id>`), or `main` for the floor.
 */
export const screenGates = async ({
  browser,
  url,
  screen = 'main',
  ready = '[data-testid=rev]',
  langs = ['en', 'th'],
}) => {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  const route = (/** @type {string} */ lang) => `${url}/?lang=${lang}${screen === 'main' ? '' : `#/${screen}`}`;
  const open = async (/** @type {string} */ lang, /** @type {boolean} */ calm) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(calm ? { reducedMotion: /** @type {const} */ ('reduce') } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(route(lang));
    await page.waitForSelector(ready, { timeout: 20_000 });
    await sleep(SETTLE_MS);
    return { ctx, page };
  };
  for (const lang of langs) {
    const { ctx, page } = await open(lang, false);
    const label = `${screen}/${lang}`;
    for (const check of [checkAxe, checkContrast, checkKeys]) {
      const out = await check(page, label);
      problems.push(...out.problems);
      notes.push(...out.notes);
    }
    await ctx.close();
  }
  const { ctx, page } = await open(langs[0] ?? 'en', true);
  problems.push(...(await checkMotion(page, `${screen}/reduced-motion`)).problems);
  await ctx.close();
  return { ok: problems.length === 0, problems, notes };
};

const sheet = (/** @type {string} */ css) =>
  `{ const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }`;

const BREAKERS = /** @type {const} */ ([
  [
    'axe',
    'a button with no name',
    checkAxe,
    "document.body.insertAdjacentHTML('beforeend', '<button></button>')",
    false,
  ],
  [
    'contrast',
    'grey text at 4.48 to 1 on white, just under the bar',
    checkContrast,
    `${sheet('.gate-probe{position:fixed;left:0;margin:0;z-index:9;background:#fff}.gate-under{top:0;color:#777}.gate-over{top:30px;color:#767676}')}; document.body.insertAdjacentHTML('beforeend', '<p class="gate-probe gate-under">just under</p>')`,
    false,
  ],
  [
    'parity',
    'a raw locale key as text',
    checkKeys,
    "document.body.insertAdjacentHTML('beforeend', '<p>floor.hud.missing</p>')",
    false,
  ],
  [
    'motion',
    'an infinite animation that ignores prefers-reduced-motion',
    checkMotion,
    sheet('@keyframes selftest{to{opacity:.5}}body{animation:selftest 1s infinite !important}'),
    true,
  ],
  [
    'motion',
    'an SVG animate element',
    checkMotion,
    'document.body.insertAdjacentHTML(\'beforeend\', \'<svg width="4" height="4"><rect width="2" height="2"><animate attributeName="x" from="0" to="2" dur="1s" repeatCount="indefinite"/></rect></svg>\')',
    true,
  ],
]);

/**
 * Break each gate on a live page and require it to fail, so a gate that stops looking fails the lane.
 * @param {import('playwright').Browser} browser @param {string} url @param {string} [ready]
 */
export const selfTest = async (browser, url, ready = '[data-testid=rev]') => {
  /** @type {string[]} */
  const problems = [];
  for (const [gate, what, check, inject, calm] of BREAKERS) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(calm ? { reducedMotion: /** @type {const} */ ('reduce') } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(`${url}/?lang=en`);
    await page.waitForSelector(ready);
    await sleep(SETTLE_MS);
    if (gate === 'contrast') {
      await page.evaluate(
        `${sheet('.gate-probe{position:fixed;left:0;margin:0;z-index:9;background:#fff}.gate-under{top:0;color:#777}.gate-over{top:30px;color:#767676}')}; document.body.insertAdjacentHTML('beforeend', '<p class="gate-probe gate-over">just over</p>')`,
      );
    }
    const clean = await check(page, 'self-test clean');
    if (clean.problems.length > 0) problems.push(`${gate} gate fails on the unbroken page: ${clean.problems[0]}`);
    await page.evaluate(inject);
    await sleep(200);
    const broken = await check(page, 'self-test broken');
    if (broken.problems.length === 0) problems.push(`${gate} gate passed with ${what}`);
    await ctx.close();
  }
  return problems;
};

/** Screens other than the floor: every `src/screens/<id>/screen.tsx`. */
export const registeredScreens = () => {
  const dir = join(ROOT, 'src', 'screens');
  return existsSync(dir) ? readdirSync(dir).filter((id) => existsSync(join(dir, id, 'screen.tsx'))) : [];
};

/** @param {import('playwright').Browser} browser @param {number} port */
export const runGateLane = async (browser, port = 7500 + (process.pid % 400)) => {
  const hq = await startHq({ port });
  try {
    await hq.post(human('add_worker', { worker: 'nova' }));
    const screens = ['main', ...registeredScreens()];
    const found = [];
    for (const screen of screens) found.push({ screen, ...(await screenGates({ browser, url: hq.url, screen })) });
    const broken = await selfTest(browser, hq.url);
    const problems = [...found.flatMap((one) => one.problems), ...broken];
    return {
      ok: problems.length === 0,
      note:
        problems.length === 0
          ? `${screens.join(', ')} pass axe, contrast, raw keys in en and th, reduced motion; ${BREAKERS.length} deliberately broken gates each failed${found.flatMap((one) => one.notes).length > 0 ? `; notes: ${[...new Set(found.flatMap((one) => one.notes))].join('; ')}` : ''}`
          : problems.slice(0, 12).join('; '),
    };
  } finally {
    await hq.stop();
  }
};

if (import.meta.main) {
  const browser = await launch();
  try {
    const verdict = await runGateLane(browser);
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} lane 11 screen gates: ${verdict.note}`);
    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
