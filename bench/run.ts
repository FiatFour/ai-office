import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cageShells } from '../server/agents/cage-shell.ts';
import { claudeCode } from '../server/agents/claude-code.ts';
import { imageFor } from '../server/config.ts';
import { cliTransport, fileLog } from '../server/githost/host.ts';
import { pickEngine } from '../server/sandbox/engine.ts';
import type { Arm } from './arms.ts';
import { type Script, scriptedArm } from './arms.ts';
import { baselineArm, factoryArm, ticketOf } from './arms-live.ts';
import { BenchCage } from './cage.ts';
import { grade, revertSanity, totalPassed } from './grade.ts';
import { readMergeState } from './merge-state.ts';
import { type Flag, parseTask, type Row, type Task, type TaskA, TaskRefused } from './model.ts';
import { readRows } from './report.ts';
import { dockerRunner, localRunner, type Runner } from './runner.ts';
import { AUTHOR, MAX_RUNS, REVIEWER, SCRATCH_REPO, ScratchTarget, scratchEnv } from './scratch.ts';
import { fixChange, mirrorPath, type Prepared, prepareTask } from './workspace.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEEDS_LOGIN = 'not run, needs operator login confirmation';

export interface Clock {
  now(): number;
}

export interface RunContext {
  readonly arm: Arm;
  readonly runner: Runner;
  readonly scratch: string;
  readonly clock?: Clock;
  readonly settleMs?: number;
  readonly log?: (line: string) => void;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const FACTORY_TIMEOUT_FACTOR = 4;
const SETTLE_MS = 120_000;

const within = async (pending: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([pending.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
};

export const countOf = (name: string, raw: string | undefined, fallback: number, max: number): number => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new TaskRefused(`${name} must be a whole number from 1 to ${max}, got ${JSON.stringify(raw)}`);
  return value;
};

export const timeoutOf = (task: TaskA, raw: string | undefined, factor: number): number =>
  raw === undefined ? task.timeoutMs * factor : countOf('--timeout-ms', raw, 0, MAX_TIMER_MS);

export const killOnAbort = (arm: Arm, kill: () => Promise<unknown>): Arm => ({
  ...arm,
  run(task, prepared, signal, run) {
    signal.addEventListener('abort', () => void kill().catch(() => {}), { once: true });
    return arm.run(task, prepared, signal, run);
  },
});

const NOTE_MAX = 300;

const failure = (message: string): string => message.replace(/\s+/g, ' ').slice(0, NOTE_MAX);

export const failureTail = (message: string): string => {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= NOTE_MAX ? flat : `…${flat.slice(-(NOTE_MAX - 1))}`;
};

const flagOf = (webRequests: number | null, suspect: readonly string[]): [Flag | null, string] =>
  webRequests !== null && webRequests > 0
    ? ['contaminated', `${webRequests} server-side web requests; `]
    : suspect.length > 0
      ? ['suspect', `${suspect.join(', ')}; `]
      : [null, ''];

const dropNote = (dropped: readonly string[]): string =>
  dropped.length > 0 ? `dropped test-side edits ${dropped.join(', ')}; ` : '';

export const runTask = async (task: TaskA, run: number, prepared: Prepared, ctx: RunContext): Promise<Row> => {
  const verifiedFile = join(prepared.dir, 'verified.json');
  if (!existsSync(verifiedFile))
    throw new TaskRefused(
      `task ${task.id} was never verified: run prepare, which checks the hidden tests fail at the base`,
    );
  const { prepareMs, fixPassed } = JSON.parse(readFileSync(verifiedFile, 'utf8')) as {
    prepareMs: number;
    fixPassed?: number;
  };
  if (typeof fixPassed !== 'number')
    throw new TaskRefused(`task ${task.id} was verified by an older harness: rerun prepare to record the test count`);
  countOf('the task timeout', String(task.timeoutMs), 1, MAX_TIMER_MS);
  const clock = ctx.clock ?? performance;
  const wallStart = clock.now();
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolveTimeout) => {
    timer = setTimeout(() => {
      abort.abort();
      resolveTimeout('timeout');
    }, task.timeoutMs);
  });
  const base = { task: task.id, set: 'A', arm: ctx.arm.name, scripted: ctx.arm.scripted, run } as const;
  const agentStart = clock.now();
  const settled = ctx.arm.run(task, prepared, abort.signal, run).then(
    (done) => ({ done }) as const,
    (error: unknown) => ({ error }) as const,
  );
  const outcome = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  const agentMs = Math.round(clock.now() - agentStart);
  const empty = { reviewRounds: null, tokens: null, flag: null, quotaWindows: null, humanMinutes: null };
  const wall = () => Math.round(clock.now() - wallStart);
  if (outcome === 'timeout') {
    const stopped = await within(settled, ctx.settleMs ?? SETTLE_MS);
    return {
      ...base,
      ...empty,
      prepareMs,
      outcome: 'timeout',
      wallMs: wall(),
      agentMs,
      note: `the agent ran past ${task.timeoutMs} ms${stopped ? '' : `; it had not stopped ${ctx.settleMs ?? SETTLE_MS} ms after the abort and is abandoned`}`,
    };
  }
  if ('error' in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    ctx.log?.(`${task.id} ${ctx.arm.name} run ${run}: ${message}`);
    return {
      ...base,
      ...empty,
      prepareMs,
      outcome: 'error',
      wallMs: wall(),
      agentMs,
      note: failureTail(message),
    };
  }
  const { done } = outcome;
  const graded = await grade(
    task,
    prepared,
    { files: done.files, deleted: done.deleted },
    ctx.runner,
    ctx.scratch,
    fixPassed,
  );
  const [flag, why] = flagOf(done.webRequests, graded.suspect);
  return {
    ...base,
    prepareMs,
    outcome: graded.outcome,
    reviewRounds: done.reviewRounds,
    tokens: done.tokens,
    flag,
    quotaWindows: done.quotaWindows,
    humanMinutes: done.humanMinutes,
    wallMs: wall(),
    agentMs,
    note: failure(`${why}${dropNote(graded.dropped)}${done.note}; ${graded.note}`),
  };
};

