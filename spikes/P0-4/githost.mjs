import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * @typedef {'github' | 'gitlab'} Host
 * @typedef {'open' | 'closed' | 'merged'} ChangeState
 * @typedef {'pending' | 'success' | 'failure'} CheckState
 * @typedef {{ host: Host, repo: string }} Source
 * @typedef {Source & { kind: 'push', ref: string, headSha: string }} PushEvent
 * @typedef {Source & { kind: 'change', number: number, action: string, state: ChangeState, branch: string, headSha: string }} ChangeEvent
 * @typedef {Source & { kind: 'review', number: number, verdict: string }} ReviewEvent
 * @typedef {Source & { kind: 'review_comment', number: number, path: string, line: number | null }} ReviewCommentEvent
 * @typedef {Source & { kind: 'check', headSha: string, name: string, state: CheckState }} CheckEvent
 * @typedef {PushEvent | ChangeEvent | ReviewEvent | ReviewCommentEvent | CheckEvent} GitHostEvent
 * @typedef {{ factory: string, task: string }} Route
 * @typedef {{ ts: string, host: Host, purpose: string, method: string, path: string, status: number, ms: number, rateRemaining: number | null }} ApiCall
 * @typedef {{ token: string, log: string, purpose: string }} Client
 * @typedef {{ state: ChangeState, headSha: string, updatedAt: string }} PullSnapshot
 */

export class PayloadError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`payload is missing ${path}`);
    this.path = path;
  }
}

/**
 * @param {unknown} body
 * @param {string} path
 * @returns {unknown}
 */
function field(body, path) {
  /** @type {unknown} */
  let value = body;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(key in value)) throw new PayloadError(path);
    value = /** @type {Record<string, unknown>} */ (value)[key];
  }
  return value;
}

/** @param {unknown} body @param {string} path */
function str(body, path) {
  const value = field(body, path);
  if (typeof value !== 'string') throw new PayloadError(path);
  return value;
}

/** @param {unknown} body @param {string} path */
function num(body, path) {
  const value = field(body, path);
  if (typeof value !== 'number') throw new PayloadError(path);
  return value;
}

/** @param {unknown} body @param {string} path */
function nullableNum(body, path) {
  const value = field(body, path);
  if (value !== null && typeof value !== 'number') throw new PayloadError(path);
  return value;
}

/** @param {unknown} body @param {string} path */
function bool(body, path) {
  const value = field(body, path);
  if (typeof value !== 'boolean') throw new PayloadError(path);
  return value;
}

/** @param {string | null} conclusion @returns {CheckState} */
function githubConclusion(conclusion) {
  if (conclusion === null) return 'pending';
  return ['success', 'neutral', 'skipped'].includes(conclusion) ? 'success' : 'failure';
}

/** @param {string} status @returns {CheckState} */
function gitlabPipeline(status) {
  if (status === 'success') return 'success';
  return ['failed', 'canceled'].includes(status) ? 'failure' : 'pending';
}

/** @param {string} state @returns {ChangeState} */
function gitlabState(state) {
  if (state === 'merged') return 'merged';
  return state === 'closed' ? 'closed' : 'open';
}

