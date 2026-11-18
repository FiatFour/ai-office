import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const THRESHOLD = 40;
export const GRID = { cols: 12, rows: 9 };

/** @typedef {Record<string, string>} Inventory */

const EXTRACT = (/** @type {{ anims: string[] }} */ { anims }) => {
  const out = /** @type {Record<string, string>} */ ({});
  const put = (/** @type {string} */ family, /** @type {string} */ key, value = '1') => {
    out[`${family}:${key}`] = value;
  };
  const ZONES = [
    ['dispatch', 97, 47, 144, 104],
    ['break', 144, 47, 210, 104],
    ['firewall', 210, 47, 270, 104],
    ['prrack', 270, 47, 321, 104],
    ['dock', 321, 47, 393, 245],
    ['stations', 249, 103, 321, 247],
    ['line1', 185, 111, 337, 142],
    ['line2', 185, 155, 337, 186],
    ['line3', 185, 199, 337, 230],
    ['cage1', 97, 103, 142, 149],
    ['cage2', 142, 103, 187, 149],
    ['cage3', 97, 147, 142, 193],
    ['cage4', 142, 147, 187, 193],
    ['cage5', 97, 191, 142, 239],
    ['cage6', 142, 191, 187, 239],
  ];
  const STATIONS = [
    ['ORDER', 202],
    ['CODE', 250],
    ['TEST', 276],
    ['QC', 305],
    ['MERGE', 322],
    ['SHIPPING', 1e9],
  ];
  const BOX_FILLS = new Set(['#42a5f5', '#ef5350', '#ffca28', '#9aa1ab', '#66bb6a']);
  const SHAPES = new Set(['rect', 'ellipse', 'circle', 'path', 'line', 'polygon', 'polyline', 'text', 'use']);
  const NEVER = new Set([
    'script',
    'style',
    'head',
    'meta',
    'link',
    'title',
    'defs',
    'pattern',
    'symbol',
    'option',
    'noscript',
  ]);
  const hex = (/** @type {string} */ value) => {
    const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (m === null) return value.replace(/url\("?#([^")]+)"?\)/, 'pattern:$1');
    const [r = 0, g = 0, b = 0, a = 1] = (m[1] ?? '').split(/[ ,/]+/).map(Number);
    if (a === 0) return '';
    const base = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    return a < 1 ? `${base}@${Math.round(a * 100)}` : base;
  };
  const bucket = (/** @type {number} */ v) => Math.round(v / 4) * 4;
  const opacityCache = new WeakMap();
  const opacityOf = (/** @type {Element | null} */ node) => {
    if (node === null) return 1;
    const known = opacityCache.get(node);
    if (known !== undefined) return known;
    const value = Number(getComputedStyle(node).opacity) * opacityOf(node.parentElement);
    opacityCache.set(node, value);
    return value;
  };

  const scene = [...document.querySelectorAll('svg')].find((svg) => svg.getAttribute('viewBox') === '0 0 480 270');
  const frame = scene?.getBoundingClientRect();
  const units = (/** @type {DOMRect} */ r) => {
    if (frame === undefined) return [0, 0, 0, 0];
    const k = 480 / frame.width;
    return [(r.left - frame.left) * k, (r.top - frame.top) * k, r.width * k, r.height * k];
  };
  const zoneOf = (/** @type {number[]} */ [x = 0, y = 0, w = 0, h = 0]) =>
    ZONES.find(
      ([, x0, y0, x1, y1]) => x >= Number(x0) && y >= Number(y0) && x + w <= Number(x1) && y + h <= Number(y1),
    )?.[0] ?? 'floor';

  const shapes = /** @type {Map<string, string[]>} */ (new Map());
  const counts = /** @type {Map<string, number>} */ (new Map());
  const boxes = Object.fromEntries(STATIONS.map(([name]) => [name, 0]));
  const addPaint = (
    /** @type {string} */ zone,
    /** @type {string} */ tag,
    /** @type {string} */ channel,
    /** @type {string} */ value,
  ) => {
    if (value !== '' && value !== 'none') put('paint', `${zone}:${tag}:${channel}:${value}`);
  };

  for (const node of document.body.querySelectorAll('*')) {
    const tag = node.localName;
    if (NEVER.has(tag) || node.closest('defs, pattern, symbol, select')) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || opacityOf(node) < 0.05) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const inScene = scene?.contains(node) === true && node !== scene;
    const own = [...node.childNodes]
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (scene?.contains(node) === true) for (const token of node.classList) put('class', token);
    const role = node.getAttribute('role');
    if (role !== null) put('role', `aria:${role}`);

    if (inScene) {
      if (!SHAPES.has(tag)) continue;
      const box = units(rect);
      const zone = zoneOf(box);
      const fill = hex(style.fill);
      const stroke = style.stroke === 'none' ? '' : hex(style.stroke);
      const name = tag === 'use' ? `use${node.getAttribute('href')}` : tag;
      const list = shapes.get(`${zone}:${name}`) ?? [];
      list.push(box.map(bucket).join(','));
      shapes.set(`${zone}:${name}`, list);
      const kind = tag === 'text' ? 'text' : 'shape';
      addPaint(zone, kind, 'fill', fill);
      addPaint(zone, kind, 'stroke', stroke);
      if (fill === 'pattern:haz') put('role', `stripe:${zone}`);
      if (/^#ff[0-9a-f]{4}$/.test(fill) && box[3] !== undefined && box[3] <= 2 && (box[2] ?? 0) > 20)
        put('role', `laser:${zone}`);
      if (tag === 'rect' && fill === '#ffca28' && Math.abs((box[2] ?? 0) - 5) <= 1 && Math.abs((box[3] ?? 0) - 7) <= 1)
        put('role', 'bubble');
      if (tag === 'rect' && (box[2] ?? 9) <= 3 && (box[3] ?? 9) <= 3 && fill !== '') put('role', `led:${zone}`);
      if (
        tag === 'rect' &&
        Math.abs((box[2] ?? 0) - 9) <= 1 &&
        Math.abs((box[3] ?? 0) - 8) <= 1 &&
        BOX_FILLS.has(fill)
      ) {
        const station = STATIONS.find(([, limit]) => (box[0] ?? 0) + 4.5 < Number(limit))?.[0] ?? 'SHIPPING';
        boxes[station] = (boxes[station] ?? 0) + 1;
      }
      if (tag === 'text') {
        if (own !== '') put('text', own.toLowerCase().replace(/\d+/g, '#'));
        const family = style.fontFamily.split(',')[0]?.replace(/["']/g, '').trim().toLowerCase();
        put('font', `svg:${family}:${style.fontSize}`);
        if (own.length <= 2 && own !== '') put('role', `glyph:${zone}:${own.toLowerCase()}`);
      }
      continue;
    }

    const kind = tag === 'svg' || tag === 'img' || tag === 'canvas' ? 'icon' : tag;
    if (kind === 'icon') put('role', 'icon');
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    addPaint('dom', kind, 'bg', hex(style.backgroundColor));
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
      if (width > 0 && style.getPropertyValue(`border-${side}-style`) !== 'none')
        addPaint('dom', kind, `border-${side}`, hex(style.getPropertyValue(`border-${side}-color`)));
    }
    const shown =
      tag === 'select' ? /** @type {HTMLSelectElement} */ (node.selectedOptions[0]?.textContent ?? '') : own;
    if (shown.trim() !== '') {
      put('text', shown.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\d+/g, '#'));
      addPaint('dom', kind, 'color', hex(style.color));
      const family = style.fontFamily.split(',')[0]?.replace(/["']/g, '').trim().toLowerCase();
      put('font', `dom:${family}:${style.fontSize}`);
    }
  }

  for (const [key, list] of shapes) {
    const [zone = '', name = ''] = key.split(':');
    let hash = 2166136261;
    for (const char of list.sort().join(' ')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    put('shape', `${zone}:${name}`, `n=${list.length} #${hash.toString(16)}`);
  }
  for (const [kind, n] of counts) put('shape', `dom:${kind}`, `n=${n}`);
  for (const [name, n] of Object.entries(boxes)) put('boxes', name, String(n));
  for (const name of anims) put('anim', name);
  return out;
};

const ANIMATIONS = () => {
  const names = new Set();
  for (const node of document.body.querySelectorAll('*'))
    for (const name of getComputedStyle(node).animationName.split(','))
      if (name.trim() !== 'none') names.add(name.trim());
  return [...names];
};

/**
 * @template T
 * @param {import('playwright').Page} page
 * @param {() => Promise<T>} run
 */
export const still = async (page, run) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    return await run();
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
};

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<Inventory>}
 */
