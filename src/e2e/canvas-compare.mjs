import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkCoverage,
  collect,
  diffInventory,
  GRID,
  gridMarkdown,
  hotCells,
  merge,
  only,
  pixelGrid,
  shoot,
  uncoveredCells,
  writeHeat,
} from '../scripts/inventory.mjs';
import { renderCanvas } from './canvas.mjs';
import { OUT, ROOT } from './harness.mjs';

export const DIFFERENCES = join(ROOT, 'docs', 'review', 'P1-3-canvas-differences.md');
export const PR_BODY = join(ROOT, 'docs', 'review', 'P1-3-pr-body.md');
export const ADR = join(ROOT, 'docs', 'decisions', '0005-floor-view-and-demo-replay.md');
export const COMMITTED_COMPARE = join(ROOT, 'docs', 'review', 'P1-3-review-canvas-compare.png');
export const COMMITTED_HEAT = join(ROOT, 'docs', 'review', 'P1-3-review-pixel-heatmap.png');
export const COMMITTED_GRID = join(ROOT, 'docs', 'review', 'P1-3-review-pixel-regions.md');

export const STATUSES = ['fixed', 'changed', 'not-built', 'conflict'];
export const BLOCK = /<!-- differences:start -->\n([\s\S]*?)\n?<!-- differences:end -->/;
const COMPARE = { width: 1440, pane: 720, paneHeight: 450, legend: 150 };
const STRIPS = { canvas: [255, 0, 230], built: [0, 230, 255] };
const SHARED_FAMILIES = ['text', 'paint', 'font', 'role', 'class', 'anim'];

/** @typedef {{ id: string, status: string, canvas: string, built: string, text: string, covers: string[], regions: string[] }} Entry */
/** @typedef {{ text: string, canvasText: string, builtText: string, canvasInv: Record<string, string>, builtInv: Record<string, string>, grid: number[][], body: string, adr: string, warn: string | null }} Inputs */

export const markdown = (/** @type {Entry[]} */ diffs) =>
  [
    '| id | status | what differs |',
    '| --- | --- | --- |',
    ...diffs.map((d) => `| ${d.id} | ${d.status} | ${d.text.replace(/\|/g, '/')} |`),
  ].join('\n');

/** @param {string} text @returns {Entry[]} */
export const parseDifferences = (text) => {
  /** @type {Entry[]} */
  const entries = [];
  for (const line of text.split('\n')) {
    if (/^D\d+ \|/.test(line)) {
      const [id = '', status = '', canvas = '', built = '', ...rest] = line.split(' | ').map((part) => part.trim());
      entries.push({
        id,
        status,
        canvas: canvas === '-' ? '' : canvas,
        built: built === '-' ? '' : built,
        text: rest.join(' | '),
        covers: [],
        regions: [],
      });
      continue;
    }
    const last = entries.at(-1);
    const m = /^ {2}(covers|regions): (.*)$/.exec(line);
    if (last === undefined || m === null) continue;
    const covers = m[1] === 'covers';
    (covers ? last.covers : last.regions).push(
      ...(m[2] ?? '')
        .split(covers ? ' ;; ' : ', ')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    );
  }
  return entries;
};

const bytes = (/** @type {string} */ file) => readFileSync(file).toString('base64');

export const textOf = (/** @type {import('playwright').Page} */ page) =>
  page.evaluate(() =>
    `${document.body.textContent}\n${[...document.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')).join('\n')}`.toLowerCase(),
  );

const anchors = (/** @type {import('playwright').Page} */ page, /** @type {string[]} */ probes) =>
  page.evaluate((list) => {
    const found = {};
    const all = [...document.querySelectorAll('body *')];
    for (const probe of list) {
      const wanted = probe.toLowerCase();
      const node = all.find((candidate) =>
        [...candidate.childNodes].some(
          (child) => child.nodeType === 3 && (child.textContent ?? '').toLowerCase().includes(wanted),
        ),
      );
      if (node === undefined) continue;
      const box = node.getBoundingClientRect();
      if (box.width > 0)
        found[probe] = { x: box.left + window.scrollX, y: box.top + window.scrollY, w: box.width, h: box.height };
    }
    return found;
  }, probes);

