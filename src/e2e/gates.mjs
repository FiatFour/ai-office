import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { contrastRatio, human, launch, NEEDS_CHIP, ROOT, runAxe, startHqFree } from './harness.mjs';
import { runFixtureLane } from './screen-fixture.mjs';

/**
 * The screen gate kit. Every screen ticket calls `screenGates` against its own route on a real HQ.
 * Four gates: axe (zero serious or critical), text contrast (4.5 to 1, text over a gradient or image measured from the rendered pixels behind it),
 * no raw locale key on screen in en or th, and no motion under prefers-reduced-motion (CSS, SMIL, or a script moving transforms). Key parity between en and th is a unit test (src/test/i18n-parity.test.ts).
 * `selfTest` breaks each gate on purpose and requires it to fail.
 */

export const MIN_CONTRAST = 4.5;

const SETTLE_MS = 800;
const RAW_KEY = /^([a-z][\w-]*)(\.[a-zA-Z][\w-]*)+$/;

const COLLECT_TEXT = (/** @type {{ selector: string, reason: string }[]} */ extraAllow) => {
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
  const declared = JSON.parse(
    document.querySelector('[data-contrast-allow]')?.getAttribute('data-contrast-allow') ?? '[]',
  );
  const allow = [...declared, ...extraAllow].filter(
    (entry) => typeof entry.reason === 'string' && entry.reason.trim() !== '',
  );
  for (const el of document.querySelectorAll('[data-gate-i]')) el.removeAttribute('data-gate-i');
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
    let clipped = false;
    for (let up = /** @type {Element | null} */ (el); up !== null; up = up.parentElement) {
      const cs = getComputedStyle(up);
      opacity *= Number(cs.opacity);
      if (unknown || layers.some((layer) => layer[3] === 255)) continue;
      if (cs.backgroundImage !== 'none') unknown = true;
      if (cs.backgroundClip === 'text' || cs.getPropertyValue('-webkit-background-clip') === 'text') clipped = true;
      const bg = norm(cs.backgroundColor);
      if ((bg[3] ?? 0) > 0) layers.push(bg);
    }
    if (!layers.some((layer) => layer[3] === 255)) layers.push([255, 255, 255, 255]);
    const fg = norm(style.color);
    const index = rows.length;
    if (unknown || clipped) el.setAttribute('data-gate-i', `${el.getAttribute('data-gate-i') ?? ''} ${index}`.trim());
    rows.push({
      text: text.slice(0, 40),
      html: el.outerHTML.slice(0, 160),
      fg: [fg[0], fg[1], fg[2], (fg[3] ?? 255) * opacity],
      layers,
      unknown: unknown || clipped,
      clipped,
      allowed: allow.find((entry) => el.closest(entry.selector) !== null)?.reason ?? '',
    });
  }
  return rows;
};

/** Text goes transparent so a screenshot shows only what is behind it. */
const HIDE_TEXT = `{ const s = new CSSStyleSheet(); s.replaceSync('*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;caret-color:transparent!important}'); window.__gateHide = s; document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }`;
const SHOW_TEXT = `{ document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== window.__gateHide); }`;

const PLACE_TEXT = (/** @type {number} */ index) => {
  const el = document.querySelector(`[data-gate-i~="${index}"]`);
  if (el === null) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rects = [];
  for (const child of el.childNodes) {
    if (child.nodeType !== 3 || (child.textContent ?? '').trim() === '') continue;
    const range = document.createRange();
    range.selectNodeContents(child);
    for (const b of range.getClientRects()) rects.push([b.left, b.top, b.right, b.bottom]);
  }
  const clipped = rects.some(
    ([l, t, r, b]) => (l ?? 0) < 0 || (t ?? 0) < 0 || (r ?? 0) > innerWidth || (b ?? 0) > innerHeight,
  );
  return rects.length === 0 || clipped ? null : rects;
};