export const verifyTask = async (task: TaskA, prepared: Prepared, runner: Runner, scratch: string) => {
  const started = performance.now();
  const sanity = await revertSanity(task, prepared, runner, scratch);
  if (!sanity.failsAtBase) throw new TaskRefused(`task ${task.id}: ${sanity.note}`);
  const fixed = await grade(task, prepared, await fixChange(task, prepared.mirror), runner, scratch);
  if (fixed.outcome !== 'pass' || fixed.specs === null)
    throw new TaskRefused(`task ${task.id}: the upstream fix grades ${fixed.outcome}: ${fixed.note}`);
  const prepareMs = prepared.prepareMs + Math.round(performance.now() - started);
  writeFileSync(
    join(prepared.dir, 'verified.json'),
    `${JSON.stringify({ baseSha: prepared.baseSha, note: sanity.note, prepareMs, fixPassed: totalPassed(fixed.specs) })}\n`,
  );
  return sanity;
};

export const loadTasks = (dir: string): Task[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
      return (Array.isArray(raw) ? raw : [raw]).map((t) => parseTask(t, f));
    });

export const appendRow = (file: string, row: Row): void => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
};

const today = (): string => new Date().toISOString().slice(0, 10);

interface LiveValues {
  readonly cache: string;
  readonly out: string;
  readonly runs: string;
  readonly home?: string | undefined;
  readonly bin?: string | undefined;
  readonly model?: string | undefined;
  readonly 'scratch-repo'?: string | undefined;
  readonly 'scratch-remote'?: string | undefined;
  readonly 'review-home-worker'?: string | undefined;
  readonly 'timeout-ms'?: string | undefined;
  readonly 'keep-scratch'?: boolean | undefined;
}

interface Wiring {
  readonly repoUrl: (repo: string) => string;
  readonly runner: Runner;
  readonly scratch: string;
}

export const LOGIN_WORKER = 'baseline';