/** @param {Inputs} input */
export const verifyEntries = ({ text, canvasText, builtText, canvasInv, builtInv, grid, body, adr, warn }) => {
  const problems = [];
  const diffs = parseDifferences(text);
  const ids = diffs.map((d) => d.id);
  if (diffs.length < 40) problems.push(`only ${diffs.length} differences listed`);
  if (new Set(ids).size !== ids.length) problems.push('duplicate ids');
  for (const d of diffs) if (!STATUSES.includes(d.status)) problems.push(`${d.id}: status ${d.status}`);
  for (const d of diffs) {
    const [canvas, built] = [d.canvas.toLowerCase(), d.built.toLowerCase()];
    if (canvas !== '' && !canvasText.includes(canvas))
      problems.push(`${d.id}: "${d.canvas}" is not on the canvas artboard`);
    if (d.status === 'not-built' && canvas !== '' && builtText.includes(canvas))
      problems.push(`${d.id}: "${d.canvas}" is on the built floor, not "not-built"`);
    if (d.status === 'fixed' && !builtText.includes(canvas))
      problems.push(`${d.id}: "${d.canvas}" is missing from the built floor, not "fixed"`);
    if ((d.status === 'changed' || d.status === 'conflict') && built !== '' && !builtText.includes(built))
      problems.push(`${d.id}: "${d.built}" is not on the built floor`);
  }
  for (const [name, doc] of [
    ['the PR body source', body],
    ['ADR 0005', adr],
  ]) {
    for (const id of ids) if (!new RegExp(`\\b${id}\\b`).test(doc)) problems.push(`${id} is not in ${name}`);
    if (BLOCK.exec(doc)?.[1] !== markdown(diffs))
      problems.push(`the table in ${name} is stale, run node src/scripts/differences.mjs`);
  }
  if (warn !== 'rgb(255, 202, 40)') problems.push(`N NEED YOU colour is ${warn}, the canvas has #ffca28`);

  problems.push(...checkCoverage(diffInventory(canvasInv, builtInv), canvasInv, builtInv, diffs));
  for (const region of diffs.flatMap((d) => d.regions))
    if (!/^R[1-9]-[1-9]C(?:[1-9]|1[0-2])-(?:[1-9]|1[0-2])$/.test(region)) problems.push(`bad region ${region}`);
  for (const { row, col, value } of uncoveredCells(grid, diffs))
    problems.push(`uncovered region R${row}C${col} distance ${value}`);
  return problems;
};

const LAYOUT = (/** @type {{ url: string, strips: Record<string, number[]> }} */ { url, strips }) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = reject;
    image.onload = () => {
      const [width, height] = [image.width, image.height];
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, width, height).data;
      const is = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ rgb) =>
        [0, 1, 2].every((k) => Math.abs((data[(y * width + x) * 4 + k] ?? 0) - (rgb[k] ?? 0)) <= 2);
      const panes = {};
      for (const [name, rgb] of Object.entries(strips)) {
        const probe = Math.floor(width / 4) * (name === 'canvas' ? 1 : 3);
        const rows = [];
        for (let y = 0; y < height; y += 1) if (is(probe, y, rgb)) rows.push(y);
        const y0 = rows[0];
        if (y0 === undefined) continue;
        let [x0, x1] = [width, -1];
        for (let x = 0; x < width; x += 1)
          if (is(x, y0, rgb)) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
          }
        panes[name] = { x0, x1, y0, y1: rows.at(-1) };
      }
      resolve({ width, height, panes });
    };
    image.src = url;
  });

/** @param {import('playwright').Page} page @param {string} file */
export const readLayout = (page, file) =>
  page.evaluate(LAYOUT, { url: `data:image/png;base64,${bytes(file)}`, strips: STRIPS });

