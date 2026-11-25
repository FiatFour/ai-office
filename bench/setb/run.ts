import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cageShells } from '../../server/agents/cage-shell.ts';
import { claudeCode } from '../../server/agents/claude-code.ts';
import { imageFor } from '../../server/config.ts';
import { cliTransport, fileLog, type GitHost } from '../../server/githost/host.ts';
import { pickEngine, runBinary } from '../../server/sandbox/engine.ts';
import type { ArmRun } from '../arms.ts';
import { baselineArm, factoryArm, ticketOf } from '../arms-live.ts';
import { BenchCage } from '../cage.ts';
import { ghReadPull } from '../merge-state.ts';
import { type Row, TaskRefused, type Tokens } from '../model.ts';
import { logged } from '../scratch.ts';
import {
  AUTHOR,
  adoptable,
  BASE_PREFIX,
  type BenchHost,
  benchHost,
  CI_PARALLEL,
  type Head,
  hiddenTask,
  listRemote,
  orphansOf,
  publicEnv,
  publishBaseline,
  REVIEWER,
  resetAt,
  resumeBranch,
  stopOf,
  sweepRemote,
  waitForCiSlot,
  withStderr,
} from './arms.ts';
import { ghHub, ghPullFiles } from './fetch.ts';
import {
  ARMS,
  type Arm,
  appendRun,
  checkBase,
  claimIntent,
  isFinal,
  pinBase,
  type RunRecord,
  readJournal,
  readRuns,
  type Status,
  setAsideTorn,
  TRANSIENT_CAP,
  transientCount,
} from './journal.ts';
import type { Judged } from './judge.ts';
import { type Entry, type Sealed, sealedEntry } from './labels.ts';
import { holdLock } from './lock.ts';
import { ghReadCi, gradeSetB, readWindow } from './outcome.ts';
import type { Unreadable } from './packet.ts';
import { loadFrozen, type SetBTask } from './task.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

export { ARMS, type Arm, appendRun, isFinal, type RunRecord, readRuns, type Status };

/** The arms still to run, in order: arms alternate by task so neither arm always goes first. */
export const todo = (
  tasks: readonly SetBTask[],
  runs: readonly RunRecord[],
  arms: readonly Arm[] = ARMS,
): Array<{ task: SetBTask; arm: Arm }> =>
  tasks.flatMap((task, i) => {
    const order = i % 2 === 0 ? arms : [...arms].reverse();
    return order
      .filter((arm) => !runs.some((r) => r.task === task.id && r.arm === arm && isFinal(r)))
      .map((arm) => ({ task, arm }));
  });

export const entriesOf = (tasks: readonly SetBTask[], runs: readonly RunRecord[]): Entry[] =>
  tasks.flatMap((t) =>
    ARMS.flatMap((arm) => {
      const r = runs.find((x) => x.task === t.id && x.arm === arm && x.status === 'done');
      return r === undefined || r.pr === null || r.readyHeadSha === null
        ? []
        : [{ task: t.id, arm, pr: r.pr, readyHeadSha: r.readyHeadSha }];
    }),
  );

export const tokensSum = (runs: readonly RunRecord[]): number =>
  runs.reduce(
    (n, r) =>
      n + (r.tokens === null ? 0 : r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheCreation),
    0,
  );

const REPO = 'FiatFour/ai-office';

interface Live {
  readonly repo: string;
  readonly baseSha: string;
  readonly home: string;
  readonly cache: string;
  readonly out: string;
  readonly journal: string;
  readonly stage: number;
  readonly armTimeoutMs: number;
  readonly factoryTimeoutMs: number;
  readonly bin?: string;
  readonly model?: string;
}

const need = (name: string, v: string | undefined): string => {
  if (v === undefined) throw new TaskRefused(`needs --${name}`);
  return v;
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_TERMINAL_PROMPT: '0',
});