const SAMPLE_PIXELS = async (/** @type {{ b64: string, rects: number[][] }} */ { b64, rects }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  g.drawImage(img, 0, 0);
  const seen = new Set();
  for (const [l = 0, t = 0, r = 0, b = 0] of rects) {
    const x0 = Math.floor(l);
    const y0 = Math.floor(t);
    const w = Math.max(1, Math.ceil(r) - x0);
    const h = Math.max(1, Math.ceil(b) - y0);
    const data = g.getImageData(x0, y0, w, h).data;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 3000)));
    for (let y = 0; y < h; y += step)
      for (let x = 0; x < w; x += step) {
        const k = (y * w + x) * 4;
        seen.add(`${data[k]},${data[k + 1]},${data[k + 2]}`);
      }
  }
  return [...seen].map((color) => color.split(',').map(Number));
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

/** The worst pixel behind the text decides: text over a gradient or image passes only if every sampled pixel gives 4.5 to 1. */
/** @param {{ fg: number[] }} row @param {number[][]} pixels */
export const behindRatio = (row, pixels) =>
  Math.min(
    ...pixels.map((pixel) => rowRatio({ fg: row.fg, layers: [[pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, 255]] })),
  );

/**
 * `behind` is the pixels sampled behind a row over a gradient or image, null when they could not be sampled.
 * A row nobody could measure fails as `not measurable`, unless its screen allowlists it with a reason.
 * @param {Array<{ text: string, html: string, fg: number[], layers: number[][], unknown: boolean, allowed?: string, behind?: number[][] | null }>} rows
 * @param {string} label
 * @returns {{ problems: string[], exceptions: string[], allowed: string[] }}
 */
export const contrastProblems = (rows, label) => {
  const problems = [];
  const exceptions = [];
  const allowed = [];
  for (const row of rows) {
    if (row.unknown && row.allowed) {
      allowed.push(`${label} "${row.text}" over a gradient or image is allowlisted: ${row.allowed}`);
      continue;
    }
    if (row.unknown && (row.behind === undefined || row.behind === null || row.behind.length === 0)) {
      problems.push(
        `${label} "${row.text}" over a gradient or image is not measurable, and its screen does not allowlist it`,
      );
      continue;
    }
    const ratio = row.unknown ? Number(behindRatio(row, row.behind ?? []).toFixed(2)) : rowRatio(row);
    if (ratio >= MIN_CONTRAST) continue;
    const found = `${label} "${row.text}" ${ratio}:1, needs ${MIN_CONTRAST}:1`;
    (isNeedsChipRow(row, ratio) ? exceptions : problems).push(found);
  }
  return { problems, exceptions, allowed };
};

/**
 * Screenshot each gradient or image row with every text transparent, and read the pixels where its text sits.
 * @param {import('playwright').Page} page @param {Array<{ unknown: boolean, clipped?: boolean, behind?: number[][] | null }>} rows
 */