/** @param {{ width: number, height: number, panes: Record<string, { x0: number, x1: number, y0: number, y1: number }> }} layout @param {string} label */
export const layoutProblems = (layout, label) => {
  const { canvas, built } = layout.panes;
  if (canvas === undefined || built === undefined) return [`${label}: no two panes with their marker strips`];
  const out = [];
  const [cw, bw] = [canvas.x1 - canvas.x0 + 1, built.x1 - built.x0 + 1];
  if (layout.width !== COMPARE.width) out.push(`${label}: width ${layout.width}, not ${COMPARE.width}`);
  if (cw !== bw || cw !== COMPARE.pane) out.push(`${label}: pane widths ${cw} and ${bw}, not ${COMPARE.pane} each`);
  if (canvas.x1 + 1 !== built.x0) out.push(`${label}: the panes are not side by side`);
  if (canvas.y0 !== built.y0 || canvas.y1 !== built.y1 || canvas.y1 - canvas.y0 < COMPARE.paneHeight)
    out.push(`${label}: pane heights differ or are under ${COMPARE.paneHeight}`);
  if (layout.height - canvas.y1 < COMPARE.legend) out.push(`${label}: legend under ${COMPARE.legend} px`);
  return out;
};

/**
 * @param {import('playwright').Page} page
 * @param {{ canvasShot: string, builtShot: string, left: string, right: string, legend: string, out: string }} input
 */
const compose = async (page, { canvasShot, builtShot, left, right, legend, out }) => {
  const img = (/** @type {string} */ file) => `data:image/png;base64,${bytes(file)}`;
  const strip = (/** @type {number[]} */ rgb) => `<div class="strip" style="background:rgb(${rgb.join(',')})"></div>`;
  await page.setViewportSize({ width: COMPARE.width, height: 400 });
  await page.setContent(
    `<style>
body{margin:0;background:#101214;color:#e3e6ea;font:12px/1.25 system-ui,sans-serif;width:${COMPARE.width}px}
h2{margin:6px 8px;font:700 14px system-ui}
.row{display:flex;gap:0}.pane{width:${COMPARE.pane}px}.strip{height:4px;width:${COMPARE.pane}px}
.cell{position:relative;width:${COMPARE.pane}px;height:${COMPARE.paneHeight}px;overflow:hidden}
.cell img{width:${COMPARE.pane}px;display:block}
i{position:absolute;min-width:16px;padding:0 3px;height:16px;line-height:16px;text-align:center;font:700 11px system-ui;font-style:normal;border:1.5px solid #15181c;color:#15181c;z-index:2}
i.c{background:#ffca28}i.b{background:#66bb6a}
ul{columns:2;column-gap:14px;margin:6px 8px 10px;padding:0;list-style:none}
li{break-inside:avoid;margin:0 0 3px;display:flex;gap:6px;align-items:flex-start}
i.k{position:static;flex:none}
b{flex:none;font-size:10px;text-transform:uppercase;color:#9aa1ab;width:62px}
</style>
<h2>Left (magenta strip): canvas floor artboard rendered from its source. Right (cyan strip): built floor, same 1440 by 900. Badge n marks difference Dn.</h2>
<div class="row"><div class="pane">${strip(STRIPS.canvas)}<div class="cell"><img src="${img(canvasShot)}">${left}</div>${strip(STRIPS.canvas)}</div><div class="pane">${strip(STRIPS.built)}<div class="cell"><img src="${img(builtShot)}">${right}</div>${strip(STRIPS.built)}</div></div>
<h2>Differences (green fixed, yellow changed, red not built, purple spec versus canvas conflict)</h2>
<ul>${legend}</ul>`,
  );
  await page.screenshot({ path: out, fullPage: true });
};

/** @param {import('playwright').Page} page @param {string} out */
const tinted = async (page, out) => {
  await page.evaluate(() => {
    document.documentElement.style.filter = 'hue-rotate(120deg)';
  });
  await shoot(page, out);
  await page.evaluate(() => {
    document.documentElement.style.filter = '';
  });
};

const mutate = {
  deleteEntry: (/** @type {string} */ text, /** @type {string} */ id) => {
    let skip = false;
    return text
      .split('\n')
      .filter((line) => {
        if (/^D\d+ \|/.test(line)) skip = line.startsWith(`${id} |`);
        return !skip;
      })
      .join('\n');
  },
  addKey: (/** @type {string} */ text, /** @type {string} */ at, /** @type {string} */ key) =>
    text.replace(`  covers: ${at}`, `  covers: ${key} ;; ${at}`),
  dropKey: (/** @type {string} */ text, /** @type {string} */ key) =>
    text.replace(` ;; ${key}`, '').replace(`${key} ;; `, '').replace(`  covers: ${key}\n`, ''),
  relabel: (
    /** @type {string} */ text,
    /** @type {string} */ id,
    /** @type {string} */ from,
    /** @type {string} */ to,
  ) => text.replace(`${id} | ${from} |`, `${id} | ${to} |`),
};