/** @type {Record<Host, Record<string, (body: unknown) => GitHostEvent>>} */
const PARSERS = {
  github: {
    push: (b) => ({
      host: 'github',
      repo: str(b, 'repository.full_name'),
      kind: 'push',
      ref: str(b, 'ref'),
      headSha: str(b, 'after'),
    }),
    pull_request: (b) => ({
      host: 'github',
      repo: str(b, 'repository.full_name'),
      kind: 'change',
      number: num(b, 'number'),
      action: str(b, 'action'),
      state: bool(b, 'pull_request.merged') ? 'merged' : str(b, 'pull_request.state') === 'open' ? 'open' : 'closed',
      branch: str(b, 'pull_request.head.ref'),
      headSha: str(b, 'pull_request.head.sha'),
    }),
    pull_request_review: (b) => ({
      host: 'github',
      repo: str(b, 'repository.full_name'),
      kind: 'review',
      number: num(b, 'pull_request.number'),
      verdict: str(b, 'review.state'),
    }),
    pull_request_review_comment: (b) => ({
      host: 'github',
      repo: str(b, 'repository.full_name'),
      kind: 'review_comment',
      number: num(b, 'pull_request.number'),
      path: str(b, 'comment.path'),
      line: nullableNum(b, 'comment.line'),
    }),
    status: (b) => {
      const state = str(b, 'state');
      return {
        host: 'github',
        repo: str(b, 'repository.full_name'),
        kind: 'check',
        headSha: str(b, 'sha'),
        name: str(b, 'context'),
        state: state === 'pending' ? 'pending' : state === 'success' ? 'success' : 'failure',
      };
    },
    check_run: (b) => ({
      host: 'github',
      repo: str(b, 'repository.full_name'),
      kind: 'check',
      headSha: str(b, 'check_run.head_sha'),
      name: str(b, 'check_run.name'),
      state: str(b, 'check_run.status') === 'completed' ? githubConclusion(str(b, 'check_run.conclusion')) : 'pending',
    }),
  },
  gitlab: {
    'Push Hook': (b) => ({
      host: 'gitlab',
      repo: str(b, 'project.path_with_namespace'),
      kind: 'push',
      ref: str(b, 'ref'),
      headSha: str(b, 'after'),
    }),
    'Merge Request Hook': (b) => ({
      host: 'gitlab',
      repo: str(b, 'project.path_with_namespace'),
      kind: 'change',
      number: num(b, 'object_attributes.iid'),
      action: str(b, 'object_attributes.action'),
      state: gitlabState(str(b, 'object_attributes.state')),
      branch: str(b, 'object_attributes.source_branch'),
      headSha: str(b, 'object_attributes.last_commit.id'),
    }),
    'Note Hook': (b) => {
      const position = field(b, 'object_attributes.position');
      return {
        host: 'gitlab',
        repo: str(b, 'project.path_with_namespace'),
        kind: 'review_comment',
        number: num(b, 'merge_request.iid'),
        path: position === null ? '' : str(position, 'new_path'),
        line: position === null ? null : nullableNum(position, 'new_line'),
      };
    },
    'Pipeline Hook': (b) => ({
      host: 'gitlab',
      repo: str(b, 'project.path_with_namespace'),
      kind: 'check',
      headSha: str(b, 'object_attributes.sha'),
      name: `pipeline ${num(b, 'object_attributes.id')}`,
      state: gitlabPipeline(str(b, 'object_attributes.status')),
    }),
  },
};

/**
 * Parses a webhook body into a typed event. Returns null for an event type the lifecycle does not use,
 * and throws PayloadError when a used event lacks a field.
 * @param {Host} host
 * @param {string} event
 * @param {unknown} body
 * @returns {GitHostEvent | null}
 */
export function parseEvent(host, event, body) {
  const parse = PARSERS[host][event];
  return parse ? parse(body) : null;
}

const BRANCH = /^aw\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

/** @param {string} branch @returns {Route | null} */
export function routeBranch(branch) {
  const match = BRANCH.exec(branch);
  return match?.[1] && match[2] ? { factory: match[1], task: match[2] } : null;
}

/** @param {Route} route */
export function branchName(route) {
  const branch = `aw/${route.factory}/${route.task}`;
  if (!routeBranch(branch)) throw new Error(`factory and task must be lowercase slugs: ${branch}`);
  return branch;
}

/**
 * Groups changes by the factory their branch names. Branches without the prefix land under null.
 * @template {{ branch: string }} T
 * @param {T[]} changes
 * @returns {Map<string | null, T[]>}
 */
export function assignToFactories(changes) {
  /** @type {Map<string | null, T[]>} */
  const byFactory = new Map();
  for (const change of changes) {
    const factory = routeBranch(change.branch)?.factory ?? null;
    byFactory.set(factory, [...(byFactory.get(factory) ?? []), change]);
  }
  return byFactory;
}