export const prepareWorkspace = async (
  cache: string,
  baseSha: string,
): Promise<{ source: string; installed: string }> => {
  const dir = join(cache, 'setb-base', baseSha);
  const source = join(dir, 'source');
  const installed = join(dir, 'installed');
  if (existsSync(join(installed, 'node_modules')) && existsSync(join(source, '.git'))) return { source, installed };
  mkdirSync(source, { recursive: true });
  const mirror = join(cache, 'setb-mirror.git');
  if (!existsSync(mirror)) {
    const cloned = await runBinary('git', ['clone', '--quiet', '--bare', `https://github.com/${REPO}.git`, mirror], {
      env: gitEnv(),
    });
    if (cloned.code !== 0) throw new TaskRefused(`clone failed: ${cloned.err.trim().slice(-300)}`);
  }
  await runBinary('git', ['-C', mirror, 'fetch', '--quiet', 'origin', 'main:main'], { env: gitEnv() });
  const tar = await runBinary('sh', [
    '-c',
    'git -C "$0" archive --format=tar "$1" | tar -x -C "$2"',
    mirror,
    baseSha,
    source,
  ]);
  if (tar.code !== 0) throw new TaskRefused(`archive of ${baseSha} failed: ${tar.err.trim()}`);
  const sh = (cwd: string, ...args: string[]) =>
    runBinary(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'user.name=agent-works-bench',
        '-c',
        'user.email=bench@localhost',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { env: gitEnv() },
    );
  for (const args of [
    ['init', '--quiet', '-b', 'main'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'task base'],
  ]) {
    const ran = await sh(source, ...args);
    if (ran.code !== 0) throw new TaskRefused(`git ${args[0]} failed: ${ran.err.trim().slice(-300)}`);
  }
  const copy = await runBinary('sh', ['-c', 'rm -rf "$1" && cp -a "$0" "$1" && rm -rf "$1/.git"', source, installed]);
  if (copy.code !== 0) throw new TaskRefused(`copy failed: ${copy.err.trim()}`);
  const ran = await runBinary('sh', ['-c', 'cd "$0" && pnpm install --frozen-lockfile', installed], {
    env: { ...process.env },
    timeoutMs: 900_000,
  });
  if (ran.code !== 0) throw new TaskRefused(`pnpm install failed: ${(ran.err || ran.out).trim().slice(-300)}`);
  return { source, installed };
};

const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const classify = (message: string, now: Date): { status: Status; resetAt: number | null } => {
  const stop = stopOf(message);
  if (stop === 'auth') return { status: 'auth', resetAt: null };
  if (stop === 'quota') return { status: 'quota', resetAt: resetAt(message, now) };
  if (stop === 'transient') return { status: 'transient', resetAt: null };
  return { status: 'failed', resetAt: null };
};

/**
 * What a finished arm run is recorded as. A host refusal after round 0 is a failure of the arm, final, exactly as the
 * baseline's refused push is: the open PR still carries the head the reviewer rejected, and it is never graded as done.
 */
export const finish = (
  ran: ArmRun,
  change: { readonly number: number; readonly headSha: string } | null,
  branch: string,
): Pick<RunRecord, 'status' | 'pr' | 'readyHeadSha' | 'tokens' | 'reviewRounds' | 'note'> => {
  const common = { tokens: ran.tokens, reviewRounds: ran.reviewRounds };
  if (ran.refused === true)
    return { ...common, status: 'failed', pr: change?.number ?? null, readyHeadSha: null, note: ran.note };
  if (change === null)
    return { ...common, status: 'failed', pr: null, readyHeadSha: null, note: `no PR on ${branch}: ${ran.note}` };
  return { ...common, status: 'done', pr: change.number, readyHeadSha: change.headSha, note: ran.note };
};

