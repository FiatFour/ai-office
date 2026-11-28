import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CageShell } from '../../../server/agents/claude-code.ts';
import { claudeCode } from '../../../server/agents/claude-code.ts';
import { parseReview } from '../../../server/agents/runtime.ts';
import { scripted } from '../../../server/agents/scripted.ts';
import { type HttpRequest, type Transport, WriteRefused, writeProblem } from '../../../server/githost/host.ts';
import { FakeGithub } from '../../../server/test/fakes/github-api.ts';
import { canSpawnTs, hasSqlite, tempDir } from '../../../server/test/helpers.ts';
import { factoryArm, ticketOf } from '../../arms-live.ts';
import { TaskRefused } from '../../model.ts';
import {
  AUTHOR,
  adoptable,
  BASE_PREFIX,
  BENCH_LABEL,
  baseNameOf,
  benchHost,
  benchWrites,
  CI_PARALLEL,
  ciPending,
  hiddenTask,
  isTaskOutcome,
  listRemote,
  orphansOf,
  publicEnv,
  publishBaseline,
  REVIEWER,
  resetAt,
  resumeBranch,
  type Step,
  stopLine,
  sweepRemote,
  waitForCiSlot,
  withStderr,
} from '../arms.ts';
import {
  allowRerun,
  appendLine,
  claimIntent,
  heldBy,
  newSalt,
  pinBase,
  readJournal,
  setAsideTorn,
  TRANSIENT_CAP,
  transientCount,
} from '../journal.ts';
import { acquireLock } from '../lock.ts';
import { ciRunningMs, readCiWait, readWindow } from '../outcome.ts';
import type { Ci } from '../packet.ts';
import {
  ArmTimeout,
  appendRun,
  baseShaOf,
  classify,
  driveArms,
  entriesOf,
  finish,
  gradeAll,
  isFinal,
  PINNED_BASE,
  type RunRecord,
  readRuns,
  refuseOrphans,
  removeLeftovers,
  todo,
  verdictOf,
} from '../run.ts';
import { loadFrozen, type SetBTask } from '../task.ts';

const REPO = 'acme/app';
const tasks = loadFrozen(join(import.meta.dirname, '..')).tasks;

const harness = () => {
  const fake = new FakeGithub(REPO, 'success');
  const root = fake.refs.get('main') ?? '';
  const labels: Array<{ pr: number; labels: unknown }> = [];
  const log: string[] = [];
  const plain = fake.transport('aw-nova');
  const send: Transport = async (request: HttpRequest) => {
    const m = /\/issues\/(\d+)\/labels$/.exec(request.path);
    if (request.method === 'POST' && m !== null) {
      fake.calls.push(request);
      labels.push({ pr: Number(m[1]), labels: (request.body as { labels: unknown }).labels });
      return { status: 200, body: [] };
    }
    return plain(request);
  };
  return {
    fake,
    root,
    labels,
    log,
    send,
    note: (c: { method: string; path: string }) => log.push(`${c.method} ${c.path}`),
  };
};

const FILE = 'src/slug.js';

