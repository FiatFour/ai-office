import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Arm } from './arms.ts';
import { type Script, scriptedArm } from './arms.ts';
import { grade, revertSanity } from './grade.ts';
import { readMergeState } from './merge-state.ts';
import { parseTask, type Row, type Task, type TaskA, TaskRefused } from './model.ts';
import { dockerRunner, localRunner, type Runner } from './runner.ts';
import { type Prepared, prepareTask } from './workspace.ts';

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
    if (values.arm !== 'scripted') {
      if (!task.confirmed) throw new TaskRefused(`task ${task.id} is not confirmed by the operator: no model run`);
      if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1') throw new TaskRefused(NEEDS_LOGIN);
      throw new TaskRefused(
        'the live arms are wired by the operator once the login is confirmed, see bench/README in the PR body',
      );
    }
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