const runLive = async (
  task: TaskA,
  values: LiveValues,
  wiring: Wiring,
  armFor: (prepared: Prepared, driver: BenchCage) => Arm,
  timeoutFactor: number,
  homeWorker: (worker: string) => string = () => LOGIN_WORKER,
): Promise<number> => {
  const runs = countOf('--runs', values.runs, 1, MAX_RUNS);
  const timeoutMs = timeoutOf(task, values['timeout-ms'], timeoutFactor);
  if (!task.confirmed) throw new TaskRefused(`task ${task.id} is not confirmed by the operator: no model run`);
  if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1') throw new TaskRefused(NEEDS_LOGIN);
  if (values.home === undefined)
    throw new TaskRefused('a live arm needs --home <dir>, the cage home that holds the login');
  const engine = await pickEngine(undefined, process.env);
  if (engine === null) throw new TaskRefused('no container engine is available for the cage');
  const prepared = await prepareTask(task, { cache: values.cache, ...wiring });
  await verifyTask(task, prepared, wiring.runner, wiring.scratch);
  const driver = new BenchCage({
    engine,
    home: resolve(values.home),
    hq: randomBytes(3).toString('hex'),
    image: imageFor(process.env),
    project: 'agent-works-bench',
    installed: prepared.installed,
    homeWorker,
  });
  try {
    const graded = { ...task, timeoutMs };
    for (let run = 1; run <= runs; run += 1) {
      const arm = killOnAbort(armFor(prepared, driver), () => driver.removeAll());
      const row = await runTask(graded, run, prepared, {
        arm,
        runner: wiring.runner,
        scratch: wiring.scratch,
        log: (line) => appendFileSync(`${values.out}.errors.log`, `${line}\n`),
      });
      await driver.removeAll();
      appendRow(values.out, row);
      console.log(JSON.stringify(row));
    }
    return 0;
  } finally {
    await driver.removeAll();
  }
};

const agentOptions = (values: LiveValues) => ({
  ...(values.bin === undefined ? {} : { bin: values.bin }),
  ...(values.model === undefined ? {} : { model: values.model }),
});

const runBaseline = (task: TaskA, values: LiveValues, wiring: Wiring): Promise<number> =>
  runLive(
    task,
    values,
    wiring,
    (prepared, driver) => {
      const shells = cageShells(async () => driver, prepared.source);
      return baselineArm((t, run) => shells('baseline', ticketOf(t, run).id), agentOptions(values));
    },
    1,
  );

const runFactory = (task: TaskA, values: LiveValues, wiring: Wiring): Promise<number> => {
  const target = ScratchTarget.of(values['scratch-repo'] ?? SCRATCH_REPO, values['scratch-remote']);
  const reviewHome = values['review-home-worker'] ?? LOGIN_WORKER;
  return runLive(
    task,
    values,
    wiring,
    (prepared, driver) => {
      const runtime = claudeCode({
        shell: cageShells(async () => driver, prepared.source),
        ...agentOptions(values),
      });
      mkdirSync(dirname(values.out), { recursive: true });
      return factoryArm(
        scratchEnv({
          repo: target.repo,
          remote: target.remote,
          send: cliTransport('gh'),
          log: fileLog(`${values.out}.api.jsonl`),
          workers: () => ({ [AUTHOR]: runtime, [REVIEWER]: runtime }),
          workRoot: join(values.cache, 'scratch'),
          keep: values['keep-scratch'] === true,
        }),
      );
    },
    FACTORY_TIMEOUT_FACTOR,
    (worker) => (worker === REVIEWER ? reviewHome : LOGIN_WORKER),
  );
};