describe('the bench host on the public repo', () => {
  const ticket = 'bench/t-0a1b2c3d-r1';
  const make = (h: ReturnType<typeof harness>) =>
    benchHost({ repo: REPO, base: baseNameOf(ticket), baseSha: h.root, send: h.send, log: h.note });

  it('seeds the base at the pinned sha only, opens a draft PR with the aw-bench label, and merges nothing', async () => {
    const h = harness();
    const bench = make(h);
    await bench.seedBase();
    expect(h.fake.refs.get(baseNameOf(ticket))).toBe(h.root);
    const head = await bench.host.pushFiles(REPO, {
      branch: `aw/${ticket}`,
      base: baseNameOf(ticket),
      files: [{ path: FILE, content: 'fixed\n' }],
      message: 'fix it',
    });
    const change = await bench.host.openChange(REPO, {
      branch: `aw/${ticket}`,
      base: baseNameOf(ticket),
      title: 'fix it',
      body: 'body',
    });
    expect(change.headSha).toBe(head);
    expect(h.fake.prs.map((p) => ({ draft: p.draft, base: p.base }))).toEqual([
      { draft: true, base: baseNameOf(ticket) },
    ]);
    expect(h.labels).toEqual([{ pr: 1, labels: [BENCH_LABEL] }]);
    expect(h.fake.calls.some((c) => /merge/.test(c.path))).toBe(false);
    expect(h.fake.refs.get('main')).toBe(h.root);
  });

  it('refuses a base ref outside the bench prefix', async () => {
    const h = harness();
    const outside = benchHost({ repo: REPO, base: 'main', baseSha: h.root, send: h.send, log: h.note });
    await expect(outside.seedBase()).rejects.toThrow(WriteRefused);
    expect(BASE_PREFIX).toBe('aw-bench-base/');
    expect(h.fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses a push that changes anything under .github or CODEOWNERS before a single write', async () => {
    const h = harness();
    const bench = make(h);
    await bench.seedBase();
    const before = h.fake.calls.length;
    for (const path of [
      '.github/workflows/ci.yml',
      '.GitHub/x.yml',
      '.github/../.github/y',
      'CODEOWNERS',
      'docs/CODEOWNERS',
    ]) {
      await expect(
        bench.host.pushFiles(REPO, {
          branch: `aw/${ticket}`,
          base: baseNameOf(ticket),
          files: [
            { path: FILE, content: 'ok\n' },
            { path, content: 'x' },
          ],
          message: 'm',
        }),
        path,
      ).rejects.toThrow(/under \.github/);
    }
    expect(h.fake.calls.length).toBe(before);
  });

  it('closes only the PRs of its own work branch and never merges', async () => {
    const h = harness();
    const bench = make(h);
    await bench.seedBase();
    await bench.host.pushFiles(REPO, {
      branch: `aw/${ticket}`,
      base: baseNameOf(ticket),
      files: [{ path: FILE, content: 'a\n' }],
      message: 'm',
    });
    await bench.host.openChange(REPO, { branch: `aw/${ticket}`, base: baseNameOf(ticket), title: 't', body: 'b' });
    await expect(bench.closeWork('aw/alpha/t1')).rejects.toThrow(TaskRefused);
    expect(await bench.closeWork(`aw/${ticket}`)).toEqual([1]);
    expect(h.fake.prs.map((p) => ({ state: p.state, merged: p.merged }))).toEqual([{ state: 'closed', merged: false }]);
    await bench.dropRefs(`aw/${ticket}`);
    await bench.dropRefs(`aw/${ticket}`);
    expect(h.fake.refs.has(`aw/${ticket}`)).toBe(false);
    expect(h.fake.refs.has(baseNameOf(ticket))).toBe(false);
    expect(h.fake.refs.get('main')).toBe(h.root);
    expect(h.fake.calls.some((c) => /merge/.test(c.path))).toBe(false);
  });

  it('writes nothing outside its allowlist: no merge, no ready PR, no other label, no main', async () => {
    const h = harness();
    const writes = benchHost({ repo: REPO, base: baseNameOf(ticket), baseSha: h.root, send: h.send, log: h.note });
    await writes.seedBase();
    await expect(writes.dropRefs('main')).rejects.toThrow();
    expect(h.fake.refs.has('main')).toBe(true);
  });
});

describe('what a bench write may be', () => {
  const sha = 'c'.repeat(40);
  const base = 'aw-bench-base/t-0a1b2c3d-r1';
  const head = 'aw/bench/t-0a1b2c3d-r1';
  const home = `/repos/${REPO}`;
  const scope = { home, base };
  const problem = (method: HttpRequest['method'], path: string, body?: unknown) =>
    writeProblem(
      benchWrites(sha),
      body === undefined ? { method, path: `${home}${path}` } : { method, path: `${home}${path}`, body },
      scope,
    );

  it('allows the base ref, a draft PR, the aw-bench label, a close and a delete of its own branches', () => {
    expect(problem('POST', '/git/refs', { ref: `refs/heads/${base}`, sha })).toBeNull();
    expect(problem('POST', '/pulls', { title: 't', body: 'b', head, base, draft: true })).toBeNull();
    expect(problem('POST', '/issues/3/labels', { labels: [BENCH_LABEL] })).toBeNull();
    expect(problem('PATCH', '/pulls/3', { state: 'closed' })).toBeNull();
    expect(problem('DELETE', `/git/refs/heads/${head}`)).toBeNull();
    expect(problem('DELETE', `/git/refs/heads/${base}`)).toBeNull();
  });

  it('refuses a merge, a ready PR, another label, another sha, main, and a PR on another base', () => {
    const bad: Array<[HttpRequest['method'], string, unknown?]> = [
      ['PUT', '/pulls/3/merge', {}],
      ['POST', '/pulls/3/merge', {}],
      ['POST', '/pulls', { title: 't', body: 'b', head, base, draft: false }],
      ['POST', '/pulls', { title: 't', body: 'b', head, base }],
      ['POST', '/pulls', { title: 't', body: 'b', head, base: 'main', draft: true }],
      ['POST', '/issues/3/labels', { labels: ['bug'] }],
      ['POST', '/issues/3/labels', { labels: [BENCH_LABEL, 'bug'] }],
      ['POST', '/git/refs', { ref: `refs/heads/${base}`, sha: 'd'.repeat(40) }],
      ['POST', '/git/refs', { ref: 'refs/heads/main', sha }],
      ['PATCH', '/pulls/3', { state: 'open' }],
      ['PATCH', '/pulls/3', { state: 'closed', title: 'x' }],
      ['DELETE', '/git/refs/heads/main'],
      ['DELETE', '/git/refs/heads/aw/alpha/t1'],
      ['DELETE', '/git/refs/heads/aw-bench-base/main'],
      ['PATCH', '/git/refs/heads/main', { sha, force: true }],
    ];
    for (const [method, path, body] of bad) expect(problem(method, path, body), `${method} ${path}`).not.toBeNull();
  });
});

describe.skipIf(!hasSqlite)('the factory arm on the public repo, with a scripted crew', () => {
  it('opens one draft labelled PR on a random branch and base, at the head the review settled on', async () => {
    const h = harness();
    const FIX = 'export const x = 1;\n';
    const script = {
      author: [{ files: [{ path: FILE, content: FIX }] }],
      reviews: [{ verdict: 'approve' as const, body: 'ok', comments: [] }],
    };
    const runtime = scripted({ scripts: new Proxy({}, { get: () => script }) as never });
    const withUsage = {
      id: runtime.id,
      async run(job: Parameters<typeof runtime.run>[0]) {
        const said = await runtime.run(job);
        const result =
          said.role === 'reviewer'
            ? { role: 'reviewer' as const, ...parseReview(`\`\`\`json\n${JSON.stringify(said)}\n\`\`\``) }
            : said;
        return {
          ...result,
          usage: { inputTokens: 1, outputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 1000, webRequests: 0 },
        };
      },
    };
    const task = tasks[0] as SetBTask;
    const hidden = hiddenTask(task, 'ab12cd34') as never;
    const env = publicEnv({
      repo: REPO,
      baseSha: h.root,
      send: h.send,
      log: h.note,
      workers: { [AUTHOR]: withUsage, [REVIEWER]: withUsage },
      home: () => tempDir('setb-hq'),
      pollMs: 30,
      settleMs: 10,
      reviewPollMs: 30,
    });
    const ran = await factoryArm(env).run(hidden, undefined as never, new AbortController().signal, 1);
    expect(ran.note).toContain('PR #1');
    expect(ran.tokens).toMatchObject({ input: 2, output: 20 });
    const [pr] = h.fake.prs;
    expect(pr).toMatchObject({ draft: true, state: 'open', merged: false });
    expect(pr?.head).toMatch(/^aw\/bench\/t-[0-9a-f]{8}-r1$/);
    expect(pr?.base).toMatch(/^aw-bench-base\/t-[0-9a-f]{8}-r1$/);
    expect(`${pr?.head}${pr?.base}`).not.toContain(task.id);
    expect(h.labels).toEqual([{ pr: 1, labels: [BENCH_LABEL] }]);
    expect(h.fake.calls.some((c) => /merge/.test(c.path) || (c.method === 'PATCH' && /pulls/.test(c.path)))).toBe(
      false,
    );
    expect(h.fake.filesAt(pr?.head ?? '').get(FILE)).toBe(FIX);
  });
});

const claudeShell = (err: string, out: string, code: number, timedOut = false): CageShell => ({
  renew: async () => {},
  async exec(argv) {
    if (argv.includes('rev-parse')) return { code: 0, out: 'abc123\n', err: '', timedOut: false };
    if (!argv.includes('--output-format')) return { code: 0, out: '', err: '', timedOut: false };
    return { code, out, err, timedOut };
  },
});
const authorJob = {
  role: 'author' as const,
  task: 'bench/t-0a1b2c3d-r1',
  worker: 'baseline',
  ticket: { id: 'bench/t-0a1b2c3d-r1', kind: 'defect' as const, title: 't', body: 'b', url: null, risk: null },
  round: 0,
  comments: [],
  signal: new AbortController().signal,
};
const thrownBy = async (shell: CageShell): Promise<string> => {
  try {
    await claudeCode({ shell: () => withStderr(shell) }).run(authorJob);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('claude did not fail');
};
const message = (err: string, out = '', code = 1) => thrownBy(claudeShell(err, out, code));
const resultOf = (result: string, subtype = 'success', is_error = true): string =>
  `${JSON.stringify({ type: 'result', subtype, is_error, result })}\n`;
/** A session a model really ended: its last message, then the success line. */
const worked = (text: string, model = 'claude-sonnet'): string =>
  `${JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'text', text }] } })}\n${resultOf(text, 'success', false)}`;
const statusOf = (m: string) => classify(m, new Date('2026-11-25T00:00:00Z')).status;
const status = async (err: string, out = '', code = 1) => statusOf(await message(err, out, code));

/** Every stop message the verifier of round 3 ran, with how it must be recorded whichever stream carries it. */
const STOPS: ReadonlyArray<readonly [string, 'auth' | 'aborted']> = [
  ["You've hit your session limit · resets 3pm", 'aborted'],
  ["You've hit your weekly limit · resets Mon 8am", 'aborted'],
  ["You've hit your monthly spend limit · /usage-credits to raise it", 'aborted'],
  ["You've hit your channel's monthly spend limit.", 'aborted'],
  ["You've reached your Fable limit for this week", 'aborted'],
  ["You're out of usage credits · resets 3pm", 'aborted'],
  ['Your org is out of usage · add funds to continue', 'aborted'],
  ['Not logged in · Please run /login', 'auth'],
  ['Login expired · Please run /login', 'auth'],
  ['Login reached its time limit · Please run /login', 'auth'],
  ['Authentication required · Sign in again to continue', 'auth'],
  ['Invalid API key · Fix external API key', 'auth'],
  ['API Error: 401 Invalid API key · Please run /login', 'auth'],
  ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'],
  ['Credit balance is too low', 'aborted'],
  ['API Error: Repeated 529 Overloaded errors', 'aborted'],
  ['Repeated 529 Overloaded errors', 'aborted'],
  ['Opus is experiencing high load, please use /model to switch to Sonnet', 'aborted'],
  ['Server is temporarily limiting requests (not your usage limit)', 'aborted'],
  ['The API is temporarily unavailable', 'aborted'],
  ['API Error: Request timed out.', 'aborted'],
  ['API Error: Connection error.', 'aborted'],
  ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'aborted'],
  ['Claude AI usage limit reached|1795680000', 'aborted'],
  ['5-hour limit reached ∙ resets 7pm', 'aborted'],
  ["You've hit your limit · resets 3pm (Europe/London)", 'aborted'],
];

describe('a session that ends abnormally is never final', () => {
  it.each(STOPS)('%s', async (text, expected) => {
    for (const code of [1, 0]) {
      expect(await status('', resultOf(text), code), `stdout, exit ${code}`).toBe(expected);
      expect(await status(text, '', code), `stderr, exit ${code}`).toBe(expected);
      expect(await status(text, resultOf('Execution error', 'error_during_execution'), code), 'both').toBe(expected);
    }
    expect(statusOf(`job failed: ${await message('', resultOf(text))}`)).toBe(expected);
  });

  it.each([
    ['an empty reply with exit 0', '', '', 0],
    ['an empty reply with exit 1', '', '', 1],
    ['a kill with exit 137', '', '', 137],
    ['text that is not json', '', 'Error: something\n', 1],
    ['a crash on stderr', 'Segmentation fault\n', '', 139],
    ['an error result nobody has seen', '', resultOf('A message from next year'), 1],
    ['a success line with a nonzero exit', '', worked('done'), 1],
    ['a success line with an empty reply', '', resultOf('', 'success', false), 0],
    ['max turns on stderr only', "You've hit your max turns\n", '', 1],
    ['a long prompt on stderr only', 'Prompt is too long\n', '', 1],
  ])('%s', async (_name, err, out, code) => {
    expect(await status(err, out, code)).toBe('aborted');
  });

  it('records 429 and 529 as transient, so the capped retries apply', async () => {
    for (const text of [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      'API Error: 429 rate_limit_error',
      'overloaded_error',
    ]) {
      expect(await status('', resultOf(text)), text).toBe('transient');
      expect(await status(`${text}\n`), text).toBe('transient');
    }
  });

  it('reads a transient stop only as a provider message, not as words inside another failure', () => {
    for (const text of [
      'claude ended with success: the code now retries on API Error: 529',
      'POST /repos/FiatFour/ai-office/pulls -> 422 {"message":"overloaded_error is not a branch"}',
    ])
      expect(statusOf(text), text).toBe('aborted');
  });

  it('reads a stop that claude printed on stdout outside the stream', async () => {
    expect(await status('', 'Not logged in\n', 1)).toBe('auth');
  });

  it('explains Execution error with what stderr says', async () => {
    const out = resultOf('Execution error', 'error_during_execution');
    expect(await status('API Error: 529 overloaded\n', out)).toBe('transient');
    expect(await message('container is gone\n', out)).toContain('container is gone');
  });

  it('records the exit code of an empty reply', async () => {
    expect(await message('', '', 137)).toContain('empty reply with exit 137');
  });

  it('keeps the raw text, and the reset time when the message states one', async () => {
    const m = await message('some warning\nClaude AI usage limit reached|1795680000\n');
    expect(m).toContain('Claude AI usage limit reached|1795680000');
    expect(classify(m, new Date())).toEqual({ status: 'aborted', resetAt: 1795680000_000 });
    const timed = await message("You've hit your session limit · resets 3pm\n");
    expect(classify(timed, new Date('2026-11-25T00:00:00Z')).resetAt).not.toBeNull();
  });

  it('records errors of the harness, the engine and GitHub as aborted', () => {
    for (const text of [
      'POST /repos/FiatFour/ai-office/git/refs -> 502 {"message":"Server Error"}',
      'docker run -d --name failed (exit 125): no space left on device',
      'no retry after the first failure: bench/t-0a1b2c3d-r1 author 0 failed: the cage repo has no HEAD: x',
      'no retry after the first failure: the file path "x" is fine but GitHub said 500',
      'HQ refused the ticket: x',
      'no PR on aw/bench/t-0a1b2c3d-r1',
      'bench/t-0a1b2c3d-r1 reviewer 1 failed: claude ended with success: it says claude finished without committing a change',
      'refusing POST /repos/FiatFour/ai-office/pulls on github: a bench PR opens as a draft',
    ])
      expect(statusOf(text), text).toBe('aborted');
  });

  it('stops a failed git command in the cage before it can read as a session with no change', async () => {
    const shell: CageShell = {
      renew: async () => {},
      async exec(argv) {
        if (argv.includes('rev-parse')) return { code: 0, out: 'abc123\n', err: '', timedOut: false };
        if (argv.includes('diff')) return { code: 137, out: '', err: 'container is not running', timedOut: false };
        return { code: 0, out: worked('done'), err: '', timedOut: false };
      },
    };
    const m = await thrownBy(shell);
    expect(m).toContain('git in the cage exited 137');
    expect(statusOf(m)).toBe('aborted');
  });
});

describe('what is a result of the task, and final', () => {
  it.each([
    ['max turns in the result', '', resultOf("You've hit your max turns"), 1],
    [
      'max turns by subtype',
      '',
      `${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })}\n`,
      1,
    ],
    ['a long prompt', '', resultOf('Prompt is too long'), 1],
    ['max turns beside a stderr warning', 'a warning\n', resultOf("You've hit your max turns"), 1],
    ['no committed change', '', worked('I could not do it'), 0],
  ])('%s', async (_name, err, out, code) => {
    expect(await status(err, out, code)).toBe('failed');
  });

  it('reads the refusals and the reviewer failures as the real code throws them', async () => {
    const h = harness();
    const ticket = 'bench/t-0a1b2c3d-r1';
    const bench = benchHost({ repo: REPO, base: baseNameOf(ticket), baseSha: h.root, send: h.send, log: h.note });
    await bench.seedBase();
    const push = (path: string) =>
      bench.host
        .pushFiles(REPO, {
          branch: `aw/${ticket}`,
          base: baseNameOf(ticket),
          files: [{ path, content: 'x' }],
          message: 'm',
        })
        .then(
          () => 'pushed',
          (error: Error) => error.message,
        );
    for (const path of ['.github/workflows/ci.yml', 'src/.env'])
      expect(statusOf(await push(path)), path).toBe('failed');
    for (const reply of ['no verdict here', '```json\n{"verdict":"approve"}\n```\n"verdict": "changes",']) {
      let thrown = '';
      try {
        parseReview(reply);
      } catch (error) {
        thrown = (error as Error).message;
      }
      expect(statusOf(thrown), reply).toBe('failed');
    }
    const binary: CageShell = {
      renew: async () => {},
      async exec(argv) {
        if (argv.includes('rev-parse')) return { code: 0, out: 'abc123\n', err: '', timedOut: false };
        if (argv.includes('--numstat')) return { code: 0, out: '-\t-\ta.png\0', err: '', timedOut: false };
        return { code: 0, out: worked('done'), err: '', timedOut: false };
      },
    };
    expect(statusOf(await thrownBy(binary))).toBe('failed');
  });

  it('counts the session time limit as final, and a stop printed while it ran as not', async () => {
    expect(statusOf(await thrownBy(claudeShell('', '', -1, true)))).toBe('failed');
    expect(statusOf(await thrownBy(claudeShell('Not logged in\n', '', -1, true)))).toBe('auth');
    expect(statusOf(await thrownBy(claudeShell('API Error: 529 x\n', '', -1, true)))).toBe('transient');
  });

  it('reads the factory forms of a result, each with the wrappers it arrives in', () => {
    const turn = 'bench/t-0a1b2c3d-r1';
    for (const text of [
      `no retry after the first failure: ${turn} author 1 failed: claude finished without committing a change`,
      `no retry after the first failure: ${turn} author 0 failed: claude committed the binary file a.png; HQ pushes text files only`,
      `no retry after the first failure: ${turn} reviewer 1 failed: claude ended with success: Prompt is too long`,
      `job failed: ${turn} reviewer 1 failed: the reviewer gave no json block with a verdict of approve, changes or comment. Reviewer text: x`,
      'no retry after the first failure: the fix round changed no file',
      'the reviewer still asked for changes at the round limit',
      'refusing to push a change under .github: .github/workflows/x.yml',
      'refusing POST /repos/FiatFour/ai-office/git/trees on github: the file path ".env" is empty, hidden or holds a backslash',
      'the host refused what the crew pushed, so nothing is graded: refusing to push a change under .github: CODEOWNERS',
    ])
      expect(statusOf(text), text).toBe('failed');
  });

  it("records the arm's time limit as final, and any other abort or error as not", () => {
    const timed = new AbortController();
    timed.abort(new ArmTimeout());
    const now = new Date();
    for (const error of [timed.signal.reason, new DOMException('x', 'AbortError'), new Error('the run was aborted')])
      expect(verdictOf(error, timed.signal, now).status).toBe('failed');
    expect(verdictOf(new Error('POST /x -> 500'), timed.signal, now).status).toBe('aborted');
    const killed = new AbortController();
    killed.abort(new Error('the driver was stopped by a signal'));
    expect(verdictOf(new Error('the run was aborted'), killed.signal, now).status).toBe('aborted');
    expect(verdictOf(new Error('the run was aborted'), new AbortController().signal, now).status).toBe('aborted');
  });
});

describe('claude stderr and reset times', () => {
  it('puts an auth line first, wherever it was printed', async () => {
    const QUOTA = 'Claude AI usage limit reached|1764000000\n';
    const AUTH = 'Failed to authenticate. API Error: 401\n';
    expect(stopLine(`${QUOTA}${AUTH}`)).toMatch(/^Failed to authenticate/);
    expect(await status(`API Error: 529 overloaded\n${AUTH}`)).toBe('auth');
    expect(await status(`${QUOTA}${AUTH}`)).toBe('auth');
    expect(await status(AUTH, resultOf("You've hit your limit · resets 3pm"))).toBe('auth');
    expect(await status(AUTH, resultOf('tests broke', 'success', false), 1)).toBe('auth');
    expect(await status(QUOTA, resultOf('OAuth token revoked'))).toBe('auth');
  });

  it('does not override a successful result with what stderr says', async () => {
    const ran = await withStderr(claudeShell('Not logged in\n', worked('done'), 0)).exec([
      'claude',
      '--output-format',
      'stream-json',
    ]);
    expect(ran.out).toBe(worked('done'));
  });

  it('reads no reset time, and does not throw, when the parentheses name no time zone', () => {
    expect(resetAt('resets 3pm (see /usage)', new Date())).toBeNull();
  });

  it('turns the stated reset time into the next such time, in the stated zone', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    expect(resetAt('Claude AI usage limit reached|1764000000', now)).toBe(1764000000_000);
    const at = resetAt("You've hit your limit · resets 3pm (Asia/Bangkok)", now) as number;
    expect(new Date(at).toISOString()).toBe('2026-11-25T08:00:00.000Z'.replace('25T08', '26T08'));
    expect(resetAt('resets 5:30pm (UTC)', now)).toBe(Date.parse('2026-11-25T17:30:00Z'));
    expect(resetAt('resets 9am (UTC)', now)).toBe(Date.parse('2026-11-26T09:00:00Z'));
    expect(resetAt('no time here', now)).toBeNull();
  });
});

