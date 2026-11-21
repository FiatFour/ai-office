import { setTimeout as sleep } from 'node:timers/promises';
import { collect } from '../scripts/inventory.mjs';
import { canvasCompare, textOf } from './canvas-compare.mjs';
import { change, green, human, launch, review, sha, startHq } from './harness.mjs';

const WORKERS = ['nova', 'vega', 'orion', 'lyra', 'atlas', 'juno', 'kai'];

/** @param {import('playwright').Browser} browser */
export const runLane9 = async (browser) => {
  const demo = await startHq({ demo: true, port: 7473, intervalMs: 900 });
  let demoState;
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(demo.url);
    await page.waitForSelector('.toast', { timeout: 40_000 });
    await sleep(600);
    demoState = { inventory: await collect(page), text: await textOf(page) };
    await page.context().close();
  } finally {
    await demo.stop();
  }

  const live = await startHq({ port: 7474 });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(live.url);
    await page.waitForSelector('[data-testid=rev]');
    for (const worker of WORKERS) await live.post(human('add_worker', { worker }));
    await page.waitForFunction((count) => document.querySelectorAll('.crew li').length === count, WORKERS.length);
    for (const [number, task, worker, seed] of [
      [1, 'alpha/one', 'nova', 'a'],
      [2, 'beta/two', 'orion', 'b'],
    ]) {
      await live.post(human('order', { task, shipment: null }));
      await live.post(human('hire', { task, worker }));
      await live.post(change(task, number, worker, sha(seed), 'open', 1000 + number));
      await live.post(green(sha(seed), 1010 + number));
    }
    const reviewer = (await live.snapshot()).state.boxes['alpha/one'].reviewer;
    await live.post(review(1, reviewer, 'approve', sha('a'), 1020));
    await sleep(2500);
    const verdict = await canvasCompare(browser, page, demoState);
    await ctx.close();
    return verdict;
  } finally {
    await live.stop();
  }
};

if (import.meta.main) {
  const browser = await launch();
  try {
    const verdict = await runLane9(browser);
    console.log(`${verdict.ok ? 'PASS' : 'FAIL'} lane 9 canvas compare: ${verdict.note}`);
    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