const measureBehind = async (page, rows) => {
  const todo = rows.flatMap((row, index) => (row.unknown && !row.clipped ? [[row, index]] : []));
  if (todo.length === 0) return;
  await page.evaluate(HIDE_TEXT);
  try {
    for (const [row, index] of /** @type {Array<[(typeof rows)[number], number]>} */ (todo)) {
      const rects = await page.evaluate(PLACE_TEXT, index);
      if (rects === null) continue;
      const png = await page.screenshot({ type: 'png' });
      row.behind = await page.evaluate(SAMPLE_PIXELS, { b64: png.toString('base64'), rects });
    }
  } finally {
    await page.evaluate(SHOW_TEXT);
  }
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

/** @param {{ running: string[], smil: number, scripted?: string[] }} found @param {string} label */
export const motionProblems = ({ running, smil, scripted = [] }, label) => [
  ...running.map((name) => `${label} runs ${name} under prefers-reduced-motion`),
  ...scripted.map((name) => `${label} moves ${name} by script under prefers-reduced-motion`),
  ...(smil > 0 ? [`${label} has ${smil} SVG animation elements under prefers-reduced-motion`] : []),
];

/** @param {import('playwright').Page} page @param {string} label */
export const checkAxe = async (page, label) => {
  const out = await runAxe(page, label);
  return { problems: out.blocking, notes: [`${out.violations.length} axe violations of any impact`] };
};

/** @param {import('playwright').Page} page @param {string} label @param {{ selector: string, reason: string }[]} [allow] extra per-screen allowlist, on top of the screen's own `contrastAllow` */
export const checkContrast = async (page, label, allow = []) => {
  const rows = await page.evaluate(COLLECT_TEXT, allow);
  await measureBehind(page, rows);
  const out = contrastProblems(rows, label);
  return {
    problems: out.problems,
    notes: [
      ...out.exceptions.map((found) => `named exception (Needs-you chip): ${found}`),
      ...out.allowed.map((found) => `allowlisted: ${found}`),
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

const MOVING = ['transform', 'translate', 'rotate', 'scale', 'opacity', 'left', 'top', 'filter'];

/** A page opened with `reducedMotion: 'reduce'`. Samples every 100 ms for 1.2 s after the settle. */
/** @param {import('playwright').Page} page @param {string} label */
export const checkMotion = async (page, label) => {
  const sample = (/** @type {string[]} */ props) => {
    const w = /** @type {any} */ (window);
    w.__gateIds = w.__gateIds ?? new WeakMap();
    const ids = w.__gateIds;
    const styles = {};
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('svg') !== null) continue;
      if (!ids.has(el)) ids.set(el, ids.size);
      const cs = getComputedStyle(el);
      const name = `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className !== '' ? `.${el.className.split(' ')[0]}` : ''}`;
      styles[ids.get(el)] = [name, props.map((prop) => cs.getPropertyValue(prop)).join('|')];
    }
    return {
      running: document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map(
          (a) =>
            `${a.constructor.name} ${/** @type {any} */ (a).animationName ?? /** @type {any} */ (a).transitionProperty ?? a.id}`,
        ),
      smil: document.querySelectorAll('svg animate, svg animateTransform, svg animateMotion, svg set').length,
      styles,
    };
  };
  const running = new Set();
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @type {Map<string, string>} */
  const names = new Map();
  let smil = 0;
  for (let i = 0; i < 12; i += 1) {
    const found = await page.evaluate(sample, MOVING);
    for (const name of found.running) running.add(name);
    for (const [id, [name = '', value = '']] of Object.entries(found.styles)) {
      names.set(id, name);
      seen.set(id, (seen.get(id) ?? new Set()).add(value));
    }
    smil = Math.max(smil, found.smil);
    await sleep(100);
  }
  const scripted = [...seen].filter(([, values]) => values.size > 1).map(([id]) => names.get(id) ?? id);
  return {
    problems: motionProblems({ running: [...running], smil, scripted: [...new Set(scripted)] }, label),
    notes: [],
  };
};

const READY_MS = 20_000;

/**
 * Waits until a screen can be gated. A screen is `main` (the floor), or a registered id that the registry wraps in `[data-screen=<id>]`.
 * The screen may declare its own `ready` selector (read from the wrapper), and a screen that fails to load shows its cause in `[data-screen-error]`.
 * @param {import('playwright').Page} page @param {string} screen @param {string | undefined} ready @param {number} timeout
 * @returns {Promise<string | null>} null when ready, otherwise the named cause
 */
const settle = async (page, screen, ready, timeout) => {
  if (screen === 'main') {
    try {
      await page.waitForSelector(ready ?? '[data-testid=rev]', { timeout });
      return null;
    } catch {
      return 'not ready';
    }
  }
  const root = `[data-screen="${screen}"]`;
  try {
    await page.waitForSelector(`${root}, [data-screen-error]`, { state: 'attached', timeout });
  } catch {
    return 'not ready';
  }
  const failure = await page.$('[data-screen-error]');
  if (failure !== null) return (await failure.textContent())?.trim() || 'not ready';
  const declared = ready ?? (await page.getAttribute(root, 'data-ready'));
  if (declared) {
    try {
      await page.waitForSelector(declared, { timeout });
    } catch {
      return 'not ready';
    }
  }
  return null;
};

/**
 * @param {{ browser: import('playwright').Browser, url: string, screen?: string, ready?: string, langs?: string[], readyMs?: number }} options
 * `screen` is a registered screen id (route `#/<id>`), or `main` for the floor. `ready` overrides the selector the screen declares.
 * @returns {Promise<{ ok: boolean, problems: string[], notes: string[], notReady: string | null, console: string[] }>}
 */
export const screenGates = async ({
  browser,
  url,
  screen = 'main',
  ready,
  langs = ['en', 'th'],
  readyMs = READY_MS,
}) => {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const logged = [];
  const route = (/** @type {string} */ lang) => `${url}/?lang=${lang}${screen === 'main' ? '' : `#/${screen}`}`;
  const open = async (/** @type {string} */ lang, /** @type {boolean} */ calm) => {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(calm ? { reducedMotion: /** @type {const} */ ('reduce') } : {}),
    });
    const page = await ctx.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') logged.push(message.text());
    });
    await page.goto(route(lang));
    const notReady = await settle(page, screen, ready, readyMs);
    if (notReady === null) await sleep(SETTLE_MS);
    return { ctx, page, notReady };
  };
  /** @param {string} cause */
  const stop = (cause) => ({ ok: false, problems: [`${screen}: ${cause}`], notes, notReady: cause, console: logged });
  for (const lang of langs) {
    const { ctx, page, notReady } = await open(lang, false);
    if (notReady !== null) {
      await ctx.close();
      return stop(notReady);
    }
    const label = `${screen}/${lang}`;
    for (const check of [checkAxe, checkContrast, checkKeys]) {
      const out = await check(page, label);
      problems.push(...out.problems);
      notes.push(...out.notes);
    }
    await ctx.close();
  }
  const { ctx, page, notReady } = await open(langs[0] ?? 'en', true);
  if (notReady !== null) {
    await ctx.close();
    return stop(notReady);
  }
  problems.push(...(await checkMotion(page, `${screen}/reduced-motion`)).problems);
  await ctx.close();
  return { ok: problems.length === 0, problems, notes, notReady: null, console: logged };
};