describe('the CI cap', () => {
  const ci = (state: Ci['state']): Ci => ({ sha: 'a'.repeat(40), state, note: '', checks: 1 });

  it('treats running CI as pending, and a head with no checks yet as pending only while it is fresh', () => {
    expect(ciPending(ci('pending'), 0, 1e9)).toBe(true);
    expect(ciPending(ci('green'), 0, 1e9)).toBe(false);
    expect(ciPending(ci('red'), 0, 1e9)).toBe(false);
    expect(ciPending(ci('none'), 1e9 - 60_000, 1e9)).toBe(true);
    expect(ciPending(ci('none'), 1e9 - 3_600_000, 1e9)).toBe(false);
  });

  it('waits while 2 heads run CI and goes on the moment one finishes', async () => {
    expect(CI_PARALLEL).toBe(2);
    const state = new Map<string, Ci['state']>([
      ['a', 'pending'],
      ['b', 'pending'],
      ['c', 'green'],
    ]);
    const slept: number[] = [];
    const heads = ['a', 'b', 'c'].map((sha) => ({ sha, since: 0 }));
    await waitForCiSlot(
      heads,
      async (sha) => ci(state.get(sha) ?? 'green'),
      async (ms) => {
        slept.push(ms);
        if (slept.length === 3) state.set('b', 'green');
      },
      () => 1e12,
    );
    expect(slept).toHaveLength(3);
    await waitForCiSlot(
      heads.slice(0, 1),
      async () => ci('pending'),
      async () => expect.unreachable(),
      () => 1e12,
    );
  });
});