const runArm = async (
  task: SetBTask,
  arm: Arm,
  live: Live,
  work: { source: string; installed: string },
): Promise<RunRecord> => {
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  // The intent is journaled (fsync) before the first remote write, and a resume reuses it: the same salt, the same names.
  const { intent, resumed } = claimIntent(live.journal, task, arm, live.baseSha);
  const hidden = hiddenTask(task, intent.salt) as never;
  const ticket = ticketOf(hidden, 1);
  const branch = intent.branch;
  const send = logged(cliTransport('gh', 'github.com'), fileLog(join(live.out, `${arm}.api.jsonl`)));
  const log = fileLog(join(live.out, `${arm}.api.jsonl`));
  const engine = await pickEngine(undefined, process.env);
  if (engine === null) throw new TaskRefused('no container engine is available for the cage');
  const driver = new BenchCage({
    engine,
    home: resolve(live.home),
    hq: randomBytes(3).toString('hex'),
    image: imageFor(process.env),
    project: 'agent-works-bench',
    installed: work.installed,
    homeWorker: () => 'baseline',
  });
  const options = {
    ...(live.bin === undefined ? {} : { bin: live.bin }),
    ...(live.model === undefined ? {} : { model: live.model }),
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), arm === 'factory' ? live.factoryTimeoutMs : live.armTimeoutMs);
  const prepared = work as never;
  const base = (over: Partial<RunRecord>): RunRecord => ({
    task: task.id,
    arm,
    status: 'failed',
    stage: live.stage,
    branch,
    pr: null,
    readyHeadSha: null,
    wallMs: Date.now() - wallStart,
    tokens: null,
    reviewRounds: null,
    note: '',
    startedAt,
    resetAt: null,
    baseSha: live.baseSha,
    ...over,
  });
  let bench: BenchHost | null = null;
  try {
    const mine = benchHost({ repo: live.repo, base: intent.base, baseSha: live.baseSha, send, log });
    bench = mine;
    if (resumed) {
      // A resumed arm either takes over the PR the interrupted run left, or starts from nothing on the same names.
      const adopted = await resumeBranch(mine, live.repo, branch, (change) =>
        arm === 'baseline'
          ? Promise.resolve(true)
          : mine.host.snapshot(live.repo, change.number).then((snap) => adoptable(snap, REVIEWER)),
      );
      if (adopted !== null)
        return base({
          status: 'done',
          pr: adopted.number,
          readyHeadSha: adopted.headSha,
          note: `adopted PR #${adopted.number} that an interrupted run left open (its tokens were not recorded)`,
        });
      rmSync(join(live.cache, 'hq', branch.split('/').at(-1) ?? 'x'), { recursive: true, force: true });
    }
    const rawShells = cageShells(async () => driver, work.source);
    const shells = (worker: string, id: string) => withStderr(rawShells(worker, id));
    const done =
      arm === 'baseline'
        ? await (async () => {
            const ran = await baselineArm((t, run) => shells('baseline', ticketOf(t, run).id), options).run(
              hidden,
              prepared,
              abort.signal,
              1,
            );
            bench = mine;
            const published = await publishBaseline({
              bench: mine,
              repo: live.repo,
              branch,
              base: intent.base,
              ticket,
              files: ran.files,
            });
            return { ran, sha: published.sha };
          })()
        : await (async () => {
            const runtime = claudeCode({ shell: shells, ...options });
            const env = publicEnv({
              repo: live.repo,
              baseSha: live.baseSha,
              send,
              log,
              workers: { [AUTHOR]: runtime, [REVIEWER]: runtime },
              home: (id) => join(live.cache, 'hq', id.split('/').at(-1) ?? 'x'),
              onOpen: (_id, b) => {
                bench = b;
              },
            });
            const ran = await factoryArm(env).run(hidden, prepared, abort.signal, 1);
            return { ran, sha: null };
          })();
    const host: GitHost | null = (bench as BenchHost | null)?.host ?? null;
    const change = host === null ? null : await host.findChange(live.repo, branch);
    return base(finish(done.ran, change, branch));
  } catch (error) {
    const message = failureText(error);
    const verdict = classify(message, new Date());
    const open =
      bench === null ? null : await (bench as BenchHost).host.findChange(live.repo, branch).catch(() => null);
    return base({
      status: abort.signal.aborted ? 'failed' : verdict.status,
      pr: open?.number ?? null,
      readyHeadSha: open?.headSha ?? null,
      note: message.replace(/\s+/g, ' ').slice(-300),
      resetAt: verdict.resetAt === null ? null : new Date(verdict.resetAt).toISOString(),
    });
  } finally {
    clearTimeout(timer);
    await driver.removeAll().catch(() => {});
  }
};

const heads = (runs: readonly RunRecord[]): Head[] =>
  runs.flatMap((r) =>
    r.readyHeadSha === null ? [] : [{ sha: r.readyHeadSha, since: Date.parse(r.startedAt) + r.wallMs }],
  );

export interface DriveDeps {
  readonly runsFile: string;
  readonly stopFile: string;
  readonly stage: number;
  readonly run: (task: SetBTask, arm: Arm) => Promise<RunRecord>;
  readonly waitSlot: () => Promise<void>;
  readonly sleep: (ms: number) => Promise<unknown>;
}

/** Runs the arms in order and returns the exit code: 5 on a login failure (STOP file written), 75 on a stop to wait out. */
export const driveArms = async (items: ReturnType<typeof todo>, deps: DriveDeps): Promise<number> => {
  for (const { task, arm } of items) {
    await deps.waitSlot();
    console.log(`stage ${deps.stage}: ${task.id} ${arm}`);
    for (;;) {
      const tried = transientCount(readRuns(deps.runsFile), task.id, arm);
      if (tried >= TRANSIENT_CAP) {
        console.error(`${task.id} ${arm}: ${tried} transient provider errors already recorded, stopping for root`);
        return 75;
      }
      const record = await deps.run(task, arm);
      appendRun(deps.runsFile, record);
      console.log(JSON.stringify({ ...record, note: record.note.slice(0, 120) }));
      if (record.status === 'auth') {
        writeFileSync(deps.stopFile, `login revoked or failed: ${record.note}\n`);
        return 5;
      }
      if (record.status === 'quota') return 75;
      if (record.status !== 'transient') break;
      // A provider overload or rate limit: counted against neither arm, run again after a wait, up to a cap.
      if (tried + 1 >= TRANSIENT_CAP) {
        console.error(`${task.id} ${arm}: ${tried + 1} transient provider errors, stopping for root`);
        return 75;
      }
      await deps.sleep(60_000 * (tried + 1));
    }
  }
  return 0;
};