const sheet = (/** @type {string} */ css) =>
  `{ const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }`;

const html = (/** @type {string} */ markup) =>
  `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(markup)})`;

const KEY = 'floor.hud.missing';

/** The page forbids inline style attributes, so probes get their look from an adopted stylesheet. */
const styled = (/** @type {string} */ css, /** @type {string} */ markup) => `${sheet(css)}; ${html(markup)}`;
const BOX = 'position:fixed;left:0;margin:0;z-index:99;';
const probe = (
  /** @type {string} */ name,
  /** @type {number} */ top,
  /** @type {string} */ css,
  /** @type {string} */ markup = name,
  /** @type {string} */ tag = 'p',
) => styled(`.${name}{${BOX}top:${top}px;${css}}`, `<${tag} class="${name}">${markup}</${tag}>`);

/**
 * Each breaker injects one defect on a live page and the gate must fail. `clean` is injected first, a look-alike that the gate must pass.
 * @type {ReadonlyArray<{ gate: string, what: string, check: (page: import('playwright').Page, label: string) => Promise<{ problems: string[] }>, inject: string, clean?: string, calm?: boolean }>}
 */
const BREAKERS = [
  { gate: 'axe', what: 'a button with no name (critical)', check: checkAxe, inject: html('<button></button>') },
  {
    gate: 'axe',
    what: 'a link with no name (serious)',
    check: checkAxe,
    clean: html('<a href="#top">named</a>'),
    inject: html('<a href="#top"></a>'),
  },
  {
    gate: 'contrast',
    what: 'grey text at 4.48 to 1 on white, just under the bar',
    check: checkContrast,
    clean: probe('gate-over', 0, 'background:#fff;color:#767676'),
    inject: probe('gate-under', 30, 'background:#fff;color:#777'),
  },
  {
    gate: 'contrast',
    what: 'light grey text over a white gradient (1.9 to 1)',
    check: checkContrast,
    clean: probe('gate-grad-dark', 0, 'background-image:linear-gradient(#fff,#fff);color:#555'),
    inject: probe('gate-grad-light', 30, 'background-image:linear-gradient(#fff,#fff);color:#bbb'),
  },
  {
    gate: 'contrast',
    what: 'text clipped to its own gradient, which cannot be measured and is not allowlisted',
    check: checkContrast,
    inject: probe(
      'gate-clip',
      60,
      'background-image:linear-gradient(#000,#000);-webkit-background-clip:text;background-clip:text;color:transparent',
    ),
  },
  {
    gate: 'contrast',
    what: 'readable text inside a 40% opacity ancestor',
    check: checkContrast,
    clean: probe('gate-solid', 0, 'background:#fff;color:#767676'),
    inject: probe('gate-faded', 30, 'background:#fff;color:#767676;opacity:.4'),
  },
  { gate: 'parity', what: 'a raw locale key as text', check: checkKeys, inject: html(`<p>${KEY}</p>`) },
  {
    gate: 'parity',
    what: 'a raw locale key in an aria-label',
    check: checkKeys,
    inject: html(`<button aria-label="${KEY}">x</button>`),
  },
  { gate: 'parity', what: 'a raw locale key in a title', check: checkKeys, inject: html(`<p title="${KEY}">x</p>`) },
  {
    gate: 'parity',
    what: 'a raw locale key in a placeholder',
    check: checkKeys,
    inject: html(`<input aria-label="field" placeholder="${KEY}">`),
  },
  {
    gate: 'motion',
    what: 'an infinite animation that ignores prefers-reduced-motion',
    check: checkMotion,
    inject: sheet('@keyframes selftest{to{opacity:.5}}body{animation:selftest 1s infinite !important}'),
    calm: true,
  },
  {
    gate: 'motion',
    what: 'an SVG animate element',
    check: checkMotion,
    inject: html(
      '<svg width="4" height="4"><rect width="2" height="2"><animate attributeName="x" from="0" to="2" dur="1s" repeatCount="indefinite"/></rect></svg>',
    ),
    calm: true,
  },
  {
    gate: 'motion',
    what: 'a requestAnimationFrame loop moving an element by transform',
    check: checkMotion,
    inject:
      "{ const el = document.createElement('div'); el.style.cssText = 'position:fixed;top:0;left:0;width:4px;height:4px'; document.body.append(el); let n = 0; const step = () => { el.style.transform = 'translateX(' + n++ + 'px)'; requestAnimationFrame(step); }; step(); }",
    calm: true,
  },
];