export const collect = async (page) => {
  const anims = await page.evaluate(ANIMATIONS);
  return still(page, () => page.evaluate(EXTRACT, { anims }));
};

/** @param {Inventory[]} parts first part wins for valued keys */
export const merge = (...parts) => Object.assign({}, ...[...parts].reverse());

/** @param {Inventory} inventory @param {string[]} families */
export const only = (inventory, families) =>
  Object.fromEntries(Object.entries(inventory).filter(([key]) => families.includes(key.split(':')[0] ?? '')));

/** @param {import('playwright').Page} page @param {string} path */
export const shoot = (page, path) => still(page, () => page.screenshot({ path }));

/**
 * @param {Inventory} canvas
 * @param {Inventory} built
 */
export const diffInventory = (canvas, built) => {
  const canvasOnly = Object.keys(canvas).filter((key) => !(key in built));
  const builtOnly = Object.keys(built).filter((key) => !(key in canvas));
  const changed = Object.keys(canvas).filter((key) => key in built && canvas[key] !== built[key]);
  return { canvasOnly: canvasOnly.sort(), builtOnly: builtOnly.sort(), changed: changed.sort() };
};

/**
 * @param {ReturnType<typeof diffInventory>} diff
 * @param {Inventory} canvas
 * @param {Inventory} built
 * @param {Array<{ id: string, status: string, covers: string[] }>} entries
 */
