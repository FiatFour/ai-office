import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch, OUT, startHq } from './harness.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aw-video-'));
const hq = await startHq({ demo: true, port: 7474, intervalMs: 2200 });
const browser = await launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await page.goto(hq.url);
  await page.waitForSelector('[data-testid=rev]');
  await page.waitForFunction(() => document.body.textContent.includes('SHIPPED'), null, { timeout: 60_000 });
  await sleep(2500);
  await page.keyboard.press('1');
  await sleep(1500);
  await page.click('[data-testid=open-actions]');
  await sleep(2000);
  await context.close();
  const [webm] = readdirSync(dir).filter((name) => name.endsWith('.webm'));
  const out = process.env.VIDEO_OUT ?? join(OUT, 'review.mp4');
  const encode = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      join(dir, webm),
      '-c:v',
      'libx264',
      '-crf',
      '30',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      out,
    ],
    { encoding: 'utf8' },
  );
  if (encode.status !== 0) throw new Error(encode.stderr.slice(-500));
  console.log(`video ${out}`);
} finally {
  await browser.close();
  await hq.stop();
  rmSync(dir, { recursive: true, force: true });
}
