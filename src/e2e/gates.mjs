import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  contrastRatio,
  FIXTURE_FLAG,
  FIXTURE_PREFIX,
  human,
  interruptible,
  launch,
  NEEDS_CHIP,
  ROOT,
  runAxe,
  startHqFree,
  stopAllHq,
  within,
} from './harness.mjs';
import { restoreScreens, runFixtureLane } from './screen-fixture.mjs';

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
  const pageRoots = [
    document.documentElement,
    document.body,
    ...document.querySelectorAll('#root, [data-screen], main'),
  ];
  const entries = allow.map((entry) => {
    try {
      const matched = [...document.querySelectorAll(entry.selector)];
      return {
        selector: entry.selector,
        reason: entry.reason,
        count: matched.length,
        roots: matched.some((el) => pageRoots.some((root) => el.contains(root))),
        rows: 0,
        valid: true,
      };
    } catch {
      return { selector: entry.selector, reason: entry.reason, count: 0, roots: false, rows: 0, valid: false };
    }
  });
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
    const fg = norm(style.webkitTextFillColor || style.color);
    const opaqueFill = (fg[3] ?? 255) === 255;
    for (let up = /** @type {Element | null} */ (el); up !== null; up = up.parentElement) {
      const cs = getComputedStyle(up);
      opacity *= Number(cs.opacity);
      if (unknown || layers.some((layer) => layer[3] === 255)) continue;
      const clipsToText = cs.backgroundClip === 'text' || cs.getPropertyValue('-webkit-background-clip') === 'text';
      // A background clipped to the glyphs is covered by an opaque fill, so it is not behind the text at all. Only a see-through fill shows it.
      if (clipsToText && opaqueFill) continue;
      if (clipsToText) clipped = true;
      if (cs.backgroundImage !== 'none') unknown = true;
      const bg = norm(cs.backgroundColor);
      if ((bg[3] ?? 0) > 0) layers.push(bg);
    }
    if (!layers.some((layer) => layer[3] === 255)) layers.push([255, 255, 255, 255]);
    const index = rows.length;
    if (unknown || clipped) el.setAttribute('data-gate-i', `${el.getAttribute('data-gate-i') ?? ''} ${index}`.trim());
    for (const entry of entries) if (entry.valid && el.closest(entry.selector) !== null) entry.rows += 1;
    rows.push({
      text: text.slice(0, 40),
      html: el.outerHTML.slice(0, 160),
      fg: [fg[0], fg[1], fg[2], (fg[3] ?? 255) * opacity],
      layers,
      unknown: unknown || clipped,
      clipped,
      allowed: entries.find((entry) => entry.valid && el.closest(entry.selector) !== null)?.reason ?? '',
      allowedBy: entries.find((entry) => entry.valid && el.closest(entry.selector) !== null)?.selector ?? '',
    });
  }
  return { rows, entries };
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
  const visible = rects
    .map(([l = 0, t = 0, r = 0, b = 0]) => [
      Math.max(0, l),
      Math.max(0, t),
      Math.min(innerWidth, r),
      Math.min(innerHeight, b),
    ])
    .filter(([l = 0, t = 0, r = 0, b = 0]) => r > l && b > t);
  return visible.length === 0 ? null : visible;
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

/** The ratio as measured, unrounded: 4.495 is under the bar. */
/** @param {{ fg: number[], layers: number[][] }} row */
const exactRatio = ({ fg, layers }) => {
  const bg = flatten(layers);
  return contrastRatio(flatten([fg, bg]), bg);
};

/** The ratio rounded to two places, for display. The gate compares `exactRatio`. */
/** @param {{ fg: number[], layers: number[][] }} row */
export const rowRatio = (row) => Number(exactRatio(row).toFixed(2));

/** An allowlist entry that covers more text rows than this, or contains a page root, is too broad to be an allowlist entry. */
export const BROAD_ROW_LIMIT = 3;

/**
 * Broadness is decided by what a selector matches, not by how it is spelled: `p`, `BODY`, `[class]`, `:not(x)`, `html body`, `body *` and comma lists all count by what they reach.
 * @param {Array<{ selector: string, roots: boolean, rows: number, valid: boolean }>} entries each allowlist entry with whether a match contains a page root (html, body, #root, a screen wrapper or main) and how many text rows its matches cover
 * @param {string} label @returns {{ problems: string[], refused: string[] }}
 */
