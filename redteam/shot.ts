// biome-ignore-all lint/suspicious/noExplicitAny: playwright is a dependency of the server package only, so it is loaded by path and not typed here
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { html: { type: 'string' }, png: { type: 'string' } } });
if (values.html === undefined || values.png === undefined) {
  console.error('usage: node redteam/shot.ts --html <file> --png <file>');
  process.exit(2);
}
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(readFileSync(values.html, 'utf8'));
await page.screenshot({ path: values.png, fullPage: true });
await browser.close();
console.log(`wrote ${values.png}`);