describe('the run log', () => {
  const rec = (
    task: string,
    arm: 'factory' | 'baseline',
    status: RunRecord['status'],
    pr: number | null = null,
  ): RunRecord => ({
    task,
    arm,
    status,
    stage: 1,
    branch: null,
    pr,
    readyHeadSha: pr === null ? null : 'b'.repeat(40),
    wallMs: 1,
    tokens: null,
    reviewRounds: null,
    note: '',
    startedAt: '2026-11-25T00:00:00Z',
    resetAt: null,
    baseSha: 'c'.repeat(40),
  });

  it('alternates which arm goes first, skips final runs and reruns a quota or auth stop', () => {
    const first = todo(tasks, []);
    expect(first).toHaveLength(20);
    expect(first.slice(0, 4).map((t) => t.arm)).toEqual(['factory', 'baseline', 'baseline', 'factory']);
    const id = (tasks[0] as SetBTask).id;
    const left = todo(tasks, [rec(id, 'factory', 'done', 5), rec(id, 'baseline', 'aborted')]);
    expect(left).toHaveLength(19);
    expect(left[0]).toMatchObject({ arm: 'baseline' });
    expect(todo(tasks, [rec(id, 'factory', 'failed')]).some((t) => t.task.id === id && t.arm === 'factory')).toBe(
      false,
    );
    expect(isFinal(rec(id, 'factory', 'auth'))).toBe(false);
    expect(isFinal(rec(id, 'factory', 'aborted'))).toBe(false);
  });

  it('lists only done runs with a PR as graded entries, and round-trips the file', () => {
    const file = join(tempDir('setb-runs'), 'out', 'runs.jsonl');
    const id = (tasks[0] as SetBTask).id;
    for (const r of [
      rec(id, 'factory', 'done', 7),
      rec(id, 'baseline', 'failed', 8),
      rec((tasks[1] as SetBTask).id, 'factory', 'aborted', 9),
    ])
      appendRun(file, r);
    expect(readRuns(file)).toHaveLength(3);
    expect(entriesOf(tasks, readRuns(file))).toEqual([
      { task: id, arm: 'factory', pr: 7, readyHeadSha: 'b'.repeat(40) },
    ]);
  });
});

class Killed extends Error {}

describe('a killed baseline run resumes without orphans', () => {
  const task = tasks[0] as SetBTask;
  const FIXED = 'export const x = 1;\n';

  const session = (h: ReturnType<typeof harness>, journal: string) => async (killAt?: Step) => {
    const { intent, resumed } = claimIntent(journal, task, 'baseline', h.root);
    const bench = benchHost({ repo: REPO, base: intent.base, baseSha: h.root, send: h.send, log: h.note });
    if (resumed) {
      const adopted = await resumeBranch(bench, REPO, intent.branch, async () => true);
      if (adopted !== null) return adopted;
    }
    const ticket = ticketOf(hiddenTask(task, intent.salt) as never, 1);
    const made = await publishBaseline({
      bench,
      repo: REPO,
      branch: intent.branch,
      base: intent.base,
      ticket,
      files: [{ path: FILE, content: FIXED }],
      after: (step) => {
        if (step === killAt) throw new Killed(step);
      },
    });
    return made.change;
  };

  it.each(['seedBase', 'push', 'openChange'] as const)(
    'after %s: the rerun opens exactly one PR for the task and arm and leaves nothing behind',
    async (killAt) => {
      const h = harness();
      const journal = join(tempDir('setb-resume'), 'runs.jsonl');
      const run = session(h, journal);
      await expect(run(killAt)).rejects.toBeInstanceOf(Killed);
      const [intent] = readJournal(journal).intents;
      expect(intent, 'the intent is journaled before the first remote write').toBeDefined();
      const change = await run();
      expect(h.fake.prs, 'one PR in all, open or closed').toHaveLength(1);
      expect(h.fake.prs.filter((p) => p.state === 'open')).toHaveLength(1);
      expect(readJournal(journal).intents, 'the rerun reuses the intent').toEqual([intent]);
      expect(change.number).toBe(1);
      const remote = await listRemote(h.send, REPO);
      expect([...remote.refs].sort()).toEqual([intent?.branch, intent?.base].sort());
      expect(orphansOf(remote, readJournal(journal).intents)).toEqual({ refs: [], pulls: [] });
      const bench = benchHost({ repo: REPO, base: intent?.base ?? '', baseSha: h.root, send: h.send, log: h.note });
      const swept = await sweepRemote(bench, remote);
      expect(swept.closed).toEqual([1]);
      expect([...h.fake.refs.keys()].filter((r) => /^aw/.test(r))).toEqual([]);
      expect(h.fake.prs.every((p) => p.state === 'closed' && !p.merged)).toBe(true);
    },
  );

  it.each(['seedBase', 'push'] as const)(
    'finds the refs of a run killed after %s and no PR (pr is null) by prefix, with no journal at all',
    async (killAt) => {
      const h = harness();
      const run = session(h, join(tempDir('setb-resume'), 'runs.jsonl'));
      await expect(run(killAt)).rejects.toBeInstanceOf(Killed);
      expect(h.fake.prs).toHaveLength(0);
      const remote = await listRemote(h.send, REPO);
      expect(remote.refs.length).toBeGreaterThan(0);
      expect(orphansOf(remote, [])).toMatchObject({ pulls: [] });
      expect(orphansOf(remote, []).refs).toEqual(remote.refs);
      const bench = benchHost({
        repo: REPO,
        base: `${BASE_PREFIX}t-00000000-r1`,
        baseSha: h.root,
        send: h.send,
        log: h.note,
      });
      await sweepRemote(bench, remote);
      expect([...h.fake.refs.keys()].filter((r) => /^aw/.test(r))).toEqual([]);
    },
  );

  it('opens the baseline PR with the same title, body and commit message template as the factory', async () => {
    const h = harness();
    const journal = join(tempDir('setb-resume'), 'runs.jsonl');
    await session(h, journal)();
    const [intent] = readJournal(journal).intents;
    const id = intent?.branch.replace(/^aw\//, '') ?? '';
    const [pr] = h.fake.prs;
    expect(pr?.title).toBe(`${id}: ${task.title}`);
    expect(pr?.body).toContain(`Work order \`${id}\``);
    expect(pr?.body).toContain('Opened by an Agent Works worker');
  });

  it('sweeps by prefix and never touches main', async () => {
    const h = harness();
    const run = session(h, join(tempDir('setb-resume'), 'runs.jsonl'));
    await run();
    const bench = benchHost({
      repo: REPO,
      base: `${BASE_PREFIX}t-00000000-r1`,
      baseSha: h.root,
      send: h.send,
      log: h.note,
    });
    await sweepRemote(bench, await listRemote(h.send, REPO));
    expect(h.fake.refs.has('main')).toBe(true);
  });

  it('refuses to sweep when a bench PR is merged', async () => {
    const h = harness();
    await session(h, join(tempDir('setb-resume'), 'runs.jsonl'))();
    h.fake.mergeByHuman(1);
    const bench = benchHost({
      repo: REPO,
      base: `${BASE_PREFIX}t-00000000-r1`,
      baseSha: h.root,
      send: h.send,
      log: h.note,
    });
    await expect(sweepRemote(bench, await listRemote(h.send, REPO))).rejects.toThrow(/merged/);
  });

  it('a rerun after a stop that left a PR open adopts that PR (baseline), on the same branch', async () => {
    const h = harness();
    const journal = join(tempDir('setb-resume'), 'runs.jsonl');
    const run = session(h, journal);
    const first = await run();
    const second = await run();
    expect(second.number).toBe(first.number);
    expect(h.fake.prs).toHaveLength(1);
  });

  it('closes an unsettled PR of a resumed arm and drops its refs, so the arm starts from nothing on the same names', async () => {
    const h = harness();
    const journal = join(tempDir('setb-resume'), 'runs.jsonl');
    const first = await session(h, journal)();
    const { intent } = claimIntent(journal, task, 'baseline', h.root);
    const bench = benchHost({ repo: REPO, base: intent.base, baseSha: h.root, send: h.send, log: h.note });
    const taken = await resumeBranch(bench, REPO, intent.branch, async () => false);
    expect(taken).toBeNull();
    expect(h.fake.prs.find((p) => p.number === first.number)?.state).toBe('closed');
    expect(h.fake.refs.has(intent.branch)).toBe(false);
    expect(h.fake.refs.has(intent.base)).toBe(false);
  });
});

describe('the journal', () => {
  const task = tasks[0] as SetBTask;

  it('writes the intent before any remote write, and a resume reuses its salt, branch and base', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    const first = claimIntent(file, task, 'factory', 'a'.repeat(40), () => 'deadbeef');
    expect(first.resumed).toBe(false);
    expect(readJournal(file).intents).toEqual([first.intent]);
    expect(first.intent).toMatchObject({ task: task.id, arm: 'factory', salt: 'deadbeef', baseSha: 'a'.repeat(40) });
    expect(first.intent.branch).toMatch(/^aw\/bench\/t-[0-9a-f]{8}-r1$/);
    expect(first.intent.base).toMatch(/^aw-bench-base\/t-[0-9a-f]{8}-r1$/);
    const again = claimIntent(file, task, 'factory', 'a'.repeat(40), () => 'cafef00d');
    expect(again).toEqual({ intent: first.intent, resumed: true });
    const other = claimIntent(file, task, 'baseline', 'a'.repeat(40), () => 'cafef00d');
    expect(other.resumed).toBe(false);
    expect(other.intent.branch).not.toBe(first.intent.branch);
    expect(newSalt()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pins the base on the first line and refuses a different --base-sha afterwards', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    pinBase(file, 'a'.repeat(40));
    pinBase(file, 'a'.repeat(40));
    expect(readJournal(file).header).toMatchObject({ kind: 'header', baseSha: 'a'.repeat(40) });
    expect(() => pinBase(file, 'b'.repeat(40))).toThrow(/pinned to base a+, not b+/);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('refuses a header that disagrees with the base of an intent or of a run record', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    for (const record of [
      { kind: 'intent', task: 'x', arm: 'factory', baseSha: A },
      { task: 'x', arm: 'factory', status: 'done', baseSha: A },
    ]) {
      const file = join(tempDir('setb-journal'), 'runs.jsonl');
      appendLine(file, { kind: 'header', baseSha: B, createdAt: 'x' });
      appendLine(file, record);
      expect(() => pinBase(file, B)).toThrow(/a record for x factory says a+/);
    }
  });

  it('skips a torn last line without losing a whole one, and sets it aside before the next append', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    pinBase(file, 'a'.repeat(40));
    const { intent } = claimIntent(file, task, 'factory', 'a'.repeat(40));
    const torn = '{"kind":"intent","task":"x';
    appendFileSync(file, torn);
    expect(readJournal(file)).toMatchObject({ intents: [intent], torn });
    pinBase(file, 'a'.repeat(40));
    const next = claimIntent(file, task, 'baseline', 'a'.repeat(40));
    expect(readJournal(file)).toMatchObject({ intents: [intent, next.intent], torn: null });
    expect(readFileSync(`${file}.torn`, 'utf8')).toBe(`${torn}\n`);
    expect(setAsideTorn(file)).toBeNull();
  });

  it('keeps a whole last line that only lacks its newline, and appends after it', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    writeFileSync(file, JSON.stringify({ kind: 'intent', task: 'x' }));
    appendLine(file, { kind: 'intent', task: 'y' });
    expect(readJournal(file).intents.map((i) => i.task)).toEqual(['x', 'y']);
    expect(existsSync(`${file}.torn`)).toBe(false);
  });

  it('refuses a journal that has records but no header', () => {
    const file = join(tempDir('setb-journal'), 'runs.jsonl');
    claimIntent(file, task, 'factory', 'a'.repeat(40));
    expect(() => pinBase(file, 'a'.repeat(40))).toThrow(/no header/);
  });

  it('counts transient records per task and arm, and a transient record is not final', () => {
    const rec = (status: RunRecord['status'], arm: 'factory' | 'baseline'): RunRecord => ({
      task: task.id,
      arm,
      status,
      stage: 1,
      branch: null,
      pr: null,
      readyHeadSha: null,
      wallMs: 1,
      tokens: null,
      reviewRounds: null,
      note: '',
      startedAt: '2026-11-25T00:00:00Z',
      resetAt: null,
      baseSha: 'c'.repeat(40),
    });
    const runs = [rec('transient', 'factory'), rec('transient', 'factory'), rec('transient', 'baseline')];
    expect(TRANSIENT_CAP).toBe(3);
    expect(transientCount(runs, task.id, 'factory')).toBe(2);
    expect(isFinal(rec('transient', 'factory'))).toBe(false);
    expect(todo(tasks, runs).some((t) => t.task.id === task.id && t.arm === 'factory')).toBe(true);
  });
});