export const checkCoverage = (diff, canvas, built, entries) => {
  const problems = [];
  const different = new Map([
    ...diff.canvasOnly.map((key) => [key, 'canvas-only']),
    ...diff.builtOnly.map((key) => [key, 'built-only']),
    ...diff.changed.map((key) => [key, 'changed']),
  ]);
  const owners = new Map();
  for (const entry of entries)
    for (const key of entry.covers) {
      if (owners.has(key)) problems.push(`${key} is covered by both ${owners.get(key)} and ${entry.id}`);
      owners.set(key, entry.id);
    }
  const covered = new Set(owners.keys());
  for (const key of different.keys()) if (!covered.has(key)) problems.push(`uncovered ${different.get(key)} ${key}`);
  for (const entry of entries) {
    for (const key of entry.covers) {
      const kind = different.get(key);
      if (entry.status === 'fixed') {
        if (!(key in canvas) || !(key in built)) problems.push(`${entry.id}: fixed but ${key} is not on both sides`);
        else if (kind !== undefined) problems.push(`${entry.id}: fixed but ${key} is still ${kind}`);
        continue;
      }
      if (kind === undefined) problems.push(`${entry.id}: stale, ${key} is no longer different`);
      else if (entry.status === 'not-built' && kind === 'built-only')
        problems.push(`${entry.id}: not-built but ${key} is built-only`);
    }
  }
  return problems;
};

/** @param {string} text */
export const parseRegions = (text) => {
  const m = /^R(\d+)-(\d+)C(\d+)-(\d+)$/.exec(text.trim());
  if (m === null) return null;
  const [r0, r1, c0, c1] = m.slice(1).map(Number);
  return { r0: r0 ?? 0, r1: r1 ?? 0, c0: c0 ?? 0, c1: c1 ?? 0 };
};

