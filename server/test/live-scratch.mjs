import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scripted } from '../agents/scripted.ts';
import { github } from '../githost/github.ts';
import { cliTransport, fileLog } from '../githost/host.ts';
import { startHq } from '../hq.ts';
import { cagesMode } from '../modes/cages.ts';

const { values: args } = parseArgs({
  options: {
    phase: { type: 'string', default: 'run' },
    repo: { type: 'string', default: 'FiatFour/agent-works-scratch' },
    task: { type: 'string', default: 'alpha/p12a' },
    home: { type: 'string', default: '/tmp/swarm-P1-2/live/home' },
    out: { type: 'string', default: '/tmp/swarm-P1-2/live' },
    work: { type: 'string', default: '12000' },
  },
});
const repo = String(args.repo);
const task = String(args.task);
const home = String(args.home);
const out = String(args.out);
const branch = `aw/${task}`;
const file = `p12/${task.replace('/', '-')}.md`;

/** @type {import('../agents/runtime.ts').Ticket} */
const ticket = {
  id: task,
  kind: 'feature',
  title: 'Write a six-line note',
  body: `Write ${file} with six numbered lines.`,
  url: `https://github.com/FiatFour/ai-office/pull/15#work-order-${task.replace('/', '-')}`,
  risk: { level: 'LOW', reason: 'one new text file in a scratch repo' },
};
const draft = (/** @type {string} */ second) =>
  `${Array.from({ length: 6 }, (_, i) => (i === 1 ? `line 2 ${second}` : `line ${i + 1}`)).join('\n')}\n`;
/** @type {Record<string, import('../agents/scripted.ts').Script>} */
const scripts = {
  [task]: {
    author: [
      { files: [{ path: file, content: draft('first draft') }] },
      { files: [{ path: file, content: draft('fixed') }] },
    ],
    reviews: [
      {
        verdict: 'changes',
        body: 'Line 2 must say "fixed".',
        comments: [{ path: file, line: 2, body: 'Say "fixed" here.' }],
      },
      { verdict: 'approve', body: 'Fixed. Looks right.', comments: [] },
    ],
  },
};

if (args.phase === 'hq') {
  mkdirSync(home, { recursive: true });
  const runtime = scripted({ scripts, workMs: Number(args.work) });
  const hq = await startHq({
    home,
    port: 0,
    mode: cagesMode({
      host: github({ send: cliTransport('gh'), log: fileLog(join(home, 'api-calls.jsonl')) }),
      repo,
      base: 'main',
      tickets: { [task]: ticket },
      author: 'nova',
      reviewer: 'vega',
      workers: { nova: runtime, vega: runtime },
      pollMs: 4000,
    }),
  });
  console.log(`HQ ${hq.url}`);
  await hq.stopped;
  process.exit(0);
}

mkdirSync(out, { recursive: true });
/** @param {string} name @param {string} line */
const say = (name, line) => {
  console.log(`[${name}] ${line}`);
  appendFileSync(join(out, `${name}.txt`), `${new Date().toISOString()} ${line}\n`);
};
/** @param {string[]} a @returns {any} */
const gh = (...a) => JSON.parse(execFileSync('gh', ['api', ...a], { encoding: 'utf8' }) || 'null');
const prsOnBranch = () => gh(`repos/${repo}/pulls?state=all&head=${repo.split('/')[0]}:${branch}`);