describe('how a finished arm is recorded', () => {
  const ran = { note: 'n', tokens: null, reviewRounds: 2 } as never;

  it('records a host refusal after round 0 as a final failure, never as done on the rejected head', () => {
    const out = finish(
      {
        ...(ran as object),
        refused: true,
        note: 'the host refused what the crew pushed, so nothing is graded: refusing to push a change under .github: x',
      } as never,
      { number: 7, headSha: 'f'.repeat(40) },
      'aw/bench/t-0a1b2c3d-r1',
    );
    expect(out).toMatchObject({ status: 'failed', pr: 7, readyHeadSha: null });
    expect(isFinal({ status: out.status } as RunRecord)).toBe(true);
  });

  it('records any other refused write as aborted', () => {
    const note = 'the host refused what the crew pushed, so nothing is graded: refusing POST /x on github: not allowed';
    expect(finish({ ...(ran as object), refused: true, note } as never, null, 'b').status).toBe('aborted');
  });

  it('records a normal finish with a PR as done at its head, and one without a PR as a failure', () => {
    expect(finish(ran, { number: 7, headSha: 'f'.repeat(40) }, 'b')).toMatchObject({
      status: 'done',
      pr: 7,
      readyHeadSha: 'f'.repeat(40),
    });
    expect(finish(ran, null, 'aw/b')).toMatchObject({ status: 'aborted', pr: null });
  });
});

describe.skipIf(!hasSqlite)('a factory refusal after round 0', () => {
  it('is flagged refused by the arm, so a live run records it as failed', async () => {
    const h = harness();
    const refuses = {
      id: 'claude-code' as const,
      async run(): Promise<never> {
        throw new WriteRefused('refusing a write');
      },
    };
    const env = publicEnv({
      repo: REPO,
      baseSha: h.root,
      send: h.send,
      log: h.note,
      workers: { [AUTHOR]: refuses, [REVIEWER]: refuses },
      home: () => tempDir('setb-hq'),
      pollMs: 30,
      settleMs: 10,
      reviewPollMs: 30,
    });
    const arm = await factoryArm(env).run(
      hiddenTask(tasks[0] as SetBTask, 'ab12cd34') as never,
      undefined as never,
      new AbortController().signal,
      1,
    );
    expect(arm.refused).toBe(true);
    expect(arm.note).toMatch(/nothing is graded/);
  });
});

describe.skipIf(!hasSqlite)('a factory arm whose check stays red', () => {
  const redRun = async (author: (round: number) => string) => {
    const h = harness();
    const rounds: number[] = [];
    const set = h.fake.setStatus.bind(h.fake);
    h.fake.setStatus = (sha, context) => set(sha, context, 'failure');
    const worker = {
      id: 'claude-code' as const,
      async run(job: { round: number }) {
        rounds.push(job.round);
        return {
          role: 'author' as const,
          files: [{ path: FILE, content: author(job.round) }],
          message: 'm',
          usage: null,
        };
      },
    };
    const env = publicEnv({
      repo: REPO,
      baseSha: h.root,
      send: h.send,
      log: h.note,
      workers: { [AUTHOR]: worker, [REVIEWER]: worker },
      home: () => tempDir('setb-hq'),
      pollMs: 30,
      settleMs: 10,
      reviewPollMs: 30,
    });
    const hidden = hiddenTask(tasks[0] as SetBTask, 'ab12cd34') as never;
    const error = await factoryArm(env)
      .run(hidden, undefined as never, new AbortController().signal, 1)
      .then(
        () => {
          throw new Error('the arm did not fail');
        },
        (failed: Error) => failed.message,
      );
    return { error, rounds };
  };

  it('ends at the round limit with that reason, which is a result of the task', async () => {
    const { error, rounds } = await redRun((round) => `export const v = ${round};\n`);
    expect(error).toBe('CI was still red at the round limit: ci');
    expect(rounds).toEqual([0, 1, 2, 3]);
    expect(isTaskOutcome(error)).toBe(true);
  });

  it('names the red check when the fix round changes nothing, and still counts as a result of the task', async () => {
    const { error } = await redRun(() => 'export const v = 0;\n');
    expect(error).toMatch(/the fix round changed no file \[CI red: ci\]$/);
    expect(isTaskOutcome(error)).toBe(true);
  });

  it('does not turn an unknown failure into a result of the task by naming a red check', () => {
    expect(isTaskOutcome('job failed: socket hang up [CI red: ci]')).toBe(false);
  });
});

describe('a PR killed before it was labelled', () => {
  it('is still found by its head prefix and closed', async () => {
    const h = harness();
    const unlabelled: Transport = async (request) => {
      if (/\/labels$/.test(request.path)) throw new Killed('labels');
      return h.send(request);
    };
    const [task] = tasks as [SetBTask];
    const intent = claimIntent(join(tempDir('setb-label'), 'runs.jsonl'), task, 'baseline', h.root).intent;
    const bench = benchHost({ repo: REPO, base: intent.base, baseSha: h.root, send: unlabelled, log: h.note });
    await expect(
      publishBaseline({
        bench,
        repo: REPO,
        branch: intent.branch,
        base: intent.base,
        ticket: ticketOf(hiddenTask(task, intent.salt) as never, 1),
        files: [{ path: FILE, content: 'x\n' }],
      }),
    ).rejects.toBeInstanceOf(Killed);
    const remote = await listRemote(h.send, REPO);
    expect(remote.pulls.map((p) => ({ number: p.number, labelled: p.labelled }))).toEqual([
      { number: 1, labelled: false },
    ]);
    expect((await sweepRemote(bench, remote)).closed).toEqual([1]);
  });
});