export const allowlistProblems = (entries, label) => {
  const problems = [];
  const refused = [];
  for (const { selector, roots, rows, valid } of entries) {
    const why = !valid
      ? 'is not a valid selector'
      : roots
        ? 'matches the whole page'
        : rows > BROAD_ROW_LIMIT
          ? `covers ${rows} text rows, more than ${BROAD_ROW_LIMIT}`
          : '';
    if (why === '') continue;
    refused.push(selector);
    problems.push(
      `${label} contrastAllow selector "${selector}" is too broad: it ${why}, so it excuses nothing; name the element`,
    );
  }
  return { problems, refused };
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
    ...pixels.map((pixel) => exactRatio({ fg: row.fg, layers: [[pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, 255]] })),
  );

/**
 * `behind` is the pixels sampled behind a row over a gradient or image, null when they could not be sampled.
 * A row nobody could measure (clipped to its own text, or its pixels could not be sampled) fails as `not measurable`, unless its screen allowlists it with a reason.
 * An allowlist entry never excuses text the sampler did measure: that text is judged by its pixels.
 * @param {Array<{ text: string, html: string, fg: number[], layers: number[][], unknown: boolean, clipped?: boolean, allowed?: string, behind?: number[][] | null }>} rows
 * @param {string} label
 * @returns {{ problems: string[], exceptions: string[], allowed: string[] }}
 */