const PIXELS = async (
  /** @type {{ a: string, b: string, cols: number, rows: number, heat: boolean }} */ { a, b, cols, rows, heat },
) => {
  const load = (/** @type {string} */ src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  const [left, right] = /** @type {HTMLImageElement[]} */ (await Promise.all([load(a), load(b)]));
  const [w, h] = [Math.min(left.width, right.width), Math.min(left.height, right.height)];
  const data = (/** @type {HTMLImageElement} */ image) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, w, h).data;
  };
  const [pa, pb] = [data(left), data(right)];
  const [cw, ch] = [Math.floor(w / cols), Math.floor(h / rows)];
  const grid = [];
  for (let row = 0; row < rows; row += 1) {
    const line = [];
    for (let col = 0; col < cols; col += 1) {
      const sum = [0, 0, 0, 0, 0, 0];
      for (let y = row * ch; y < (row + 1) * ch; y += 1)
        for (let x = col * cw; x < (col + 1) * cw; x += 1) {
          const i = (y * w + x) * 4;
          for (let k = 0; k < 3; k += 1) {
            sum[k] = (sum[k] ?? 0) + (pa[i + k] ?? 0);
            sum[k + 3] = (sum[k + 3] ?? 0) + (pb[i + k] ?? 0);
          }
        }
      const n = cw * ch;
      line.push(Math.round(Math.hypot(...[0, 1, 2].map((k) => ((sum[k] ?? 0) - (sum[k + 3] ?? 0)) / n))));
    }
    grid.push(line);
  }
  let png = '';
  if (heat) {
    const out = document.createElement('canvas');
    out.width = cols * 60;
    out.height = rows * 50 + 0;
    const context = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
    context.font = '14px sans-serif';
    for (const [row, line] of grid.entries())
      for (const [col, value] of line.entries()) {
        const t = Math.min(1, value / 200);
        context.fillStyle = `rgb(${Math.round(255 * t)},${Math.round(200 * (1 - t))},60)`;
        context.fillRect(col * 60, row * 50, 60, 50);
        context.fillStyle = '#111';
        context.fillText(String(value), col * 60 + 8, row * 50 + 30);
        context.strokeStyle = '#111';
        context.strokeRect(col * 60, row * 50, 60, 50);
      }
    png = out.toDataURL('image/png');
  }
  return { grid, png };
};

/**
 * @param {import('playwright').Page} page
 * @param {string} canvasShot
 * @param {string} builtShot
 * @param {boolean} [heat]
 */
export const pixelGrid = (page, canvasShot, builtShot, heat = false) => {
  const url = (/** @type {string} */ file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  return page.evaluate(PIXELS, { a: url(canvasShot), b: url(builtShot), ...GRID, heat });
};

/** @param {number[][]} grid */
export const hotCells = (grid) =>
  grid.flatMap((line, row) =>
    line.flatMap((value, col) => (value > THRESHOLD ? [{ row: row + 1, col: col + 1, value }] : [])),
  );

/** @param {number[][]} grid @param {Array<{ id: string, regions: string[] }>} entries */
export const uncoveredCells = (grid, entries) => {
  const boxes = entries.flatMap((entry) => entry.regions.map(parseRegions)).filter((box) => box !== null);
  return hotCells(grid).filter(
    ({ row, col }) => !boxes.some((box) => row >= box.r0 && row <= box.r1 && col >= box.c0 && col <= box.c1),
  );
};

/** @param {number[][]} grid */
export const gridMarkdown = (grid) =>
  [
    `Mean colour distance (0 to 441) per ${GRID.cols} by ${GRID.rows} cell of the 1440 by 900 canvas render against the built floor, cells above ${THRESHOLD} must be inside a \`regions:\` list of an entry in P1-3-canvas-differences.md.`,
    '',
    `| row | ${grid[0]?.map((_, col) => `C${col + 1}`).join(' | ')} |`,
    `| --- | ${grid[0]?.map(() => '---').join(' | ')} |`,
    ...grid.map((line, row) => `| R${row + 1} | ${line.map((v) => (v > THRESHOLD ? `**${v}**` : v)).join(' | ')} |`),
  ].join('\n');

export const writeHeat = (/** @type {string} */ file, /** @type {string} */ dataUrl) =>
  writeFileSync(file, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error('usage: node src/scripts/inventory.mjs <lane 9 output dir>');
  const read = (/** @type {string} */ name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const diff = diffInventory(read('inventory-canvas.json'), read('inventory-built.json'));
  console.log(
    [
      ...diff.canvasOnly.map((key) => `canvas-only ${key}`),
      ...diff.builtOnly.map((key) => `built-only ${key}`),
      ...diff.changed.map((key) => `changed ${key}`),
    ].join('\n'),
  );
}
