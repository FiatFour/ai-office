import { writeFileSync } from 'node:fs';
import { scripted } from '../agents/scripted.ts';
import { github } from '../githost/github.ts';
import { startHq } from '../hq.ts';
import { cagesMode } from '../modes/cages.ts';
import { FakeGithub } from './fakes/github-api.ts';
import { SCRIPTS, TICKETS } from './fixtures/factory.ts';
import { tempDir } from './helpers.ts';

const POLL_MS = Number(process.env.PERF_POLL_MS ?? 35_000);
const runs = [];
for (const task of ['alpha/t1', 'alpha/t2', 'alpha/t3']) {
  const fake = new FakeGithub();
  const runtime = scripted({ scripts: SCRIPTS });
  const hq = await startHq({
    home: tempDir('perf-p1-2'),
    port: 0,
    mode: cagesMode({
      host: github({ send: fake.transport('aw-nova'), log: () => {} }),
      reviewHost: github({ send: fake.transport('vega'), log: () => {} }),
      repo: 'acme/app',
      base: 'main',
      tickets: TICKETS,
      author: 'nova',
      reviewer: 'vega',
      workers: { nova: runtime, vega: runtime },
      pollMs: POLL_MS,
    }),
  });
  const started = performance.now();
  await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: task }) });
  while (!hq.snapshot().actions.some((a) => a.kind === 'ready_to_merge')) await new Promise((r) => setTimeout(r, 5));
  const ms = performance.now() - started;
  const snap = hq.snapshot();
  runs.push({
    task,
    files: SCRIPTS[task]?.author[0]?.files.length,
    fixRounds: snap.mode?.rounds[task],
    msToMergeReady: Math.round(ms),
    apiCalls: fake.calls.length,
    tokens: snap.mode?.usage[task],
  });
  await hq.close();
}
const text = [
  `perf probe, measured ${new Date().toISOString()} on ${process.platform} node ${process.version}, poll interval ${POLL_MS} ms`,
  'runtime: scripted fake agent (no model), host: in-memory fake GitHub; wall time covers HQ, outbox, jobs and the host adapter only',
  ...runs.map(
    (r) =>
      `${r.task}: ${r.files} file(s), ${r.fixRounds} fix round(s), ${r.msToMergeReady} ms to merge-ready, ${r.apiCalls} host API calls, tokens ${JSON.stringify(r.tokens)} (null = the scripted runtime reports no usage; tokens are not measured without a real runtime)`,
  ),
  'baseline: none, trunk has no factory',
].join('\n');
console.log(text);
writeFileSync(process.env.PERF_OUT ?? '/tmp/perf-p1-2.txt', `${text}\n`);
