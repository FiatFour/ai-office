import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { change, green, human, launch, OUT, review, sha, startHq } from './harness.mjs';

const SECONDS = Number(process.env.PERF_SECONDS ?? 30);
const DEMO_SECONDS = Number(process.env.PERF_DEMO_SECONDS ?? 20);
const NAMES = ['nova', 'vega', 'orion', 'lyra', 'atlas', 'juno'];
const TASKS = NAMES.map((name, i) => ({ task: `perf/box${i + 1}`, number: i + 1, name, head: sha(String(i + 1)) }));
const percentile = (/** @type {number[]} */ values, /** @type {number} */ p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const FRAME_RULES = 'work per frame p95 <= 16.7 ms (the CI gate), rAF interval p95 <= 33.4 ms (a dropped frame)';

/** @param {number[]} frames @param {Map<number, number>} windows */
const summarize = (frames, windows) => {
  const busy = [...windows.values()];
  return {
    frames: frames.length,
    rafIntervalMs: {
      p50: percentile(frames, 50),
      p95: percentile(frames, 95),
      p99: percentile(frames, 99),
      max: Math.max(...frames),
    },
    framesOver50ms: frames.filter((f) => f > 50).length,
    p95At0_1msResolution: Math.round(percentile(frames, 95) * 10) / 10,
    mainThreadBusyPer16_7msWindowMs: {
      windows: busy.length,
      p50: percentile(busy, 50),
      p95: percentile(busy, 95),
      max: Math.max(...busy),
    },
  };
};

/**
 * Records rAF intervals and a Chrome trace while `drive` runs, then sums main-thread render work per 16.7 ms window.
 * @param {import('playwright').Browser} browser @param {import('playwright').Page} page @param {string} name @param {() => Promise<void>} drive
 */
const measure = async (browser, page, name, drive) => {
  await page.evaluate(() => {
    globalThis.__frames = [];
    let last = performance.now();
    const tick = (/** @type {number} */ now) => {
      globalThis.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const path = join(OUT, `perf-trace-${name}.json`);
  await browser.startTracing(page, {
    path,
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'blink'],
  });
  await drive();
  await browser.stopTracing();
  const frames = (await page.evaluate(() => globalThis.__frames)).slice(5);
  const trace = JSON.parse(readFileSync(path, 'utf8'));
  const events = (trace.traceEvents ?? trace).filter(
    (e) =>
      e.ph === 'X' &&
      [
        'Layout',
        'UpdateLayoutTree',
        'Paint',
        'PrePaint',
        'Commit',
        'Layerize',
        'FunctionCall',
        'EvaluateScript',
      ].includes(e.name),
  );
  const renderer = new Map();
  for (const e of events) renderer.set(e.tid, (renderer.get(e.tid) ?? 0) + 1);
  const mainTid = [...renderer.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const windows = new Map();
  for (const e of events.filter((x) => x.tid === mainTid)) {
    const w = Math.floor(e.ts / 16700);
    windows.set(w, (windows.get(w) ?? 0) + e.dur / 1000);
  }
  return summarize(frames, windows);
};

const judge = (/** @type {ReturnType<typeof summarize>} */ result, /** @type {string} */ name) => {
  const busy95 = result.mainThreadBusyPer16_7msWindowMs.p95;
  if (busy95 > 16.7 || result.rafIntervalMs.p95 > 33.4) {
    console.error(
      `FAIL ${name}: main-thread work per frame p95 ${busy95} ms or rAF interval p95 ${result.rafIntervalMs.p95} ms is over the limit (${FRAME_RULES})`,
    );
    process.exitCode = 1;
  }
};

const browser = await launch();
const report = { measured: true, viewport: '1440x900', rules: FRAME_RULES };

const hq = await startHq({ port: 7473 });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(hq.url);
  await page.waitForSelector('[data-testid=rev]');
  for (const name of NAMES) await hq.post(human('add_worker', { worker: name }));
  await page.waitForFunction(() => document.querySelectorAll('[data-worker]').length === 6);

  const stages = TASKS.flatMap((t, i) => [
    () => hq.post(human('order', { task: t.task, shipment: null })),
    () => hq.post(human('hire', { task: t.task, worker: t.name })),
    () => hq.post(change(t.task, t.number, t.name, t.head, 'open', 1000 + i)),
    () => hq.post(green(t.head, 2000 + i)),
    async () => {
      const reviewer = (await hq.snapshot()).state.boxes[t.task]?.reviewer;
      if (reviewer) await hq.post(review(t.number, reviewer, 'approve', t.head, 3000 + i));
    },
    () => hq.post(change(t.task, t.number, t.name, t.head, 'merged', 4000 + i)),
  ]);
  const order = [];
  for (let round = 0; round < 6; round += 1)
    for (let i = 0; i < TASKS.length; i += 1) order.push(stages[i * 6 + round]);

  const live = await measure(browser, page, 'live', async () => {
    const start = Date.now();
    let next = 0;
    while (Date.now() - start < SECONDS * 1000) {
      if (next < order.length) await order[next++]?.();
      await sleep((SECONDS * 1000) / order.length);
    }
  });
  const snapshot = await hq.snapshot();
  report.live = {
    what: 'a real HQ (bin/agent-works.ts serve) fed over HTTP POST /api/events, six workers and six boxes moving',
    workers: Object.keys(snapshot.state.staff).length,
    boxesOnFloor: Object.keys(snapshot.state.boxes).length,
    seconds: SECONDS,
    ...live,
  };
  judge(live, 'live');
} finally {
  await hq.stop();
}

const demo = await startHq({ demo: true, port: 7474, intervalMs: 1000 });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(demo.url);
  await page.waitForSelector('[data-testid=demo-chip]');
  const result = await measure(browser, page, 'demo', async () => {
    await sleep(DEMO_SECONDS * 1000);
  });
  const snapshot = await demo.snapshot();
  report.demo = {
    what: 'agent-works --demo replaying fixtures/demo/events.jsonl (two workers, one box) at one event a second',
    workers: Object.keys(snapshot.state.staff).length,
    boxesOnFloor: Object.keys(snapshot.state.boxes).length,
    seconds: DEMO_SECONDS,
    ...result,
  };
  judge(result, 'demo');
} finally {
  await demo.stop();
  await browser.close();
}

writeFileSync(join(OUT, 'perf-frames.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
