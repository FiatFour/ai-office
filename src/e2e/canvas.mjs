import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

export const CANVAS_SOURCE = join(ROOT, 'docs', 'review', 'canvas', 'Main.dc.txt');
const FONTS = join(ROOT, 'src', 'node_modules', '@fontsource');
const FACES = [
  ['Silkscreen', 'silkscreen', 'silkscreen-latin-400-normal.woff2'],
  ['Press Start 2P', 'press-start-2p', 'press-start-2p-latin-400-normal.woff2'],
  ['Pixelify Sans', 'pixelify-sans', 'pixelify-sans-latin-400-normal.woff2'],
  ['VT323', 'vt323', 'vt323-latin-400-normal.woff2'],
];

const EXPAND = `
(() => {
  const vals = new Function('class DCLogic { constructor(p) { this.props = p; } setState() {} }\\n' +
    document.querySelector('script[data-dc-script]').textContent + '\\nreturn new Component({}).renderVals();')();
  const run = (expr, scope) => new Function('scope', 'with (scope) { return (' + expr + '); }')(scope);
  const interpolate = (text, scope) => text.replace(/\\{\\{([^}]+)\\}\\}/g, (_, expr) => {
    let out;
    try {
      out = run(expr, scope);
    } catch (error) {
      throw new Error(expr + ': ' + error.message);
    }
    return out === undefined || out === null ? '' : String(out);
  });
  const fill = (node, scope) => {
    if (node.nodeType === 3) { node.textContent = interpolate(node.textContent, scope); return; }
    if (node.nodeType !== 1 || ['style', 'script'].includes(node.localName)) return;
    const control = node.localName === 'sc-for' || node.localName === 'sc-if';
    for (const attr of control ? [] : [...node.attributes]) {
      if (attr.name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
      if (attr.value.includes('{{')) node.setAttribute(attr.name, interpolate(attr.value, scope));
    }
    const tag = node.localName;
    if (tag === 'sc-for') {
      const list = run(node.getAttribute('list').slice(2, -2), scope);
      const as = node.getAttribute('as');
      const template = [...node.childNodes];
      node.textContent = '';
      for (const item of list) {
        const inner = Object.assign(Object.create(scope), { [as]: item });
        for (const child of template) {
          const copy = child.cloneNode(true);
          node.append(copy);
          fill(copy, inner);
        }
      }
      return;
    }
    if (tag === 'sc-if') {
      if (!run(node.getAttribute('value').slice(2, -2), scope)) { node.textContent = ''; return; }
    }
    for (const child of [...node.childNodes]) fill(child, scope);
  };
  fill(document.querySelector('x-dc'), vals);
  document.querySelectorAll('sc-for, sc-if, x-dc, helmet').forEach((n) => { n.style.display = 'contents'; });
})();
`;

/**
 * @param {import('playwright').Page} page
 * @param {string} workdir
 */
export const renderCanvas = async (page, workdir) => {
  const source = readFileSync(CANVAS_SOURCE, 'utf8')
    .replace(/<script src="\.\/support\.js"><\/script>/, '')
    .replace(/<link [^>]*>/g, '');
  const faces = FACES.map(
    ([family, dir, file]) =>
      `@font-face{font-family:'${family}';src:url('${pathToFileURL(join(FONTS, dir, 'files', file))}') format('woff2')}`,
  ).join('');
  const html = source
    .replace('</head>', `<style>${faces}</style></head>`)
    .replace('</body>', `<script>${EXPAND}</script></body>`);
  const file = join(workdir, 'canvas-render.html');
  writeFileSync(file, html);
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
};