/** @param {Inputs} base */
const negatives = (base) => {
  const entries = parseDifferences(base.text);
  const covering = entries.filter((d) => d.covers.length > 0);
  const notBuilt = covering.find((d) => d.status === 'not-built');
  const fixed = covering.find((d) => d.status === 'fixed');
  const notBuiltText = entries.find((d) => d.status === 'not-built' && d.canvas !== '');
  const fixedText = entries.find((d) => d.status === 'fixed' && d.canvas !== '');
  const first = covering.find((d) => d.covers.length > 1) ?? covering[0];
  const second = covering.find((d) => d !== first);
  const diff = diffInventory(base.canvasInv, base.builtInv);
  const extra = new Set(diff.builtOnly);
  const kept = new Set(diff.changed);
  const stillChanged = covering.find((d) => d.status !== 'fixed' && d.covers.some((key) => kept.has(key)));
  const builtOnly = covering.find((d) => d.status === 'changed' && d.covers.some((key) => extra.has(key)));
  if (!(notBuilt && fixed && notBuiltText && fixedText && first && second && builtOnly))
    throw new Error('lane 9 needs entries of every status');
  const staleTable = base.body.replace(/\| not-built \|/, '| fixed |');
  /** @type {Array<[string, string, Partial<Inputs>]>} */
  const cases = [
    ['an entry deleted', 'uncovered', { text: mutate.deleteEntry(base.text, first.id) }],
    ['a covers key deleted', 'uncovered', { text: mutate.dropKey(base.text, first.covers[0] ?? '') }],
    [
      'a covers key that is not different',
      'stale, text:zz is no longer different',
      { text: mutate.addKey(base.text, notBuilt.covers[0] ?? '', 'text:zz') },
    ],
    [
      'not-built relabelled fixed',
      `${notBuilt.id}: fixed but`,
      { text: mutate.relabel(base.text, notBuilt.id, 'not-built', 'fixed') },
    ],
    [
      'fixed relabelled not-built',
      `${fixed.id}: stale`,
      { text: mutate.relabel(base.text, fixed.id, 'fixed', 'not-built') },
    ],
    [
      'a changed key relabelled fixed',
      'is still changed',
      { text: mutate.relabel(base.text, stillChanged.id, stillChanged.status, 'fixed') },
    ],
    [
      'changed relabelled not-built over a built-only key',
      `${builtOnly.id}: not-built but`,
      { text: mutate.relabel(base.text, builtOnly.id, builtOnly.status, 'not-built') },
    ],
    [
      'a key covered twice',
      'is covered by both',
      { text: mutate.addKey(base.text, second.covers[0] ?? '', first.covers[0] ?? '') },
    ],
    ['hot regions dropped', 'uncovered region', { text: base.text.replace(/^ {2}regions: .*$/gm, '') }],
    [
      'three entries only',
      'differences listed',
      {
        text: entries
          .slice(0, 3)
          .map((d) => `${d.id} | ${d.status} | - | - | ${d.text}`)
          .join('\n'),
      },
    ],
    ['the PR body table stale', 'the table in the PR body source is stale', { body: staleTable }],
    ['the ADR table stale', 'the table in ADR 0005 is stale', { adr: staleTable }],
    [
      'a not-built text on the built floor',
      'is on the built floor, not "not-built"',
      { builtText: `${base.builtText}\n${notBuiltText.canvas.toLowerCase()}` },
    ],
    [
      'a fixed text gone from the built floor',
      'is missing from the built floor, not "fixed"',
      { builtText: base.builtText.split(fixedText.canvas.toLowerCase()).join('') },
    ],
    ['the NEED YOU colour changed', 'N NEED YOU colour', { warn: 'rgb(255, 138, 128)' }],
  ];
  return cases.map(([name, expect, change]) => ({ name, expect, input: { ...base, ...change } }));
};