describe('which open factory PR a resume keeps', () => {
  const HEAD = 'a'.repeat(40);
  type Seen = [verdict: 'approve' | 'changes' | 'comment', commit: string, worker?: string];
  const snapshot = (...reviews: Seen[]) =>
    ({
      change: { headSha: HEAD },
      reviews: reviews.map(([verdict, commitId, worker = REVIEWER]) => ({
        commitId,
        verdict: 'comment',
        body: `<!-- agent-works:review worker=${worker} verdict=${verdict} -->\nx`,
      })),
      checks: [],
    }) as never;
  const OLD = 'b'.repeat(40);

  it.each<[string, Seen[], boolean]>([
    ['no review', [], false],
    ['an approval of the head', [['approve', HEAD]], true],
    ['a comment on the head', [['comment', HEAD]], true],
    ['an approval of an older head only', [['approve', OLD]], false],
    ['another worker only', [['approve', HEAD, AUTHOR]], false],
    ['changes asked on the head', [['changes', HEAD]], false],
    [
      'an approval and then changes on the head',
      [
        ['approve', HEAD],
        ['changes', HEAD],
      ],
      false,
    ],
    [
      'changes and then an approval of the head',
      [
        ['changes', HEAD],
        ['approve', HEAD],
      ],
      true,
    ],
    [
      'an approval of the head and then changes elsewhere',
      [
        ['approve', HEAD],
        ['changes', OLD],
      ],
      false,
    ],
  ])('%s', (_name, reviews, kept) => {
    expect(adoptable(snapshot(...reviews), REVIEWER)).toBe(kept);
  });

  it('does not keep a PR someone asked changes on through the host after the reviewer approved', () => {
    const seen = snapshot(['approve', HEAD]) as unknown as { reviews: object[] };
    seen.reviews.push({ commitId: HEAD, verdict: 'changes', body: 'please' });
    expect(adoptable(seen as never, REVIEWER)).toBe(false);
  });
});

describe('the drive loop stops', () => {
  const [first, second] = tasks as [SetBTask, SetBTask];
  const items = [
    { task: first, arm: 'factory' as const },
    { task: second, arm: 'factory' as const },
  ];
  const drive = async (statuses: RunRecord['status'][], prior = 0, priorStatus: RunRecord['status'] = 'transient') => {
    const dir = tempDir('setb-drive');
    const runsFile = join(dir, 'runs.jsonl');
    const stopFile = join(dir, 'STOP');
    const record = (task: SetBTask, status: RunRecord['status']): RunRecord => ({
      task: task.id,
      arm: 'factory',
      status,
      stage: 1,
      branch: null,
      pr: null,
      readyHeadSha: null,
      wallMs: 1,
      tokens: null,
      reviewRounds: null,
      note: 'why',
      startedAt: '2026-11-25T00:00:00Z',
      resetAt: null,
      baseSha: 'c'.repeat(40),
    });
    for (let i = 0; i < prior; i += 1) appendRun(runsFile, record(first, priorStatus));
    const ran: string[] = [];
    const slept: number[] = [];
    const code = await driveArms(items, {
      runsFile,
      stopFile,
      stage: 1,
      run: async (task) => {
        ran.push(task.id);
        return record(task, statuses.shift() ?? 'done');
      },
      waitSlot: async () => {},
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { code, ran, slept, stop: existsSync(stopFile), records: readRuns(runsFile).length };
  };

  it('runs every arm and exits 0', async () => {
    expect(await drive(['done', 'failed'])).toMatchObject({ code: 0, ran: [first.id, second.id], stop: false });
  });

  it('retries a transient error, waiting longer each time, and exits 75 at the third', async () => {
    expect(await drive(['transient', 'transient', 'transient'])).toMatchObject({
      code: 75,
      ran: [first.id, first.id, first.id],
      slept: [60_000, 120_000],
      records: 3,
    });
    expect(await drive([], TRANSIENT_CAP)).toMatchObject({ code: 75, ran: [] });
    expect(await drive(['transient', 'done'])).toMatchObject({ code: 0, ran: [first.id, first.id, second.id] });
  });

  it('exits 75 on an arm that did not finish, with no retry and no next arm', async () => {
    expect(await drive(['aborted'])).toMatchObject({ code: 75, ran: [first.id], stop: false, records: 1, slept: [] });
  });

  it('writes the STOP file and exits 5 on a login failure', async () => {
    expect(await drive(['auth'])).toMatchObject({ code: 5, ran: [first.id], stop: true });
  });

  it('does not run an arm again after an aborted record unless that was allowed', async () => {
    expect(await drive([], 1, 'aborted')).toMatchObject({ code: 75, ran: [], records: 1 });
  });
});

describe('the pinned base, the orphan check and the leftover cages', () => {
  it('takes no base but the pinned one', () => {
    expect(PINNED_BASE).toBe('56db6a1e227ca3b46a15d6ac1f1c2794daea042d');
    expect(baseShaOf(undefined)).toBe(PINNED_BASE);
    expect(baseShaOf(PINNED_BASE)).toBe(PINNED_BASE);
    for (const other of [PINNED_BASE.slice(0, 7), 'a'.repeat(40), PINNED_BASE.toUpperCase(), ''])
      expect(() => baseShaOf(other), other).toThrow(/not the pinned base/);
  });

  it('refuses a remote that holds bench work the journal does not know', async () => {
    const journal = join(tempDir('setb-orphans'), 'runs.jsonl');
    const { intent } = claimIntent(journal, tasks[0] as SetBTask, 'factory', PINNED_BASE);
    const remote =
      (refs: string[]) =>
      async ({ path }: { path: string }) => ({
        status: 200,
        body: path.includes('matching-refs/heads/aw/bench/') ? refs.map((r) => ({ ref: `refs/heads/${r}` })) : [],
      });
    await expect(refuseOrphans(remote([]), 'o/r', journal)).resolves.toBeUndefined();
    await expect(refuseOrphans(remote([intent.branch]), 'o/r', journal)).resolves.toBeUndefined();
    await expect(refuseOrphans(remote(['aw/bench/t-deadbeef-r1']), 'o/r', journal)).rejects.toThrow(
      /does not know: aw\/bench\/t-deadbeef-r1/,
    );
  });

  it('removes only containers with the bench project label', async () => {
    const calls: string[][] = [];
    let listed = 'one\ntwo\n';
    const engine = {
      ok: async (args: readonly string[]) => {
        calls.push([...args]);
        return args[0] === 'ps' ? listed : '';
      },
    };
    expect(await removeLeftovers(engine)).toEqual(['one', 'two']);
    expect(calls).toEqual([
      ['ps', '-aq', '--filter', 'label=agent-works.project=agent-works-bench'],
      ['rm', '-f', 'one', 'two'],
    ]);
    listed = '';
    calls.length = 0;
    await removeLeftovers(engine);
    expect(calls).toHaveLength(1);
  });
});

describe('one driver at a time', () => {
  const lockIn = () => join(tempDir('setb-lock'), 'runs.jsonl.lock');
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
  const holder = (pid: number) => JSON.stringify({ pid, startedAt: '2026-11-25T00:00:00Z', command: 'drive' });

  it('refuses a second holder, and gives the lock again after a release', () => {
    const file = lockIn();
    const release = acquireLock(file, 'drive');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid, command: 'drive' });
    expect(Date.parse(JSON.parse(readFileSync(file, 'utf8')).startedAt)).not.toBeNaN();
    expect(() => acquireLock(file, 'close')).toThrow(/held by pid \d+ \(drive, started .*one driver at a time/);
    release();
    expect(existsSync(file)).toBe(false);
    acquireLock(file, 'close')();
  });

  it('takes over a lock whose process is gone, and leaves a lock it cannot read', () => {
    const file = lockIn();
    writeFileSync(file, holder(deadPid()));
    acquireLock(file, 'drive')();
    expect(existsSync(`${file}.break`)).toBe(false);
    writeFileSync(file, '');
    expect(() => acquireLock(file, 'drive')).toThrow(/unreadable lock/);
    expect(existsSync(file)).toBe(true);
  });

  it('lets only one process at a time clear a stale lock', () => {
    const file = lockIn();
    writeFileSync(file, holder(deadPid()));
    writeFileSync(`${file}.break`, '1');
    expect(() => acquireLock(file, 'drive')).toThrow(/clearing a stale lock/);
    expect(readFileSync(file, 'utf8')).toContain('"command":"drive"');
  });

  it('releases only its own lock', () => {
    const file = lockIn();
    const release = acquireLock(file, 'drive');
    writeFileSync(file, holder(process.pid));
    release();
    expect(existsSync(file)).toBe(true);
  });

  describe.skipIf(process.platform === 'win32' || !canSpawnTs)('in a real process', () => {
    const module = pathToFileURL(join(import.meta.dirname, '..', 'lock.ts')).href;

    it.each(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const)('releases the lock on %s', async (how) => {
      const file = lockIn();
      const script = join(tempDir('setb-holder'), 'hold.mjs');
      writeFileSync(
        script,
        `import { holdLock } from ${JSON.stringify(module)};
holdLock(${JSON.stringify(file)}, 'drive');
console.log('held');
if (${JSON.stringify(how)} !== 'exit') setInterval(() => {}, 1000);
`,
      );
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
      const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      await new Promise((resolve) => child.stdout.once('data', resolve));
      if (how !== 'exit') {
        expect(existsSync(file)).toBe(true);
        child.kill(how);
      }
      expect(await done).toBe({ exit: 0, SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[how]);
      expect(existsSync(file)).toBe(false);
    });

    const stage = (tools: Record<string, string> = {}) => {
      const out = tempDir('setb-cli-lock');
      const bin = join(out, 'bin');
      mkdirSync(bin);
      const touched = join(out, 'touched');
      for (const tool of ['gh', 'git', 'docker', 'podman']) {
        writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${touched}'\n${tools[tool] ?? 'exit 1'}\n`);
        chmodSync(join(bin, tool), 0o755);
      }
      const cache = join(out, 'cache');
      const argv = (command: string, dir = out, more: string[] = []) => [
        join(import.meta.dirname, '..', 'run.ts'),
        command,
        '--home',
        out,
        '--out',
        dir,
        '--cache',
        cache,
        ...more,
      ];
      const env = {
        ...process.env,
        AW_BENCH_LOGIN_CONFIRMED: '1',
        GH_HOST: '',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      };
      const cli = (command: string, dir = out, more: string[] = []) =>
        spawnSync(process.execPath, argv(command, dir, more), { encoding: 'utf8', env, timeout: 60_000 });
      const start = (command: string) => spawn(process.execPath, argv(command), { env, stdio: 'ignore' });
      return { out, cache, touched, cli, start, lock: join(out, 'runs.jsonl.lock') };
    };

    it.each(['drive', 'close', 'reconcile'])(
      '%s stops before touching the host while another holds the lock',
      (command) => {
        const { touched, cli, lock } = stage();
        writeFileSync(lock, holder(process.pid));
        const ran = cli(command);
        expect(ran.stderr).toMatch(/held by pid/);
        expect(ran.status).toBe(3);
        expect(existsSync(touched)).toBe(false);
        expect(readFileSync(lock, 'utf8')).toBe(holder(process.pid));
      },
    );

    it.each(['drive', 'close', 'reconcile'])(
      '%s stops while a command from another checkout holds the shared lock',
      (command) => {
        const { out, cache, touched, cli } = stage();
        mkdirSync(cache);
        writeFileSync(join(cache, 'setb.lock'), holder(process.pid));
        const ran = cli(command, join(out, 'other-checkout'));
        expect(ran.stderr).toMatch(/setb\.lock is held by pid/);
        expect(ran.status).toBe(3);
        expect(existsSync(touched)).toBe(false);
      },
    );

    it.each(['prepare', 'drive', 'close', 'reconcile'])(
      '%s refuses another base before touching anything',
      (command) => {
        const { out, touched, cli } = stage();
        const ran = cli(command, out, ['--base-sha', 'a'.repeat(40)]);
        expect(ran.stderr).toMatch(/not the pinned base/);
        expect(ran.status).toBe(3);
        expect(existsSync(touched)).toBe(false);
      },
    );

    /** Fake `gh` and engine over a prepared cache, so `drive` reaches its first arm with no network and no model. */
    const driving = (post: string, refs = '[]') => {
      const reply = (status: number, body: string) => `printf 'HTTP/2.0 ${status} x\\n\\n%s\\n' '${body}'`;
      const made = stage({
        gh: `case "$4 $5" in
GET*matching-refs/heads/aw/bench/*) ${reply(200, refs)};;
GET*) ${reply(200, '[]')};;
*) ${post};;
esac`,
        docker: `case "$1 $3" in
info*) echo '{}';;
"ps --filter") echo leftover;;
esac
exit 0`,
      });
      const base = join(made.cache, 'setb-base', PINNED_BASE);
      mkdirSync(join(base, 'installed', 'node_modules'), { recursive: true });
      mkdirSync(join(base, 'source', '.git'), { recursive: true });
      const called = () => (existsSync(made.touched) ? readFileSync(made.touched, 'utf8') : '');
      return { ...made, called };
    };

    it('records a 502 from the first remote write as aborted and stops with 75 before the next arm', () => {
      const { out, cli, called } = driving(`printf 'HTTP/2.0 502 x\\n\\n{"message":"Server Error"}\\n'`);
      const ran = cli('drive');
      expect(ran.status, ran.stderr).toBe(75);
      const runs = readRuns(join(out, 'runs.jsonl'));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'aborted', arm: 'factory', baseSha: PINNED_BASE });
      expect(runs[0]?.note).toContain('502');
      expect(existsSync(join(out, 'STOP'))).toBe(false);
      const beforeFirstWrite = called().split('-X POST')[0];
      expect(beforeFirstWrite).toContain('docker ps -aq --filter label=agent-works.project=agent-works-bench\n');
      expect(beforeFirstWrite).toContain('docker rm -f leftover');
    });

    it('does not start while the remote holds bench work the journal does not know', () => {
      const { cli, called } = driving('exit 1', '[{"ref":"refs/heads/aw/bench/t-deadbeef-r1"}]');
      const ran = cli('drive');
      expect(ran.stderr).toMatch(/does not know: aw\/bench\/t-deadbeef-r1/);
      expect(ran.status).toBe(3);
      expect(called()).not.toMatch(/^docker/m);
    });

    it('removes the running cage on a signal before it exits and releases the locks', async () => {
      const { cache, start, lock, called } = driving('exec sleep 5');
      const child = start('drive');
      const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      await vi.waitFor(() => expect(called()).toMatch(/gh api --include -X POST/), { timeout: 20_000, interval: 50 });
      const before = called();
      child.kill('SIGTERM');
      expect(await done).toBe(143);
      const after = called().slice(before.length);
      expect(after).toMatch(
        /docker ps -aq --filter label=agent-works\.project=agent-works-bench --filter label=agent-works\.hq=/,
      );
      expect(after).toContain('docker rm -f leftover');
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(join(cache, 'setb.lock'))).toBe(false);
    }, 40_000);

    it('grade-all writes no rows while an arm has no done or failed record', () => {
      const { out, cli } = stage();
      writeFileSync(join(out, 'key.json'), '[]');
      writeFileSync(join(out, 'judged.json'), JSON.stringify({ judged: [], unreadable: [], voided: null }));
      const ran = cli('grade-all', out, ['--key', join(out, 'key.json'), '--judged', join(out, 'judged.json')]);
      expect(ran.stderr).toMatch(/no done or failed record/);
      expect(ran.status).toBe(3);
      expect(existsSync(join(out, 'rows.jsonl'))).toBe(false);
    });

    it('runs an aborted arm again only with the flag for that abort, and journals why', () => {
      const { out, cli } = driving(`printf 'HTTP/2.0 502 x\\n\\n{"message":"Server Error"}\\n'`);
      const runsFile = join(out, 'runs.jsonl');
      expect(cli('drive').status).toBe(75);
      const held = cli('drive');
      expect(held.status, held.stderr).toBe(75);
      expect(held.stderr).toContain('--rerun-aborted check-sources-all-links:factory:1');
      expect(readRuns(runsFile), 'a held arm is not started').toHaveLength(1);
      const flag = ['--rerun-aborted', 'check-sources-all-links:factory:1'];
      expect(cli('drive', out, flag).stderr).toMatch(/--reason must say why/);
      const allowed = [...flag, '--reason', 'GitHub was down'];
      expect(cli('drive', out, allowed).status).toBe(75);
      expect(readRuns(runsFile)).toHaveLength(2);
      expect(readJournal(runsFile).reruns).toMatchObject([
        { task: 'check-sources-all-links', arm: 'factory', aborted: 1, reason: 'GitHub was down' },
      ]);
      const again = cli('drive', out, allowed);
      expect(again.status, 'the same command allows nothing after the next abort').toBe(3);
      expect(again.stderr).toMatch(/holds 2 aborted record/);
      expect(readRuns(runsFile)).toHaveLength(2);
    }, 60_000);

    it.each(['drive', 'close', 'reconcile'])('%s reports a torn journal line and goes on to the host', (command) => {
      const { out, touched, cli, lock } = stage();
      const runs = join(out, 'runs.jsonl');
      writeFileSync(runs, `${JSON.stringify({ kind: 'header', baseSha: PINNED_BASE, createdAt: 'x' })}\n{"kind":"inte`);
      const ran = cli(command);
      expect(ran.stderr).toMatch(/ends in a torn line, which is skipped: "\{\\"kind\\":\\"inte"/);
      expect(readFileSync(touched, 'utf8')).toMatch(/^(gh|git) /);
      expect(existsSync(lock), 'the lock is released after a failure').toBe(false);
      expect(existsSync(`${runs}.torn`), 'only drive writes the journal').toBe(command === 'drive');
    });
  });
});