export const contrastProblems = (rows, label) => {
  const problems = [];
  const exceptions = [];
  const allowed = [];
  for (const row of rows) {
    const unmeasured =
      row.clipped === true || row.behind === undefined || row.behind === null || row.behind.length === 0;
    if (row.unknown && unmeasured && row.allowed) {
      allowed.push(`${label} "${row.text}" over a gradient or image is allowlisted: ${row.allowed}`);
      continue;
    }
    if (row.unknown && unmeasured) {
      problems.push(
        `${label} "${row.text}" over a gradient or image is not measurable, and its screen does not allowlist it`,
      );
      continue;
    }
    const ratio = row.unknown ? behindRatio(row, row.behind ?? []) : exactRatio(row);
    if (ratio >= MIN_CONTRAST) continue;
    const found = `${label} "${row.text}" ${Number(ratio.toFixed(3))}:1, needs ${MIN_CONTRAST}:1`;
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
  const { rows, entries } = await page.evaluate(COLLECT_TEXT, allow);
  const broad = allowlistProblems(entries, label);
  for (const row of rows) if (broad.refused.includes(row.allowedBy)) row.allowed = '';
  await measureBehind(page, rows);
  const out = contrastProblems(rows, label);
  return {
    problems: [...broad.problems, ...out.problems],
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

const MOVING = [
  'transform',
  'translate',
  'rotate',
  'scale',
  'opacity',
  'left',
  'top',
  'right',
  'bottom',
  'margin-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'filter',
];

/** A page opened with `reducedMotion: 'reduce'`. Samples every 100 ms for 1.2 s after the settle. */
/** @param {import('playwright').Page} page @param {string} label */
export const checkMotion = async (page, label) => {
  const sample = (/** @type {string[]} */ props) => {
    const w = /** @type {any} */ (window);
    w.__gateIds = w.__gateIds ?? new WeakMap();
    const ids = w.__gateIds;
    const styles = {};
    for (const el of document.body.querySelectorAll('*')) {
      if (!ids.has(el)) ids.set(el, ids.size);
      const inSvg = el.closest('svg') !== null;
      const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '');
      const name = `${el.tagName.toLowerCase()}${cls !== '' ? `.${cls.split(' ')[0]}` : ''}`;
      // Inside an SVG a script moves things with the transform attribute, so that is what is watched there.
      styles[ids.get(el)] = [
        name,
        inSvg
          ? `${el.getAttribute('transform') ?? ''}|${getComputedStyle(el).getPropertyValue('transform')}`
          : props.map((prop) => getComputedStyle(el).getPropertyValue(prop)).join('|'),
      ];
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
  {
    gate: 'contrast',
    what: 'readable text whose faded 40% opacity is on an ancestor, not on the text element',
    check: checkContrast,
    clean: styled(
      `.gate-wrap-ok{${BOX}top:90px;background:#fff}.gate-wrap-ok p{margin:0;color:#767676}`,
      '<div class="gate-wrap-ok"><p>wrapped</p></div>',
    ),
    inject: styled(
      `.gate-wrap{${BOX}top:120px;background:#fff;opacity:.4}.gate-wrap p{margin:0;color:#767676}`,
      '<div class="gate-wrap"><p>wrapped</p></div>',
    ),
  },
  {
    gate: 'contrast',
    what: 'text #767676 over a gradient from #fff to #777, where only the dark end is under 4.5 to 1',
    check: checkContrast,
    clean: probe('gate-two-ok', 150, 'width:max-content;background-image:linear-gradient(90deg,#fff,#eee);color:#555'),
    inject: probe(
      'gate-two',
      180,
      'width:max-content;background-image:linear-gradient(90deg,#fff,#777);color:#767676',
      'a long line of text that crosses the whole gradient',
    ),
  },
  {
    gate: 'contrast',
    what: 'text under stacked translucent backgrounds that together make it unreadable',
    check: checkContrast,
    clean: styled(
      `.gate-stack-ok{${BOX}top:270px;background:rgba(0,0,0,.5)}.gate-stack-ok p{margin:0;background:rgba(0,0,0,.5);color:#fff}`,
      '<div class="gate-stack-ok"><p>stacked</p></div>',
    ),
    inject: styled(
      `.gate-stack{${BOX}top:300px;background:rgba(0,0,0,.6)}.gate-stack p{margin:0;background:rgba(0,0,0,.3);color:#000}`,
      '<div class="gate-stack"><p>stacked</p></div>',
    ),
  },
  {
    gate: 'contrast',
    what: 'an allowlist entry that reaches more than 3 text rows of clipped text',
    check: async (page, label) =>
      checkContrast(
        page,
        label,
        (await page.$('.gate-rows')) === null ? [] : [{ selector: '.gate-rows', reason: 'because' }],
      ),
    inject: styled(
      `.gate-rows{${BOX}top:330px;background-image:linear-gradient(#000,#000);-webkit-background-clip:text;background-clip:text;color:transparent}`,
      '<div class="gate-rows"><p>one</p><p>two</p><p>three</p><p>four</p></div>',
    ),
  },
  {
    gate: 'contrast',
    what: 'an allowlist of `html body` on clipped text it cannot measure',
    check: async (page, label) =>
      checkContrast(
        page,
        label,
        (await page.$('.gate-star2')) === null ? [] : [{ selector: 'html body', reason: 'because' }],
      ),
    inject: probe(
      'gate-star2',
      360,
      'background-image:linear-gradient(#000,#000);-webkit-background-clip:text;background-clip:text;color:transparent',
    ),
  },
  {
    gate: 'contrast',
    what: 'text clipped to a gradient with an opaque fill, which is plain text on a plain background and must pass',
    check: checkContrast,
    clean: styled(
      `.gate-fill-ok{${BOX}top:390px;background:#fff}.gate-fill-ok p{margin:0;background-image:linear-gradient(#000,#000);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:#111;color:#111}`,
      '<div class="gate-fill-ok"><p>opaque fill</p></div>',
    ),
    inject: probe('gate-fill-bad', 420, 'background:#fff;color:#bbb'),
  },
  {
    gate: 'contrast',
    what: 'light grey text over a gradient whose rects run below the viewport',
    check: checkContrast,
    clean: probe(
      'gate-off-ok',
      870,
      'height:80px;background-image:linear-gradient(#fff,#fff);color:#222',
      'x<br>y<br>z',
    ),
    inject: probe(
      'gate-off-bad',
      885,
      'height:80px;background-image:linear-gradient(#fff,#fff);color:#bbb',
      'x<br>y<br>z',
    ),
  },
  {
    gate: 'contrast',
    what: 'an allowlist of `*` on clipped text it cannot measure',
    check: async (page, label) =>
      checkContrast(page, label, (await page.$('.gate-star')) === null ? [] : [{ selector: '*', reason: 'because' }]),
    inject: probe(
      'gate-star',
      210,
      'background-image:linear-gradient(#000,#000);-webkit-background-clip:text;background-clip:text;color:transparent',
    ),
  },
  {
    gate: 'contrast',
    what: 'an allowlist entry on light grey text over a gradient that the sampler can measure',
    check: (page, label) => checkContrast(page, label, [{ selector: '.gate-excused', reason: 'it is fine' }]),
    inject: probe('gate-excused', 240, 'background-image:linear-gradient(#fff,#fff);color:#bbb'),
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
    what: 'a running CSS transition on a property the sampler does not compare',
    check: checkMotion,
    inject:
      "{ const s = new CSSStyleSheet(); s.replaceSync('.gate-tr{width:4px;height:4px;background:#000;transition:background-color 30s linear}.gate-tr.on{background:#fff}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; const el = document.createElement('div'); el.className = 'gate-tr'; document.body.append(el); getComputedStyle(el).backgroundColor; el.classList.add('on'); }",
    calm: true,
  },
  {
    gate: 'motion',
    what: 'an el.animate() loop on a property the sampler does not compare',
    check: checkMotion,
    inject:
      "{ const el = document.createElement('div'); el.style.cssText = 'width:4px;height:4px'; document.body.append(el); el.animate([{ backgroundColor: '#000' }, { backgroundColor: '#fff' }], { duration: 1000, iterations: Infinity }); }",
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
    what: 'a requestAnimationFrame loop moving an element by margin-left',
    check: checkMotion,
    inject:
      "{ const el = document.createElement('div'); el.style.cssText = 'width:4px;height:4px'; document.body.append(el); let n = 0; const step = () => { el.style.marginLeft = (n++ % 40) + 'px'; requestAnimationFrame(step); }; step(); }",
    calm: true,
  },
  {
    gate: 'motion',
    what: 'a requestAnimationFrame loop moving an SVG element by its transform attribute',
    check: checkMotion,
    inject:
      "{ const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', '8'); svg.setAttribute('height', '8'); const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); rect.setAttribute('width', '2'); rect.setAttribute('height', '2'); svg.append(rect); document.body.append(svg); let n = 0; const step = () => { rect.setAttribute('transform', 'translate(' + (n++ % 4) + ' 0)'); requestAnimationFrame(step); }; step(); }",
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

/** Screens other than the floor: every `src/screens/<id>/screen.tsx`. The synthetic `zz-gate-*` ones count only while lane 11b sets the flag, so a leftover from a killed run is never gated as a real screen. */
export const registeredScreens = (dir = join(ROOT, 'src', 'screens'), env = process.env) => {
  const synthetic = env[FIXTURE_FLAG] === '1';
  return existsSync(dir)
    ? readdirSync(dir).filter(
        (id) => (synthetic || !id.startsWith(FIXTURE_PREFIX)) && existsSync(join(dir, id, 'screen.tsx')),
      )
    : [];
};

/** @param {{ screen: string, notReady: string | null }[]} found */
export const notReadyLines = (found) =>
  found.filter((one) => one.notReady !== null).map((one) => `FAIL lane 11 ${one.screen}: ${one.notReady}`);

/** @param {import('playwright').Browser} browser */
export const runGateLane = async (browser) => {
  restoreScreens();
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
  // Playwright would answer SIGINT and SIGTERM itself, close the browser and exit at once. This run has files and an HQ to clean up first.
  const browser = await launch({ handleSIGINT: false, handleSIGTERM: false });
  /** An interrupted run stops the HQ it started, removes the synthetic screens and rebuilds `src/dist` without them. A second signal exits at once. */
  const interrupt = interruptible({
    cleanup: async () => {
      try {
        await stopAllHq();
        await within(
          browser.close().catch(() => {}),
          10_000,
        );
      } finally {
        restoreScreens();
      }
    },
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', interrupt.on(130));
  process.on('SIGTERM', interrupt.on(143));
  try {
    const verdict = await runGateLane(browser);
    for (const line of verdict.lines) console.log(line);
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} lane 11 screen gates: ${verdict.note}`);
    const fixtures = await runFixtureLane(browser);
    console.log(`${fixtures.ok ? 'PASS' : 'FAIL'} lane 11b screen registry fixtures: ${fixtures.note}`);
    process.exitCode = verdict.ok && fixtures.ok ? 0 : 1;
  } catch (error) {
    // Stopping the HQ under a running lane makes it throw. The signal handler is cleaning up and exits, so that error is not the verdict.
    if (!interrupt.stopping) throw error;
    await new Promise(() => {});
  } finally {
    if (!interrupt.stopping) await within(browser.close(), 10_000);
  }
}