const main = async (argv: string[]): Promise<number> => {
  const [command = '', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      tasks: { type: 'string', default: join(HERE, 'tasks') },
      task: { type: 'string' },
      cache: { type: 'string', default: join(process.env.HOME ?? '.', '.cache', 'aw-p2-1') },
      arm: { type: 'string', default: 'scripted' },
      scripts: { type: 'string' },
      runs: { type: 'string', default: '1' },
      out: { type: 'string', default: join(HERE, 'results', `${today()}.jsonl`) },
      local: { type: 'boolean', default: false },
      'human-minutes': { type: 'string' },
      'quota-windows': { type: 'string' },
      'arm-name': { type: 'string' },
      'run-number': { type: 'string' },
      home: { type: 'string' },
      bin: { type: 'string' },
      model: { type: 'string' },
      'scratch-repo': { type: 'string' },
      'scratch-remote': { type: 'string' },
      'review-home-worker': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'keep-scratch': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const tasks = loadTasks(resolve(values.tasks));
  const pick = (id: string | undefined): Task => {
    const found = tasks.find((t) => t.id === id);
    if (found === undefined) throw new TaskRefused(`no task ${id ?? '(none given)'} in ${values.tasks}`);
    return found;
  };
  const runner = values.local ? localRunner : dockerRunner();
  const scratch = join(values.cache, 'grading');
  const repoUrl = (repo: string) =>
    process.env.AW_BENCH_REPO_ROOT
      ? join(process.env.AW_BENCH_REPO_ROOT, `${repo}.git`)
      : `https://github.com/${repo}.git`;
  if (command === 'prepare') {
    const task = pick(values.task);
    if (task.set !== 'A') throw new TaskRefused(`task ${task.id} is a Set B task and needs no preparation`);
    const prepared = await prepareTask(task, { cache: values.cache, repoUrl, runner });
    const sanity = await verifyTask(task, prepared, runner, scratch);
    console.log(`${task.id}: base ${prepared.baseSha}; hidden tests fail at the base: ${sanity.note}`);
    return 0;
  }
  if (command === 'check-fix') {
    const task = pick(values.task);
    if (task.set !== 'A') throw new TaskRefused(`task ${task.id} is a Set B task`);
    const prepared = await prepareTask(task, { cache: values.cache, repoUrl, runner });
    await verifyTask(task, prepared, runner, scratch);
    const { fixPassed } = JSON.parse(readFileSync(join(prepared.dir, 'verified.json'), 'utf8')) as {
      fixPassed: number;
    };
    console.log(`${task.id}: the upstream fix grades pass with ${fixPassed} tests, the floor a PR must reach`);
    return 0;
  }
  if (command === 'fix-scripts') {
    const scripts: Record<string, Script> = {};
    for (const t of tasks) {
      if (t.set !== 'A') continue;
      scripts[t.id] = await fixChange(t, mirrorPath(values.cache, t.repo));
    }
    console.log(JSON.stringify(scripts));
    return 0;
  }
  if (command === 'annotate') {
    const rows = readRows(values.out);
    const hit = rows.filter(
      (r) => r.task === values.task && r.arm === values['arm-name'] && r.run === Number(values['run-number'] ?? 1),
    );
    if (hit.length !== 1) throw new TaskRefused(`${hit.length} rows match, annotate needs exactly 1`);
    const next = rows.map((r) =>
      r === hit[0]
        ? {
            ...r,
            ...(values['quota-windows'] === undefined ? {} : { quotaWindows: Number(values['quota-windows']) }),
            ...(values['human-minutes'] === undefined ? {} : { humanMinutes: Number(values['human-minutes']) }),
          }
        : r,
    );
    writeFileSync(values.out, `${next.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return 0;
  }
  if (command === 'merge-state') {
    const task = pick(values.task);
    if (task.set !== 'B') throw new TaskRefused(`task ${task.id} is a Set A task`);
    const minutes = values['human-minutes'] === undefined ? null : Number(values['human-minutes']);
    const row = await readMergeState(task, minutes);
    appendRow(values.out, row);
    console.log(JSON.stringify(row));
    return 0;
  }
  if (command === 'run') {
    const task = pick(values.task);
    if (task.set !== 'A') throw new TaskRefused(`task ${task.id} is a Set B task: use merge-state`);
    if (values.arm === 'factory') return runFactory(task, values, { repoUrl, runner, scratch });
    if (values.arm === 'baseline') return runBaseline(task, values, { repoUrl, runner, scratch });
    if (values.arm !== 'scripted') throw new TaskRefused(`unknown arm ${values.arm}`);
    if (values.scripts === undefined) throw new TaskRefused('--arm scripted needs --scripts <file.json>');
    const scripts = JSON.parse(readFileSync(values.scripts, 'utf8')) as Record<string, Script>;
    const prepared = await prepareTask(task, { cache: values.cache, repoUrl, runner });
    await verifyTask(task, prepared, runner, scratch);
    for (let run = 1; run <= Number(values.runs); run += 1)
      for (const name of ['baseline', 'factory'] as const) {
        const row = await runTask(task, run, prepared, { arm: scriptedArm(name, scripts), runner, scratch });
        appendRow(values.out, row);
        console.log(JSON.stringify(row));
      }
    return 0;
  }
  console.error('usage: node bench/run.ts prepare|run|merge-state --task <id> [--tasks dir] [--out file] [--local]');
  return 2;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(error instanceof TaskRefused ? 3 : 1);
    },
  );
}