describe('a provider stop inside a reply claude marks successful', () => {
  const reviewerJob = {
    ...authorJob,
    role: 'reviewer' as const,
    worker: 'vega',
    change: { number: 1, headSha: 'a'.repeat(40) } as never,
    files: [],
    tree: { entries: [], read: async () => Buffer.alloc(0) },
  };
  const reviewStatus = async (out: string) => {
    try {
      await claudeCode({ shell: () => withStderr(claudeShell('', out, 0)) }).run(reviewerJob as never);
    } catch (error) {
      return statusOf((error as Error).message);
    }
    throw new Error('the review did not fail');
  };

  it.each(STOPS)('%s', async (text, expected) => {
    for (const out of [resultOf(text, 'success', false), worked(text), worked(text, '<synthetic>')]) {
      expect(await status('', out, 0), `author: ${out}`).toBe(expected);
      expect(await reviewStatus(out), `reviewer: ${out}`).toBe(expected);
    }
  });
});

describe('who ended a session marked successful', () => {
  const UNSEEN = 'A message from next year';
  const line = (over: object) =>
    `${JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-sonnet' }, ...over })}\n`;
  const success = resultOf(UNSEEN, 'success', false);

  it.each([
    ['no model message at all', success],
    ['a notice Claude Code wrote itself', line({ message: { model: '<synthetic>' } }) + success],
    ['a last message flagged with an error', line({ error: 'rate_limit' }) + success],
    ['a last message flagged as an API error', line({ isApiErrorMessage: true }) + success],
    ['a notice after real work', line({}) + line({ message: { model: '<synthetic>' } }) + success],
    ['only a subagent message', line({ parent_tool_use_id: 'toolu_1' }) + success],
  ])('is not final after %s, whatever the text says', async (_name, out) => {
    expect(await status('', out, 0)).toBe('aborted');
  });

  it.each([
    ['a real model message', line({}) + success],
    ['an error the session recovered from', line({ error: 'rate_limit' }) + line({}) + success],
    ['a subagent that hit a limit', line({}) + line({ parent_tool_use_id: 'toolu_1', error: 'rate_limit' }) + success],
    ['a long answer that opens like a notice', worked('API Error: 529 is now retried.\nI could not commit it.')],
    ['a sentence about a login', worked('Not logged in users get a 403 now, but I could not commit it.')],
    ['a sentence that quotes a notice', worked('I could not make the client retry on API Error: 529.')],
  ])('counts no committed change as the result after %s', async (_name, out) => {
    expect(await status('', out, 0)).toBe('failed');
  });

  it('reports a login failure on stderr over the notice in the reply', async () => {
    const out = worked(UNSEEN, '<synthetic>');
    for (const code of [0, 1]) expect(await status('Not logged in\n', out, code)).toBe('auth');
  });
});