/**
 * @param {import('playwright').Browser} browser
 * @param {import('playwright').Page} builtPage
 * @param {{ inventory: Record<string, string>, text: string }} demo
 */
export const canvasCompare = async (browser, builtPage, demo) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const canvasPage = await ctx.newPage();
  await renderCanvas(canvasPage, OUT);
  const canvasInv = await collect(canvasPage);
  const builtInv = merge(await collect(builtPage), only(demo.inventory, SHARED_FAMILIES));
  writeFileSync(join(OUT, 'inventory-canvas.json'), `${JSON.stringify(canvasInv, null, 1)}\n`);
  writeFileSync(join(OUT, 'inventory-built.json'), `${JSON.stringify(builtInv, null, 1)}\n`);
  const canvasShot = join(OUT, 'canvas-render.png');
  const builtShot = join(OUT, 'built-render.png');
  await shoot(canvasPage, canvasShot);
  await shoot(builtPage, builtShot);
  const canvasText = await textOf(canvasPage);
  const builtText = `${await textOf(builtPage)}\n${demo.text}`;

  const composer = await ctx.newPage();
  const { grid, png } = await pixelGrid(composer, canvasShot, builtShot, true);
  const heat = join(OUT, 'pixel-heatmap.png');
  writeHeat(heat, png);
  const gridText = `${gridMarkdown(grid)}\n`;
  writeFileSync(join(OUT, 'pixel-regions.md'), gridText);

  const text = readFileSync(DIFFERENCES, 'utf8').replace(/\r\n/g, '\n');
  const diffs = parseDifferences(text);
  const read = (/** @type {string} */ file) =>
    existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  const warn = await builtPage.evaluate(() => {
    const node = document.querySelector('.warn');
    return node === null ? null : getComputedStyle(node).color;
  });
  /** @type {Inputs} */
  const input = { text, canvasText, builtText, canvasInv, builtInv, grid, body: read(PR_BODY), adr: read(ADR), warn };
  const problems = verifyEntries(input);

  const onCanvas = await anchors(
    canvasPage,
    diffs.map((d) => d.canvas).filter((x) => x !== ''),
  );
  const onBuilt = await anchors(
    builtPage,
    diffs.map((d) => d.built || d.canvas).filter((x) => x !== ''),
  );
  const badge = (
    /** @type {string} */ side,
    /** @type {Entry} */ d,
    /** @type {string} */ probe,
    /** @type {Record<string, any>} */ found,
  ) => {
    const a = found[probe];
    return a === undefined
      ? ''
      : `<i class="${side}" style="left:${(a.x + a.w / 2) / 2 - 11}px;top:${(a.y + a.h / 2) / 2 - 8}px">${d.id.slice(1)}</i>`;
  };
  const left = diffs.map((d) => badge('c', d, d.canvas, onCanvas)).join('');
  const right = diffs.map((d) => badge('b', d, d.status === 'not-built' ? '' : d.built || d.canvas, onBuilt)).join('');
  const colour = { fixed: '#66bb6a', changed: '#ffca28', 'not-built': '#ef5350', conflict: '#b06cff' };
  const legend = diffs
    .map(
      (d) =>
        `<li><i class="k" style="background:${colour[d.status] ?? '#fff'}">${d.id.slice(1)}</i><b>${d.status}</b> ${d.text.replace(/</g, '&lt;')}</li>`,
    )
    .join('');
  const compare = join(OUT, 'canvas-compare.png');
  await compose(composer, { canvasShot, builtShot, left, right, legend, out: compare });

  const [builtTint, canvasTint] = [join(OUT, 'built-tint.png'), join(OUT, 'canvas-tint.png')];
  await tinted(builtPage, builtTint);
  await tinted(canvasPage, canvasTint);
  const [byBuilt, byCanvas] = [join(OUT, 'compare-built-tint.png'), join(OUT, 'compare-canvas-tint.png')];
  await compose(composer, { canvasShot, builtShot: builtTint, left, right, legend, out: byBuilt });
  await compose(composer, { canvasShot: canvasTint, builtShot, left, right, legend, out: byCanvas });
  if (bytes(compare) === bytes(byBuilt))
    problems.push('the comparison image does not change with the built floor image');
  if (bytes(compare) === bytes(byCanvas)) problems.push('the comparison image does not change with the canvas image');
  if ([canvasShot, builtShot].some((shot) => bytes(compare) === bytes(shot)))
    problems.push('the comparison image equals one of its inputs');

  const layout = await readLayout(composer, compare);
  problems.push(...layoutProblems(layout, 'comparison image'));
  if (!existsSync(COMMITTED_COMPARE) || statSync(COMMITTED_COMPARE).size < 50_000)
    problems.push('docs/review/P1-3-review-canvas-compare.png is missing or tiny');
  else {
    problems.push(...layoutProblems(await readLayout(composer, COMMITTED_COMPARE), 'committed comparison image'));
    const drift = (await pixelGrid(composer, COMMITTED_COMPARE, compare)).grid.flat().filter((v) => v > 60).length;
    if (drift > GRID.cols * GRID.rows * 0.1)
      problems.push(
        `the committed comparison image differs from a fresh one in ${drift} cells, run with WRITE_REVIEW_IMAGE=1`,
      );
  }
  if (!existsSync(COMMITTED_HEAT) || statSync(COMMITTED_HEAT).size < 3000)
    problems.push('the committed pixel heatmap is missing');
  if (
    read(COMMITTED_GRID)
      .split('\n')
      .filter((line) => line.startsWith('| R')).length !== GRID.rows
  )
    problems.push('the committed pixel table is missing or has the wrong shape');

  const { canvas: leftPane, built: rightPane } = layout.panes;
  const skewed = { ...layout, panes: { canvas: { ...leftPane, x1: (leftPane?.x1 ?? 0) - 20 }, built: rightPane } };
  const floorLayout = await readLayout(composer, builtShot);
  for (const [name, expect, found] of [
    ['panes of different widths', 'pane widths', layoutProblems(skewed, 'skewed')],
    ['a plain screenshot as the comparison image', 'no two panes', layoutProblems(floorLayout, 'floor')],
  ])
    if (!found.some((problem) => problem.includes(expect)))
      problems.push(`negative test "${name}" did not fail on "${expect}"`);
  const negativeRuns = negatives(input);
  for (const { name, expect, input: mutated } of negativeRuns)
    if (!verifyEntries(mutated).some((problem) => problem.includes(expect)))
      problems.push(`negative test "${name}" did not fail on "${expect}"`);

  const diff = diffInventory(canvasInv, builtInv);
  const different = [...diff.canvasOnly, ...diff.builtOnly, ...diff.changed];
  const covered = new Set(diffs.flatMap((d) => d.covers));
  const uncovered = different.filter((key) => !covered.has(key)).length;
  const numbers = `inventory ${diff.canvasOnly.length} canvas-only, ${diff.builtOnly.length} built-only, ${diff.changed.length} changed, ${different.length - uncovered} covered, ${uncovered} uncovered, ${hotCells(grid).length} of ${GRID.cols * GRID.rows} pixel cells hot`;
  writeFileSync(
    join(OUT, 'canvas-differences.txt'),
    `${diffs.map((d) => `${d.id} ${d.status} ${d.text}`).join('\n')}\n${numbers}\n`,
  );
  if (process.env.WRITE_REVIEW_IMAGE === '1') {
    copyFileSync(compare, COMMITTED_COMPARE);
    copyFileSync(heat, COMMITTED_HEAT);
    writeFileSync(COMMITTED_GRID, gridText);
  }
  await ctx.close();

  const count = (/** @type {string} */ status) => diffs.filter((d) => d.status === status).length;
  return {
    ok: problems.length === 0,
    numbers,
    note:
      problems.length === 0
        ? `canvas artboard rendered from its source; ${diffs.length} entries (${count('fixed')} fixed, ${count('changed')} changed, ${count('not-built')} not built, ${count('conflict')} conflict); ${numbers}; ${negativeRuns.length + 2} negative tests each failed as they should; comparison image ${layout.width}x${layout.height}, two ${COMPARE.pane} px panes and a legend, changes with either input`
        : problems.slice(0, 12).join('; '),
  };
};
