import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCanvas } from './canvas.mjs';
import { OUT, ROOT } from './harness.mjs';

export const DIFFERENCES = join(ROOT, 'docs', 'review', 'P1-3-canvas-differences.md');
export const PR_BODY = join(ROOT, 'docs', 'review', 'P1-3-pr-body.md');
export const ADR = join(ROOT, 'docs', 'decisions', '0005-floor-view-and-demo-replay.md');
export const COMMITTED_COMPARE = join(ROOT, 'docs', 'review', 'P1-3-review-canvas-compare.png');
export const COMMITTED_FLOOR = join(ROOT, 'docs', 'review', 'P1-3-review-floor.png');

export const markdown = (/** @type {ReturnType<typeof parseDifferences>} */ diffs) =>
  [
    '| id | status | what differs |',
    '| --- | --- | --- |',
    ...diffs.map((d) => `| ${d.id} | ${d.status} | ${d.text.replace(/\|/g, '/')} |`),
  ].join('\n');

export const BLOCK = /<!-- differences:start -->\n([\s\S]*?)\n?<!-- differences:end -->/;

export const STATUSES = ['fixed', 'changed', 'not-built', 'conflict'];

/**
 * One difference per line: `D01 | status | canvas text | built text | what differs`.
 * `fixed`: the built floor now shows the canvas text. `changed`: both show something, different.
 * `not-built`: the canvas shows it, the built floor does not. `conflict`: spec and canvas disagree.
 * @param {string} text
 */
export const parseDifferences = (text) =>
  text
    .split('\n')
    .filter((line) => /^D\d+ \|/.test(line))
    .map((line) => {
      const [id = '', status = '', canvas = '', built = '', ...rest] = line.split(' | ').map((part) => part.trim());
      return {
        id,
        status,
        canvas: canvas === '-' ? '' : canvas,
        built: built === '-' ? '' : built,
        text: rest.join(' | '),
      };
    });