describe('an aborted arm', () => {
  const id = (tasks[0] as SetBTask).id;
  const aborted = (file: string, status: RunRecord['status'] = 'aborted') =>
    appendRun(file, { task: id, arm: 'factory', status, stage: 2, note: 'why' } as RunRecord);
  const held = (file: string) => heldBy(readJournal(file), id, 'factory');

  it('is held per abort, and an allowance covers neither the next abort nor the other arm', () => {
    const file = join(tempDir('setb-rerun'), 'runs.jsonl');
    aborted(file, 'auth');
    aborted(file, 'transient');
    expect(held(file), 'only an abort holds an arm').toBeNull();
    expect(() => allowRerun(file, `${id}:factory:0`, 'x')).toThrow(/holds 0 aborted/);
    aborted(file);
    expect(held(file)).toBe(`--rerun-aborted ${id}:factory:1`);
    expect(heldBy(readJournal(file), id, 'baseline')).toBeNull();
    expect(() => allowRerun(file, `${id}:factory:2`, 'x')).toThrow(/holds 1 aborted/);
    expect(() => allowRerun(file, `${id}:factory:1`, '  ')).toThrow(/--reason/);
    allowRerun(file, `${id}:factory:1`, 'read it');
    allowRerun(file, `${id}:factory:1`, 'read it');
    expect(readJournal(file).reruns).toHaveLength(1);
    expect(readRuns(file), 'a rerun line is not a run record').toHaveLength(3);
    expect(held(file)).toBeNull();
    appendRun(file, { task: id, arm: 'baseline', status: 'aborted', stage: 2, note: 'why' } as RunRecord);
    expect(heldBy(readJournal(file), id, 'baseline')).toBe(`--rerun-aborted ${id}:baseline:1`);
    aborted(file);
    expect(held(file)).toBe(`--rerun-aborted ${id}:factory:2`);
  });
});

describe('the stage 1 journal, written before rerun lines existed', () => {
  const file = join(import.meta.dirname, 'fixtures', 'stage1-runs.jsonl');

  it('loads, keeps its base, holds nothing and leaves 18 arms in the same order', () => {
    const journal = readJournal(file);
    expect(journal).toMatchObject({ header: { baseSha: PINNED_BASE }, torn: null, reruns: [] });
    expect([journal.intents.length, journal.runs.length]).toEqual([2, 3]);
    const left = todo(tasks, journal.runs);
    expect(left).toHaveLength(18);
    expect(left.slice(0, 2).map((i) => `${i.task.id} ${i.arm}`)).toEqual([
      'repo-id-edges baseline',
      'repo-id-edges factory',
    ]);
    expect(left.filter((i) => heldBy(journal, i.task.id, i.arm) !== null)).toEqual([]);
    expect(entriesOf(tasks, journal.runs).map((e) => e.pr)).toEqual([1, 2]);
    expect(() => pinBase(file, PINNED_BASE)).not.toThrow();
  });
});

describe('grading', () => {
  const calibration = readWindow(join(import.meta.dirname, '..', 'window.json'));
  const record = (task: SetBTask, arm: 'factory' | 'baseline', over: Partial<RunRecord> = {}): RunRecord => ({
    task: task.id,
    arm,
    status: 'failed',
    stage: 1,
    branch: null,
    pr: null,
    readyHeadSha: null,
    wallMs: 60_000,
    tokens: null,
    reviewRounds: null,
    note: 'no committed change',
    startedAt: '2026-11-26T00:00:00Z',
    resetAt: null,
    baseSha: PINNED_BASE,
    ...over,
  });
  const all = tasks.flatMap((t) => [record(t, 'factory'), record(t, 'baseline')]);
  const timed: Array<[number, number, number]> = [];
  const grade = (runs: readonly RunRecord[]) =>
    gradeAll({
      tasks,
      runs,
      key: [],
      judged: { judged: [], unreadable: [] },
      calibration,
      rootMinutes: 0,
      read: {
        pull: async () => expect.unreachable(),
        ci: async () => expect.unreachable(),
        paths: async () => expect.unreachable(),
        ciWait: async (pr, from, to) => {
          timed.push([pr, from, to]);
          return 30_000;
        },
      },
    });

  it.each(['aborted', 'auth', 'transient'] as const)('refuses while an arm has only a %s record', async (status) => {
    const [first, ...rest] = all as [RunRecord, ...RunRecord[]];
    await expect(grade([{ ...first, status }, ...rest])).rejects.toThrow(
      `1 arm(s) have no done or failed record: ${first.task} factory`,
    );
    await expect(grade(rest)).rejects.toThrow(/no done or failed record/);
  });

  it('grades every arm once all have finished, and times CI over the wall time of an arm that left a PR', async () => {
    const [first, ...rest] = all as [RunRecord, ...RunRecord[]];
    const rows = await grade([{ ...first, pr: 7 }, ...rest]);
    expect(rows).toHaveLength(20);
    expect(timed).toEqual([[7, Date.parse(first.startedAt), Date.parse(first.startedAt) + 60_000]]);
    expect(rows.map((r) => r.ciWaitMs).slice(0, 2)).toEqual([30_000, null]);
  });

  it('refuses a done arm the key has no label for, which is not an arm with no PR', async () => {
    const [first, ...rest] = all as [RunRecord, ...RunRecord[]];
    const done = { ...first, status: 'done' as const, pr: 7, readyHeadSha: 'a'.repeat(40) };
    await expect(grade([done, ...rest])).rejects.toThrow(/is done but the key has no label/);
  });
});

describe('the CI wait inside an arm', () => {
  const at = (s: number) => new Date(s * 1000).toISOString();
  const run = (from: number, to: number | null) => ({
    started_at: at(from),
    completed_at: to === null ? null : at(to),
  });

  it('counts overlapping check runs once, gaps never, and only the time inside the arm', () => {
    expect(ciRunningMs([run(10, 30), run(20, 40), run(25, 26), run(60, 70)], 0, 100_000)).toBe(40_000);
    expect(ciRunningMs([run(0, 30), run(90, 200)], 10_000, 100_000)).toBe(30_000);
    expect(ciRunningMs([run(10, 40), run(20, 25), run(30, 35)], 0, 100_000)).toBe(30_000);
    expect(ciRunningMs([run(0, 5)], 10_000, 100_000)).toBe(0);
    expect(ciRunningMs([run(90, null)], 0, 100_000)).toBe(10_000);
    expect(ciRunningMs([run(200, 300), { started_at: null }], 0, 100_000)).toBe(0);
  });

  const github = (checks: Record<string, ReturnType<typeof run>[]>, total?: number) => async (path: string) => {
    if (path === 'repos/o/r/pulls/7/commits?per_page=100') return Object.keys(checks).map((sha) => ({ sha }));
    const sha = /^repos\/o\/r\/commits\/(\w+)\/check-runs\?filter=all&per_page=100$/.exec(path)?.[1] ?? '';
    const runs = checks[sha] as ReturnType<typeof run>[];
    return { total_count: total ?? runs.length, check_runs: runs };
  };

  it('adds up every commit of the PR, and is unknown when none has a check run', async () => {
    expect(await readCiWait(github({ a: [run(10, 20)], b: [run(50, 80)] }), 'o/r', 7, 0, 100_000)).toBe(40_000);
    expect(await readCiWait(github({ a: [] }), 'o/r', 7, 0, 100_000)).toBeNull();
    await expect(readCiWait(github({ a: [run(10, 20)] }, 2), 'o/r', 7, 0, 100_000)).rejects.toThrow(/only 1 were read/);
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, []]));
    await expect(readCiWait(github(many), 'o/r', 7, 0, 100_000)).rejects.toThrow(/too many to time/);
  });
});

describe('streams captured from claude 2.1.325, the version in the cage, against a fake API', () => {
  const captured = (name: string) =>
    readFileSync(join(import.meta.dirname, 'fixtures', `claude-2.1.325-${name}.jsonl`), 'utf8');

  it('reads a real model reply as the model ending the session', async () => {
    expect(await status('', captured('success'), 0)).toBe('failed');
  });

  it.each([
    ['api-429', 'aborted'],
    ['api-401', 'auth'],
  ])('records %s as %s, also when the result line does not say it is an error', async (name, expected) => {
    const out = captured(name);
    expect(await status('', out, 1)).toBe(expected);
    expect(await status('', out.replace('"is_error":true', '"is_error":false'), 0)).toBe(expected);
  });
});
