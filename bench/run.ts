import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cageShells } from '../server/agents/cage-shell.ts';
import { imageFor } from '../server/config.ts';
import { SandboxDriver } from '../server/sandbox/container.ts';
import { pickEngine } from '../server/sandbox/engine.ts';
import type { Arm } from './arms.ts';
import { type Script, scriptedArm } from './arms.ts';
import { baselineArm, ticketOf } from './arms-live.ts';
import { grade, revertSanity } from './grade.ts';
import { readMergeState } from './merge-state.ts';
import { parseTask, type Row, type Task, type TaskA, TaskRefused } from './model.ts';
import { readRows } from './report.ts';
import { dockerRunner, localRunner, type Runner } from './runner.ts';
import { fixFiles, mirrorPath, type Prepared, prepareTask } from './workspace.ts';

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
}

const failure = (message: string): string => message.replace(/\s+/g, ' ').slice(0, 300);

export const runTask = async (task: TaskA, run: number, prepared: Prepared, ctx: RunContext): Promise<Row> => {
  if (!existsSync(join(prepared.dir, 'verified.json')))
    throw new TaskRefused(
      `task ${task.id} was never verified: run prepare, which checks the hidden tests fail at the base`,
    );
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
  const base = { task: task.id, set: 'A', arm: ctx.arm.name, run } as const;
  const agentStart = clock.now();
  const outcome = await Promise.race([
    ctx.arm.run(task, prepared, abort.signal).then(
      (done) => ({ done }) as const,
      (error: unknown) => ({ error }) as const,
    ),
    timeout,
  ]);
  clearTimeout(timer);
  const agentMs = Math.round(clock.now() - agentStart);
  const empty = { reviewRounds: null, tokens: null, quotaWindows: null, humanMinutes: null };
  const wall = () => Math.round(clock.now() - wallStart);
  if (outcome === 'timeout')
    return {
      ...base,
      ...empty,
      outcome: 'timeout',
      wallMs: wall(),
      agentMs,
      note: `the agent ran past ${task.timeoutMs} ms`,
    };
  if ('error' in outcome)
    return {
      ...base,
      ...empty,
      outcome: 'error',
      wallMs: wall(),
      agentMs,
      note: failure(outcome.error instanceof Error ? outcome.error.message : String(outcome.error)),
    };
  const { done } = outcome;
  const graded = await grade(task, prepared, done.files, ctx.runner, ctx.scratch);
  return {
    ...base,
    outcome: graded.outcome,
    reviewRounds: done.reviewRounds,
    tokens: done.tokens,
    quotaWindows: done.quotaWindows,
    humanMinutes: done.humanMinutes,
    wallMs: wall(),
    agentMs,
    note: failure(`${done.note}; ${graded.note}`),
  };
};

export const verifyTask = async (task: TaskA, prepared: Prepared, runner: Runner, scratch: string) => {
  const sanity = await revertSanity(task, prepared, runner, scratch);
  if (!sanity.failsAtBase) throw new TaskRefused(`task ${task.id}: ${sanity.note}`);
  writeFileSync(
    join(prepared.dir, 'verified.json'),
    `${JSON.stringify({ baseSha: prepared.baseSha, note: sanity.note })}\n`,
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

interface BaselineValues {
  readonly cache: string;
  readonly out: string;
  readonly runs: string;
  readonly home?: string | undefined;
  readonly bin?: string | undefined;
  readonly model?: string | undefined;
}

const runBaseline = async (
  task: TaskA,
  values: BaselineValues,
  wiring: { repoUrl: (repo: string) => string; runner: Runner; scratch: string },
): Promise<number> => {
  if (values.bin === undefined) {
    if (!task.confirmed) throw new TaskRefused(`task ${task.id} is not confirmed by the operator: no model run`);
    if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1') throw new TaskRefused(NEEDS_LOGIN);
  }
  if (values.home === undefined)
    throw new TaskRefused('--arm baseline needs --home <dir>, the cage home that holds the login');
  const engine = await pickEngine(undefined, process.env);
  if (engine === null) throw new TaskRefused('no container engine is available for the cage');
  const driver = new SandboxDriver({
    engine,
    home: resolve(values.home),
    hq: randomBytes(3).toString('hex'),
    image: imageFor(process.env),
    project: 'agent-works-bench',
  });
  try {
    const prepared = await prepareTask(task, { cache: values.cache, ...wiring });
    await verifyTask(task, prepared, wiring.runner, wiring.scratch);
    const shells = cageShells(async () => driver, prepared.source);
    const arm = baselineArm(() => shells('baseline', ticketOf(task).id), {
      ...(values.bin === undefined ? {} : { bin: values.bin }),
      ...(values.model === undefined ? {} : { model: values.model }),
    });
    for (let run = 1; run <= Number(values.runs); run += 1) {
      const row = await runTask(task, run, prepared, { arm, runner: wiring.runner, scratch: wiring.scratch });
      appendRow(values.out, row);
      console.log(JSON.stringify(row));
    }
    return 0;
  } finally {
    await driver.removeAll();
  }
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
    const files = await fixFiles(task, mirrorPath(values.cache, task.repo));
    const graded = await grade(task, prepared, files, runner, scratch);
    console.log(
      `${task.id}: the upstream fix (${files.map((f) => f.path).join(', ')}) grades ${graded.outcome}: ${graded.note}`,
    );
    return graded.outcome === 'pass' ? 0 : 1;
  }
  if (command === 'fix-scripts') {
    const scripts: Record<string, Script> = {};
    for (const t of tasks) {
      if (t.set !== 'A') continue;
      scripts[t.id] = { files: await fixFiles(t, mirrorPath(values.cache, t.repo)) };
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
    if (values.arm === 'factory')
      throw new TaskRefused(
        'the live factory arm needs a scratch host repo seeded with the task base, an operator step, so it is not wired in the command line',
      );
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