/**
 * Verifies `X-Hub-Signature-256` against the raw body (S-31).
 * @param {string} secret
 * @param {Buffer} raw
 * @param {string | undefined} header
 */
export function signatureValid(secret, raw, header) {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * The spike never merges: a human does (lane 10). Any non-GET call to a merge path is refused before it is sent.
 * @param {string} method
 * @param {string} path
 */
export function isMergeCall(method, path) {
  return method !== 'GET' && /\/pulls\/\d+\/merge$|\/merge_requests\/\d+\/merge$/.test(path);
}

/** @type {Map<string, { etag: string, body: unknown }>} */
const etags = new Map();

/**
 * @param {Client} client
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function github(client, method, path, body) {
  if (isMergeCall(method, path)) throw new Error(`refusing merge call ${method} ${path}`);
  /** @type {Record<string, string>} */
  const headers = {
    authorization: `Bearer ${client.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-works-spike',
  };
  const cached = method === 'GET' ? etags.get(path) : undefined;
  if (cached) headers['if-none-match'] = cached.etag;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const remaining = response.headers.get('x-ratelimit-remaining');
  /** @type {ApiCall} */
  const call = {
    ts: new Date().toISOString(),
    host: 'github',
    purpose: client.purpose,
    method,
    path,
    status: response.status,
    ms: Math.round(performance.now() - started),
    rateRemaining: remaining === null ? null : Number(remaining),
  };
  appendFileSync(client.log, `${JSON.stringify(call)}\n`);
  if (response.status === 304 && cached) return { status: 304, body: cached.body };
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  const etag = response.headers.get('etag');
  if (method === 'GET' && etag) etags.set(path, { etag, body: parsed });
  return { status: response.status, body: parsed };
}

/** @param {any} pull @returns {PullSnapshot} */
function snapshot(pull) {
  return {
    state: pull.merged ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
    headSha: pull.head.sha,
    updatedAt: pull.updated_at,
  };
}

/** @param {Client} client @param {string} repo @param {number} number */
async function pollPull(client, repo, number) {
  return snapshot((await github(client, 'GET', `/repos/${repo}/pulls/${number}`)).body);
}

/**
 * Commits one file change to a branch through the contents API, which is a push the host sees.
 * @param {Client} client
 * @param {string} repo
 * @param {string} branch
 * @param {string} path
 * @param {string} content
 * @returns {Promise<string>} the new head SHA
 */
async function commitFile(client, repo, branch, path, content) {
  /** @type {string | undefined} */
  let sha;
  try {
    sha = (await github(client, 'GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`)).body.sha;
  } catch {
    sha = undefined;
  }
  const result = await github(client, 'PUT', `/repos/${repo}/contents/${path}`, {
    message: `spike: update ${path}`,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  return result.body.commit.sha;
}

/** @param {Client} client @param {string} repo @param {Route} route */
async function lifecycle(client, repo, route) {
  const branch = branchName(route);
  const repoInfo = (await github(client, 'GET', `/repos/${repo}`)).body;
  const base = repoInfo.default_branch;
  const baseSha = (await github(client, 'GET', `/repos/${repo}/git/ref/heads/${base}`)).body.object.sha;
  try {
    await github(client, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch (error) {
    if (!String(error).includes('-> 422')) throw error;
  }
  const path = `spike/${route.factory}-${route.task}.md`;
  const lines = Array.from({ length: 6 }, (_, i) => `line ${i + 1} of ${route.task}`);
  const headSha = await commitFile(client, repo, branch, path, `${lines.join('\n')}\n`);

  const owner = repo.split('/')[0];
  const existing = (await github(client, 'GET', `/repos/${repo}/pulls?state=open&head=${owner}:${branch}`)).body;
  const pull =
    existing[0] ??
    (
      await github(client, 'POST', `/repos/${repo}/pulls`, {
        title: `spike ${route.factory}/${route.task}`,
        head: branch,
        base,
        body: 'Agent Works P0-4 spike PR. Do not merge unless asked by the P0-4 lane 10 gate.',
      })
    ).body;
  console.log(`PR ${pull.html_url} branch ${branch}`);

  await github(client, 'POST', `/repos/${repo}/statuses/${headSha}`, {
    state: 'success',
    context: 'agent-works/spike',
    description: 'P0-4 spike status, posted by the API, no Actions run',
  });

  const review = (
    await github(client, 'POST', `/repos/${repo}/pulls/${pull.number}/reviews`, {
      commit_id: headSha,
      event: 'COMMENT',
      body: 'Spike review with two line comments.',
      comments: [
        { path, line: 2, side: 'RIGHT', body: 'Comment on line 2.' },
        { path, line: 5, side: 'RIGHT', body: 'Comment on line 5.' },
      ],
    })
  ).body;
  console.log(`review ${review.id} ${review.state}`);

  const checkRuns = (await github(client, 'GET', `/repos/${repo}/commits/${headSha}/check-runs`)).body;
  const combined = (await github(client, 'GET', `/repos/${repo}/commits/${headSha}/status`)).body;
  console.log(
    `checks combined=${combined.state} statuses=${combined.statuses.map((/** @type {any} */ s) => `${s.context}:${s.state}`).join(',')} check_runs=${checkRuns.total_count}`,
  );

  const final = await pollPull(client, repo, pull.number);
  console.log(`final github PR #${pull.number} state=${final.state} head=${final.headSha}`);
  console.log('final gitlab MR: not run, no account (gate G0)');
}

/** @param {Client} client @param {string} repo @param {string} ref */
async function readChecks(client, repo, ref) {
  const runs = (await github(client, 'GET', `/repos/${repo}/commits/${ref}/check-runs?per_page=100`)).body;
  for (const run of runs.check_runs) {
    console.log(`${run.name}\t${run.status}\t${run.conclusion ?? '-'}\t${githubConclusion(run.conclusion)}`);
  }
  const combined = (await github(client, 'GET', `/repos/${repo}/commits/${ref}/status`)).body;
  for (const status of combined.statuses) console.log(`${status.context}\tstatus\t${status.state}`);
}

/** @param {Client} client @param {string} repo */
async function route(client, repo) {
  const pulls = (await github(client, 'GET', `/repos/${repo}/pulls?state=open&per_page=100`)).body;
  /** @type {{ number: number, branch: string }[]} */
  const changes = pulls.map((/** @type {any} */ p) => ({ number: p.number, branch: p.head.ref }));
  for (const [factory, assigned] of assignToFactories(changes)) {
    console.log(`factory ${factory ?? '(none)'}: ${assigned.map((c) => `#${c.number} ${c.branch}`).join(', ')}`);
  }
}

/**
 * Starts a local listener and `gh webhook forward` to it. Resolves once the forwarder reports it is forwarding.
 * @param {{ repo: string, port: number, out: string, onEvent: (event: GitHostEvent, name: string, at: number) => void }} options
 */
async function startWebhooks({ repo, port, out, onEvent }) {
  const secret = randomBytes(16).toString('hex');
  const deliveries = join(out, 'deliveries');
  mkdirSync(deliveries, { recursive: true });
  let count = 0;
  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const at = Date.now();
      const raw = Buffer.concat(chunks);
      const name = String(request.headers['x-github-event'] ?? '');
      const signed = signatureValid(
        secret,
        raw,
        /** @type {string | undefined} */ (request.headers['x-hub-signature-256']),
      );
      response.writeHead(signed ? 202 : 401).end();
      if (!signed) {
        console.log(`webhook ${name} rejected: bad signature`);
        return;
      }
      const body = JSON.parse(raw.toString('utf8'));
      count += 1;
      writeFileSync(
        join(deliveries, `${String(count).padStart(3, '0')}-${name}.json`),
        JSON.stringify({ host: 'github', event: name, delivery: request.headers['x-github-delivery'], body }, null, 2),
      );
      const event = parseEvent('github', name, body);
      console.log(`webhook ${name} signature=ok ${event ? JSON.stringify(event) : 'ignored'}`);
      if (event) onEvent(event, name, at);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)));
  const events = 'push,pull_request,pull_request_review,pull_request_review_comment,status,check_run';
  const forwarder = spawn(
    'gh',
    [
      'webhook',
      'forward',
      `--repo=${repo}`,
      `--events=${events}`,
      `--url=http://127.0.0.1:${port}/`,
      `--secret=${secret}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise((resolve, reject) => {
    const ready = (/** @type {Buffer} */ chunk) => {
      if (chunk.toString().includes('Forwarding Webhook events')) resolve(undefined);
    };
    forwarder.stdout.on('data', ready);
    forwarder.stderr.on('data', ready);
    forwarder.on('exit', (code) => reject(new Error(`gh webhook forward exited ${code}`)));
  });
  return {
    stop() {
      forwarder.kill('SIGINT');
      server.close();
    },
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Client} client
 * @param {string} repo
 * @param {number} number
 * @param {{ intervalSeconds: number, until: ChangeState | null, timeoutSeconds: number }} options
 */
async function poll(client, repo, number, { intervalSeconds, until, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  /** @type {PullSnapshot | null} */
  let last = null;
  while (Date.now() < deadline) {
    const current = await pollPull(client, repo, number);
    if (!last || current.state !== last.state || current.headSha !== last.headSha) {
      console.log(`${new Date().toISOString()} PR #${number} state=${current.state} head=${current.headSha}`);
    }
    last = current;
    if (until && current.state === until) return current;
    await sleep(intervalSeconds * 1000);
  }
  return last;
}

/** @param {number[]} values @param {number} q */
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

/**
 * Makes `changes` pushes to the PR branch and times when the webhook listener and the poller each see the new head.
 * Both observers run for every change. The webhook observer makes no API calls, so it cannot skew the poller's count.
 * @param {Client} client
 * @param {string} repo
 * @param {number} number
 * @param {{ changes: number, intervalSeconds: number, port: number, out: string }} options
 */
async function perf(client, repo, number, { changes, intervalSeconds, port, out }) {
  const pull = (await github(client, 'GET', `/repos/${repo}/pulls/${number}`)).body;
  const branch = pull.head.ref;
  /** @type {Map<string, { webhook?: number, poll?: number }>} */
  const seen = new Map();
  /** @param {string} sha @param {'webhook' | 'poll'} channel @param {number} at */
  const mark = (sha, channel, at) => {
    const entry = seen.get(sha) ?? {};
    entry[channel] ??= at;
    seen.set(sha, entry);
  };
  const hooks = await startWebhooks({
    repo,
    port,
    out,
    onEvent: (event, _name, at) => {
      if (event.kind === 'push' && event.ref === `refs/heads/${branch}`) mark(event.headSha, 'webhook', at);
    },
  });
  const observer = { ...client, purpose: 'observe' };
  let polling = true;
  const pollStart = Date.now();
  let pollCalls = 0;
  const poller = (async () => {
    while (polling) {
      pollCalls += 1;
      const current = await pollPull(observer, repo, number);
      mark(current.headSha, 'poll', Date.now());
      await sleep(intervalSeconds * 1000);
    }
  })();
  const driver = { ...client, purpose: 'driver' };
  /** @type {{ i: number, sha: string, webhookMs: number, pollMs: number }[]} */
  const results = [];
  for (let i = 0; i < changes; i++) {
    await sleep(5000 + Math.random() * intervalSeconds * 1000);
    const sent = Date.now();
    const sha = await commitFile(
      driver,
      repo,
      branch,
      'spike/perf.txt',
      `change ${i} at ${new Date().toISOString()}\n`,
    );
    while (!(seen.get(sha)?.webhook && seen.get(sha)?.poll) && Date.now() - sent < 180_000) await sleep(250);
    const entry = seen.get(sha) ?? {};
    const row = {
      i,
      sha,
      webhookMs: entry.webhook ? entry.webhook - sent : Number.NaN,
      pollMs: entry.poll ? entry.poll - sent : Number.NaN,
    };
    results.push(row);
    console.log(`change ${i} ${sha.slice(0, 7)} webhook=${row.webhookMs} ms poll=${row.pollMs} ms`);
  }
  polling = false;
  await poller;
  hooks.stop();
  const hours = (Date.now() - pollStart) / 3_600_000;
  const webhook = results.map((r) => r.webhookMs).filter(Number.isFinite);
  const polled = results.map((r) => r.pollMs).filter(Number.isFinite);
  const summary = {
    changes,
    intervalSeconds,
    webhookSeen: webhook.length,
    pollSeen: polled.length,
    webhookP50Ms: quantile(webhook, 0.5),
    webhookP95Ms: quantile(webhook, 0.95),
    pollP50Ms: quantile(polled, 0.5),
    pollP95Ms: quantile(polled, 0.95),
    pollCalls,
    pollCallsPerPrPerHour: Math.round(pollCalls / hours),
    webhookCallsPerPrPerHour: 0,
  };
  writeFileSync(join(out, 'perf.json'), JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary));
  const pass = summary.pollSeen === changes && summary.pollP95Ms <= 60_000 && summary.pollCallsPerPrPerHour <= 120;
  console.log(pass ? 'PERF PASS' : 'PERF FAIL');
  return pass;
}

