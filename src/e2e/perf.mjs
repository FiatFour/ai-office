import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { change, green, human, launch, OUT, review, sha, startHq } from './harness.mjs';

const SECONDS = Number(process.env.PERF_SECONDS ?? 30);
const NAMES = ['nova', 'vega', 'orion', 'lyra', 'atlas', 'juno'];
const TASKS = NAMES.map((name, i) => ({ task: `perf/box${i + 1}`, number: i + 1, name, head: sha(String(i + 1)) }));
const percentile = (/** @type {number[]} */ values, /** @type {number} */ p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const hq = await startHq({ port: 7473 });
const browser = await launch();
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
  await browser.startTracing(page, {
    path: join(OUT, 'perf-trace.json'),
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'blink'],
  });
  const start = Date.now();
  let next = 0;
  while (Date.now() - start < SECONDS * 1000) {
    if (next < order.length) await order[next++]?.();
    await sleep((SECONDS * 1000) / order.length);
  }
  await browser.stopTracing();
  const frames = (await page.evaluate(() => globalThis.__frames)).slice(5);
  const longTasks = frames.filter((f) => f > 50).length;
  const trace = JSON.parse(readFileSync(join(OUT, 'perf-trace.json'), 'utf8'));
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
  const busy = [...windows.values()];
  const snapshot = await hq.snapshot();
  const result = {
    measured: true,
    viewport: '1440x900',
    workers: Object.keys(snapshot.state.staff).length,
    boxesOnFloor: Object.keys(snapshot.state.boxes).length,
    seconds: SECONDS,
    frames: frames.length,
    rafIntervalMs: {
      p50: percentile(frames, 50),
      p95: percentile(frames, 95),
      p99: percentile(frames, 99),
      max: Math.max(...frames),
    },
    framesOver50ms: longTasks,
    p95At0_1msResolution: Math.round(percentile(frames, 95) * 10) / 10,
    mainThreadBusyPer16_7msWindowMs: {
      windows: busy.length,
      p50: percentile(busy, 50),
      p95: percentile(busy, 95),
      max: Math.max(...busy),
    },
  };
  writeFileSync(join(OUT, 'perf-frames.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  const busy95 = result.mainThreadBusyPer16_7msWindowMs.p95;
  if (busy95 > 16.7 || result.rafIntervalMs.p95 > 33.4) {
    console.error(
      `FAIL: main-thread work per frame p95 ${busy95} ms or rAF interval p95 ${result.rafIntervalMs.p95} ms is over the limit`,
    );
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await hq.stop();
}