const main = async (argv: string[]): Promise<number> => {
  const [command = '', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string', default: HERE },
      out: { type: 'string', default: join(REPO_ROOT, 'bench', 'results', 'setb') },
      cache: { type: 'string', default: join(process.env.HOME ?? '.', '.cache', 'aw-p3-2') },
      'base-sha': { type: 'string' },
      home: { type: 'string' },
      stage: { type: 'string', default: '1' },
      only: { type: 'string' },
      arms: { type: 'string' },
      'arm-timeout-min': { type: 'string', default: '60' },
      'factory-timeout-min': { type: 'string', default: '180' },
      bin: { type: 'string' },
      model: { type: 'string' },
      key: { type: 'string' },
      judged: { type: 'string' },
      'root-minutes': { type: 'string', default: '0' },
    },
  });
  if ((process.env.GH_HOST ?? '') !== '') throw new TaskRefused('GH_HOST is set: Set B only talks to github.com');
  const list = loadFrozen(values.dir);
  const runsFile = join(values.out, 'runs.jsonl');
  const stopFile = join(values.out, 'STOP');
  const lockFile = `${runsFile}.lock`;
  const { torn } = readJournal(runsFile);
  if (torn !== null)
    console.error(`${runsFile} ends in a torn line, which is skipped: ${JSON.stringify(torn.slice(0, 300))}`);
  if (command === 'prepare') {
    const work = await prepareWorkspace(values.cache, need('base-sha', values['base-sha']));
    console.log(JSON.stringify(work));
    return 0;
  }
  if (command === 'drive') {
    if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1')
      throw new TaskRefused('not run, needs operator login confirmation');
    holdLock(lockFile, command);
    if (setAsideTorn(runsFile) !== null) console.error(`moved the torn line to ${runsFile}.torn`);
    if (existsSync(stopFile)) throw new TaskRefused(`${stopFile} exists: ${readFileSync(stopFile, 'utf8').trim()}`);
    const baseSha = need('base-sha', values['base-sha']);
    // The journal names its base on the first line; a different --base-sha is refused, so the base never moves after the first PR.
    pinBase(runsFile, baseSha);
    const stage = Number(values.stage);
    const only = values.only === undefined ? null : new Set(values.only.split(','));
    const arms = values.arms === undefined ? ARMS : (values.arms.split(',') as Arm[]);
    const work = await prepareWorkspace(values.cache, baseSha);
    mkdirSync(values.out, { recursive: true });
    const live: Live = {
      repo: REPO,
      baseSha,
      home: need('home', values.home),
      cache: values.cache,
      out: values.out,
      journal: runsFile,
      stage,
      armTimeoutMs: Number(values['arm-timeout-min']) * 60_000,
      factoryTimeoutMs: Number(values['factory-timeout-min']) * 60_000,
      ...(values.bin === undefined ? {} : { bin: values.bin }),
      ...(values.model === undefined ? {} : { model: values.model }),
    };
    return driveArms(
      todo(
        list.tasks.filter((t) => only === null || only.has(t.id)),
        readRuns(runsFile),
        arms,
      ),
      {
        runsFile,
        stopFile,
        stage,
        run: (task, arm) => runArm(task, arm, live, work),
        waitSlot: () =>
          waitForCiSlot(
            heads(readRuns(runsFile)),
            (sha) => ghReadCi(live.repo, sha),
            (ms) => sleep(ms),
            Date.now,
            CI_PARALLEL,
          ),
        sleep: (ms) => sleep(ms),
      },
    );
  }
  if (command === 'entries') {
    writeFileSync(
      join(values.out, 'entries.json'),
      `${JSON.stringify(entriesOf(list.tasks, readRuns(runsFile)), null, 2)}\n`,
    );
    console.log(`${entriesOf(list.tasks, readRuns(runsFile)).length} entries`);
    return 0;
  }
  if (command === 'settle') {
    const todoHeads = heads(readRuns(runsFile));
    for (const h of todoHeads) {
      const ci = await ghReadCi(REPO, h.sha);
      console.log(`${h.sha.slice(0, 7)} ${ci.state} ${ci.note}`);
    }
    return 0;
  }
  if (command === 'grade-all') {
    const key = JSON.parse(readFileSync(need('key', values.key), 'utf8')) as Sealed[];
    const judged = JSON.parse(readFileSync(need('judged', values.judged), 'utf8')) as {
      judged: Judged[];
      unreadable: Unreadable[];
      voided: string | null;
    };
    if (judged.voided !== null) throw new TaskRefused(`the judge run is void: ${judged.voided}`);
    const runs = readRuns(runsFile);
    const rowsFile = join(values.out, 'rows.jsonl');
    const calibration = readWindow(join(values.dir, 'window.json'));
    const rows: Row[] = [];
    for (const task of list.tasks)
      for (const arm of ARMS) {
        const sealed = key.find((s) => s.entry.task === task.id && s.entry.arm === arm);
        const records = runs.filter((r) => r.task === task.id && r.arm === arm && isFinal(r));
        const rec = records.at(-1);
        const wallMs = rec?.wallMs ?? 0;
        if (sealed === undefined) {
          rows.push(
            noPrRow(task.id, arm, rec?.note ?? 'the arm did not run', wallMs, rec?.tokens ?? null, calibration),
          );
          continue;
        }
        const mine =
          judged.judged.find((j) => j.label === sealed.label) ??
          judged.unreadable.find((u) => u.label === sealed.label);
        if (mine === undefined) throw new TaskRefused(`no judgement for ${sealed.label}`);
        const entry = sealedEntry(key, sealed.label);
        if (entry.arm === 'seeded') continue;
        rows.push(
          gradeSetB({
            entry: { ...entry, arm: entry.arm },
            judged: mine,
            pull: await ghReadPull(list.repo, entry.pr),
            ci: await ghHub.ci(list.repo, entry.readyHeadSha),
            paths: await ghPullFiles(list.repo, entry.pr),
            wallMs,
            tokens: rec?.tokens ?? null,
            operatorMinutes: 0,
            rootMinutes: Number(values['root-minutes']),
            calibration,
          }),
        );
      }
    writeFileSync(rowsFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    console.log(`${rows.length} rows -> ${rowsFile}`);
    return 0;
  }
  if (command === 'close' || command === 'reconcile') {
    const baseSha = need('base-sha', values['base-sha']);
    holdLock(lockFile, command);
    checkBase(runsFile, baseSha);
    const send = cliTransport('gh', 'github.com');
    const bench = benchHost({
      repo: REPO,
      base: `${BASE_PREFIX}t-00000000-r1`,
      baseSha,
      send,
      log: fileLog(join(values.out, 'close.api.jsonl')),
    });
    // Both commands find everything by prefix on the remote and never read the journal to decide what exists: a run killed
    // before its record was written leaves refs and a PR that only the remote knows about.
    const remote = await listRemote(send, REPO);
    const intents = readJournal(runsFile).intents;
    if (command === 'reconcile') {
      const orphans = orphansOf(remote, intents);
      const pending = intents.filter(
        (i) => !readRuns(runsFile).some((r) => r.task === i.task && r.arm === i.arm && isFinal(r)),
      );
      console.log(
        JSON.stringify(
          { refs: remote.refs, pulls: remote.pulls, orphans, unfinishedIntents: pending.length, torn },
          null,
          2,
        ),
      );
      return orphans.refs.length === 0 && orphans.pulls.length === 0 && torn === null ? 0 : 6;
    }
    const swept = await sweepRemote(bench, remote);
    console.log(`closed ${swept.closed.length} bench PRs, deleted ${swept.deleted.length} bench refs`);
    return 0;
  }
  console.error('usage: node bench/setb/run.ts prepare|drive|entries|settle|grade-all|close|reconcile [...]');
  return 2;
};

const noPrRow = (
  task: string,
  arm: Arm,
  why: string,
  wallMs: number,
  tokens: Tokens | null,
  calibration: ReturnType<typeof readWindow>,
): Row => ({
  task,
  set: 'B',
  arm,
  scripted: false,
  run: 1,
  outcome: 'fail',
  reviewRounds: null,
  wallMs,
  agentMs: 0,
  prepareMs: 0,
  tokens,
  flag: null,
  quotaWindows: null,
  humanMinutes: 0,
  editLines: 0,
  judgeMinutes: null,
  rootMinutes: null,
  judgeAttempts: null,
  inferredWindows:
    tokens === null || calibration.tokensPerWindow === null
      ? null
      : (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation) / calibration.tokensPerWindow,
  note: `no PR to grade: ${why}`.slice(0, 300),
});

export { noPrRow };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(error instanceof TaskRefused ? 3 : 1);
    },
  );
}