/**
 * Break each gate on a live page and require it to fail, so a gate that stops looking fails the lane.
 * @param {import('playwright').Browser} browser @param {string} url @param {string} [ready]
 */
export const selfTest = async (browser, url, ready = '[data-testid=rev]') => {
  /** @type {string[]} */
  const problems = [];
  for (const { gate, what, check, inject, clean: look, calm } of BREAKERS) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(calm ? { reducedMotion: /** @type {const} */ ('reduce') } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(`${url}/?lang=en`);
    await page.waitForSelector(ready);
    await sleep(SETTLE_MS);
    if (look !== undefined) await page.evaluate(look);
    const clean = await check(page, 'self-test clean');
    if (clean.problems.length > 0)
      problems.push(`${gate} gate fails on the unbroken page (${what}): ${clean.problems[0]}`);
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

/** @param {{ screen: string, notReady: string | null }[]} found */
export const notReadyLines = (found) =>
  found.filter((one) => one.notReady !== null).map((one) => `FAIL lane 11 ${one.screen}: ${one.notReady}`);

/** @param {import('playwright').Browser} browser */
export const runGateLane = async (browser) => {
  const hq = await startHqFree();
  try {
    await hq.post(human('add_worker', { worker: 'nova' }));
    const screens = ['main', ...registeredScreens()];
    /** @type {Array<{ screen: string, problems: string[], notes: string[], notReady: string | null }>} */
    const found = [];
    for (const screen of screens) {
      found.push({ screen, ...(await screenGates({ browser, url: hq.url, screen })) });
    }
    const broken = await selfTest(browser, hq.url);
    const problems = [...found.flatMap((one) => one.problems), ...broken];
    const notes = [...new Set(found.flatMap((one) => one.notes))];
    return {
      ok: problems.length === 0,
      lines: notReadyLines(found),
      note:
        problems.length === 0
          ? `${screens.join(', ')} pass axe, contrast, raw keys in en and th, reduced motion; ${BREAKERS.length} deliberately broken gates each failed${notes.length > 0 ? `; notes: ${notes.join('; ')}` : ''}`
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
    for (const line of verdict.lines) console.log(line);
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} lane 11 screen gates: ${verdict.note}`);
    const fixtures = await runFixtureLane(browser);
    console.log(`${fixtures.ok ? 'PASS' : 'FAIL'} lane 11b screen registry fixtures: ${fixtures.note}`);
    process.exitCode = verdict.ok && fixtures.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