const sha = (/** @type {string} */ file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export const pageText = (/** @type {import('playwright').Page} */ page) => textOf(page);

const textOf = (/** @type {import('playwright').Page} */ page) =>
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

/**
 * Renders the canvas floor artboard next to the built floor, checks every listed difference against both
 * pages, and builds one image with a numbered badge per difference and a legend.
 * @param {import('playwright').Browser} browser
 * @param {import('playwright').Page} builtPage
 * @param {string} builtShot
 */
export const canvasCompare = async (browser, builtPage, builtShot, extraText = '') => {
  const problems = [];
  const diffs = parseDifferences(readFileSync(DIFFERENCES, 'utf8'));
  const ids = diffs.map((d) => d.id);
  if (diffs.length < 20) problems.push(`only ${diffs.length} differences listed`);
  if (new Set(ids).size !== ids.length) problems.push('duplicate ids');
  for (const d of diffs) if (!STATUSES.includes(d.status)) problems.push(`${d.id}: status ${d.status}`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  const canvasPage = await ctx.newPage();
  await renderCanvas(canvasPage, OUT);
  const canvasShot = join(OUT, 'canvas-render.png');
  await canvasPage.screenshot({ path: canvasShot });

  const canvasText = await textOf(canvasPage);
  const builtText = `${await textOf(builtPage)}\n${extraText}`;
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

  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const [body, adr] = [read(PR_BODY), read(ADR)];
  for (const [name, doc] of [
    ['the PR body source', body],
    ['ADR 0005', adr],
  ]) {
    for (const id of ids) if (!new RegExp(`\\b${id}\\b`).test(doc)) problems.push(`${id} is not in ${name}`);
    if (BLOCK.exec(doc)?.[1] !== markdown(diffs))
      problems.push(`the table in ${name} is stale, run node src/scripts/differences.mjs`);
  }
  const warn = await builtPage.evaluate(() => {
    const node = document.querySelector('.warn');
    return node === null ? null : getComputedStyle(node).color;
  });
  if (warn !== 'rgb(255, 202, 40)') problems.push(`N NEED YOU colour is ${warn}, the canvas has #ffca28`);

  const onCanvas = await anchors(
    canvasPage,
    diffs.map((d) => d.canvas).filter((x) => x !== ''),
  );
  const onBuilt = await anchors(
    builtPage,
    diffs.map((d) => d.built || d.canvas).filter((x) => x !== ''),
  );
  const badge = (side, d, probe, found) => {
    const a = found[probe];
    return a === undefined
      ? ''
      : `<i class="${side}" style="left:${(a.x + a.w / 2) / 2 - 11}px;top:${(a.y + a.h / 2) / 2 - 8}px">${d.id.slice(1)}</i>`;
  };
  const left = diffs.map((d) => badge('c', d, d.canvas, onCanvas)).join('');
  const right = diffs.map((d) => badge('b', d, d.status === 'not-built' ? '' : d.built || d.canvas, onBuilt)).join('');
  const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  const colour = { fixed: '#66bb6a', changed: '#ffca28', 'not-built': '#ef5350', conflict: '#b06cff' };
  const legend = diffs
    .map(
      (d) =>
        `<li><i class="k" style="background:${colour[d.status]}">${d.id.slice(1)}</i><b>${d.status}</b> ${d.text.replace(/</g, '&lt;')}</li>`,
    )
    .join('');
  const composer = await ctx.newPage();
  await composer.setViewportSize({ width: 1440, height: 400 });
  await composer.setContent(
    `<style>
body{margin:0;background:#101214;color:#e3e6ea;font:12px/1.25 system-ui,sans-serif;width:1440px}
h2{margin:6px 8px;font:700 14px system-ui}
.row{display:flex;gap:0}.cell{position:relative;width:720px;height:412px;overflow:hidden}
.cell img{width:720px;display:block}
i{position:absolute;min-width:16px;padding:0 3px;height:16px;line-height:16px;text-align:center;font:700 11px system-ui;font-style:normal;border:1.5px solid #15181c;color:#15181c;z-index:2}
i.c{background:#ffca28}i.b{background:#66bb6a}
ul{columns:2;column-gap:14px;margin:6px 8px 10px;padding:0;list-style:none}
li{break-inside:avoid;margin:0 0 3px;display:flex;gap:6px;align-items:flex-start}
i.k{position:static;flex:none}
b{flex:none;font-size:10px;text-transform:uppercase;color:#9aa1ab;width:62px}
</style>
<h2>Left: canvas floor artboard (Main.dc.html, rendered from its own source). Right: built floor, same 1440 px width, live HQ with seven workers. Badge n marks difference Dn.</h2>
<div class="row"><div class="cell"><img src="${img(canvasShot)}">${left}</div><div class="cell"><img src="${img(builtShot)}">${right}</div></div>
<h2>Differences (green built or fixed, yellow changed, red not built, purple spec versus canvas conflict)</h2>
<ul>${legend}</ul>`,
  );
  const compare = join(OUT, 'canvas-compare.png');
  await composer.screenshot({ path: compare, fullPage: true });
  if (process.env.WRITE_REVIEW_IMAGE === '1') copyFileSync(compare, COMMITTED_COMPARE);
  await ctx.close();

  const hashes = { compare: sha(compare), floor: sha(builtShot), canvas: sha(canvasShot) };
  if (hashes.compare === hashes.floor || hashes.compare === hashes.canvas)
    problems.push('the comparison image equals one of its inputs');
  if (!existsSync(COMMITTED_COMPARE) || statSync(COMMITTED_COMPARE).size < 50_000)
    problems.push('docs/review/P1-3-review-canvas-compare.png is missing or tiny');
  else if (existsSync(COMMITTED_FLOOR) && sha(COMMITTED_COMPARE) === sha(COMMITTED_FLOOR))
    problems.push('the committed comparison equals the committed floor screenshot');
  writeFileSync(
    join(OUT, 'canvas-differences.txt'),
    `${diffs.map((d) => `${d.id} ${d.status} ${d.text}`).join('\n')}\n`,
  );

  const count = (status) => diffs.filter((d) => d.status === status).length;
  return {
    ok: problems.length === 0,
    note:
      problems.length === 0
        ? `canvas artboard rendered from its source; ${diffs.length} differences (${count('fixed')} fixed, ${count('changed')} changed, ${count('not-built')} not built, ${count('conflict')} conflict) each checked on both pages and named in the PR body source and ADR 0005; comparison image is not its inputs`
        : problems.join('; '),
  };
};