function token() {
  return process.env.GITHUB_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const USAGE = `usage: node spikes/P0-4/githost.mjs <command> --repo owner/name [options]
  lifecycle --factory f --task t   branch, PR, status, review with two line comments, checks, poll
  checks --ref sha                 check runs and commit statuses for a ref
  route                            assign open PRs to factories by branch prefix
  listen [--port n] [--seconds n]  forward webhooks to a local listener and parse them
  poll --pr n [--interval s] [--until merged] [--timeout s]
  perf --pr n [--changes 20] [--interval s] [--port n]
common: --out dir (api-calls.jsonl and deliveries go here)`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      factory: { type: 'string' },
      task: { type: 'string' },
      ref: { type: 'string' },
      pr: { type: 'string' },
      port: { type: 'string', default: '8787' },
      seconds: { type: 'string', default: '120' },
      interval: { type: 'string', default: '35' },
      until: { type: 'string' },
      timeout: { type: 'string', default: '600' },
      changes: { type: 'string', default: '20' },
      out: { type: 'string', default: join(tmpdir(), 'agent-works-p0-4') },
    },
  });
  const command = positionals[0];
  const repo = values.repo;
  if (!command || !repo) {
    console.error(USAGE);
    process.exit(2);
  }
  mkdirSync(values.out, { recursive: true });
  /** @type {Client} */
  const client = { token: token(), log: join(values.out, 'api-calls.jsonl'), purpose: command };
  const port = Number(values.port);
  if (command === 'lifecycle') {
    if (!values.factory || !values.task) throw new Error('lifecycle needs --factory and --task');
    await lifecycle(client, repo, { factory: values.factory, task: values.task });
  } else if (command === 'checks') {
    if (!values.ref) throw new Error('checks needs --ref');
    await readChecks(client, repo, values.ref);
  } else if (command === 'route') {
    await route(client, repo);
  } else if (command === 'listen') {
    const hooks = await startWebhooks({ repo, port, out: values.out, onEvent: () => {} });
    console.log(`listening for ${values.seconds} s`);
    await sleep(Number(values.seconds) * 1000);
    hooks.stop();
  } else if (command === 'poll') {
    const until = values.until === undefined ? null : /** @type {ChangeState} */ (values.until);
    await poll(client, repo, Number(values.pr), {
      intervalSeconds: Number(values.interval),
      until,
      timeoutSeconds: Number(values.timeout),
    });
  } else if (command === 'perf') {
    const pass = await perf(client, repo, Number(values.pr), {
      changes: Number(values.changes),
      intervalSeconds: Number(values.interval),
      port,
      out: values.out,
    });
    process.exitCode = pass ? 0 : 1;
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