const boot = async (work = args.work) => {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--phase',
      'hq',
      '--home',
      home,
      '--task',
      task,
      '--repo',
      repo,
      '--work',
      String(work),
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      const found = /HQ (http\S+)/.exec(String(chunk));
      if (found) resolve(found[1]);
    });
    child.on('exit', (code) => reject(new Error(`HQ exited ${code}`)));
  });
  return { child, url };
};
/** @typedef {import('../snapshot.ts').Snapshot} Snapshot */
/** @param {string} url @returns {Promise<Snapshot>} */
const snapshot = async (url) => (await fetch(`${url}/api/snapshot`)).json();
/** @param {string} url @param {(s: Snapshot) => boolean | undefined} test @param {string} label */
const until = async (url, test, label, ms = 180_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const snap = await snapshot(url);
    if (test(snap)) return snap;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(snap.state.boxes[task])}`);
    await sleep(1000);
  }
};
/** @param {Snapshot} snap */
const box = (snap) => snap.state.boxes[task];
const statused = new Set();
/** @param {string} url */
const standInCi = async (url) => {
  const snap = await snapshot(url);
  const b = box(snap);
  const change = b && 'pr' in b ? snap.state.changes[b.pr] : undefined;
  if (change === undefined || statused.has(change.head.v)) return;
  statused.add(change.head.v);
  gh(
    '-X',
    'POST',
    `repos/${repo}/statuses/${change.head.v}`,
    '-f',
    'state=success',
    '-f',
    'context=agent-works/stand-in-ci',
    '-f',
    'description=stand-in for CI, the private scratch repo runs no Actions',
  );
  say('fix-round', `stand-in CI status posted on ${change.head.v}`);
};

if (args.phase === 'watch') {
  const [pr] = prsOnBranch();
  const watcher = await boot('1000');
  say('closed', `watching ${pr.html_url} (state ${pr.state}, merged_at ${pr.merged_at}) with HQ ${watcher.url}`);
  const shipped = await until(watcher.url, (s) => box(s)?.state === 'shipped', 'the task to close', 3_600_000);
  const merged = gh(`repos/${repo}/pulls/${pr.number}`).merged_at;
  const lag = (Date.now() - Date.parse(merged)) / 1000;
  say(
    'closed',
    `box ${box(shipped)?.state} at ${new Date().toISOString()}; host merged_at ${merged}; seen ${lag.toFixed(1)} s after the merge (bound, includes the time this watcher took to start)`,
  );
  watcher.child.kill('SIGTERM');
  process.exit(0);
}

if (prsOnBranch().length > 0) throw new Error(`${branch} already has a PR; pick a new --task`);

let hq = await boot();
await fetch(`${hq.url}/api/tickets`, { method: 'POST', body: JSON.stringify({ id: task }) });
await until(hq.url, (s) => s.mode?.jobs.includes(task), 'the author job');
await sleep(3000);
hq.child.kill('SIGKILL');
await new Promise((resolve) => hq.child.once('exit', resolve));
say(
  'restart',
  `killed HQ pid ${hq.child.pid} with SIGKILL during the CODE station; PRs on ${branch}: ${prsOnBranch().length}`,
);
hq = await boot('1000');
const opened = await until(hq.url, (s) => box(s)?.state === 'test' || box(s)?.state === 'qc', 'the PR');
say('restart', `restarted HQ; box ${JSON.stringify(box(opened))}; PRs on ${branch}: ${prsOnBranch().length}`);
hq.child.kill('SIGKILL');
await new Promise((resolve) => hq.child.once('exit', resolve));
hq = await boot('1000');
await sleep(6000);
say('restart', `killed and restarted again after the PR opened; PRs on ${branch}: ${prsOnBranch().length}`);

const [pr] = prsOnBranch();
writeFileSync(
  join(out, 'ticket-to-pr.txt'),
  `${JSON.stringify({ number: pr.number, url: pr.html_url, head: pr.head.ref, body: pr.body }, null, 2)}\n`,
);

const ci = setInterval(
  () => void standInCi(hq.url).catch((/** @type {Error} */ e) => say('fix-round', `stand-in CI error ${e.message}`)),
  2000,
);
await until(hq.url, (s) => (s.mode?.rounds[task] ?? 0) >= 1 && box(s)?.state !== 'qc', 'the fix push');
say('fix-round', `HQ counts ${(await snapshot(hq.url)).mode?.rounds[task]} round(s) and the fix moved the head`);
await until(hq.url, () => gh(`repos/${repo}/pulls/${pr.number}/reviews`).length >= 2, 'the re-review');
clearInterval(ci);
const reviews = gh(`repos/${repo}/pulls/${pr.number}/reviews`);
const comments = gh(`repos/${repo}/pulls/${pr.number}/comments`);
writeFileSync(
  join(out, 'peer-review.txt'),
  `${JSON.stringify(
    {
      reviews: reviews.map((/** @type {any} */ r) => ({
        user: r.user.login,
        state: r.state,
        commit: r.commit_id,
        body: r.body,
      })),
      comments: comments.map((/** @type {any} */ c) => ({
        user: c.user.login,
        path: c.path,
        line: c.line,
        commit: c.commit_id,
        body: c.body,
      })),
    },
    null,
    2,
  )}\n`,
);
const final = await snapshot(hq.url);
say(
  'fix-round',
  `after the re-review the box is at ${box(final)?.state} (one account: an approval is posted as a comment, so the box waits in qc per G1); Action items ${JSON.stringify(final.actions)}`,
);
const calls = readFileSync(join(home, 'api-calls.jsonl'), 'utf8').trim().split('\n');
const merges = calls.filter((line) => /\/merge/.test(JSON.parse(line).path));
writeFileSync(
  join(out, 'no-merge-call.txt'),
  `${calls.length} API calls in ${join(home, 'api-calls.jsonl')}, ${merges.length} to a merge path\n`,
);
say('restart', `final PR count on ${branch}: ${prsOnBranch().length}`);
await fetch(`${hq.url}/api/events?after=0`)
  .then((r) => r.json())
  .then((/** @type {{ events: unknown[] }} */ j) =>
    writeFileSync(join(out, 'events.jsonl'), `${j.events.map((e) => JSON.stringify(e)).join('\n')}\n`),
  );
hq.child.kill('SIGTERM');
