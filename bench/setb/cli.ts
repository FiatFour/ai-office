import { randomInt } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ghReadPull } from '../merge-state.ts';
import { TaskRefused } from '../model.ts';
import { fetchPacket, ghHub, ghPullFiles, type Hub } from './fetch.ts';
import {
  claudeModel,
  type Judged,
  judgedOutPath,
  recordVoid,
  refuseAfterVoids,
  runJudge,
  voidScanDirs,
  voidsLogPath,
} from './judge.ts';
import { assignLabels, type Entry, type Sealed, sealedEntry } from './labels.ts';
import { ciFrom, gradeSetB, readWindow } from './outcome.ts';
import { buildPacket, isUnreadable, type Packet, type Unreadable } from './packet.ts';
import { loadFrozen, parseTaskList, SHA_FILE, shaOf, TASKS_FILE, type TaskList } from './task.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

export interface Seed {
  readonly task: string;
  readonly why: string;
  readonly diff: string;
}

export function refuseSeededGrade<E extends { readonly arm: string }>(
  entry: E,
): asserts entry is E & { readonly arm: Exclude<E['arm'], 'seeded'> } {
  if (entry.arm === 'seeded') throw new TaskRefused('a seeded-bad PR is never graded');
}

/**
 * The check count a seeded PR shows: that of one real PR of the same run, drawn at random, so a count never marks a PR as
 * seeded. Green heads are drawn from, because a seeded PR is green; with no green head, any head that has checks.
 */
const countsFrom = (real: readonly Packet[]): number[] => {
  const green = real.filter((p) => p.ci.state === 'green');
  const counts = (green.length > 0 ? green : real).map((p) => p.ci.checks).filter((n) => n > 0);
  if (counts.length === 0)
    throw new TaskRefused('no real PR of this run has check runs, so a seeded PR has no count to copy');
  return counts;
};

export const seededPackets = (
  seeds: readonly Seed[],
  key: readonly Sealed[],
  list: TaskList,
  real: readonly Packet[],
  draw: (below: number) => number = randomInt,
): Packet[] => {
  const counts = countsFrom(real);
  return seeds.map((seed) => {
    const sealed = key.find((s) => s.entry.arm === 'seeded' && s.entry.task === seed.task);
    if (sealed === undefined) throw new TaskRefused(`no label for the seeded PR on ${seed.task}`);
    const task = list.tasks.find((t) => t.id === seed.task);
    if (task === undefined) throw new TaskRefused(`the seeded PR names ${seed.task}, which is not a Set B task`);
    const sha = sealed.entry.readyHeadSha;
    const runs = Array.from({ length: counts[draw(counts.length)] as number }, () => ({
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
    }));
    return buildPacket({
      label: sealed.label,
      headSha: sha,
      issue: { title: task.title, body: task.body },
      diff: seed.diff,
      ci: ciFrom(sha, runs),
    });
  });
};

export const realPackets = async (
  hub: Hub,
  list: TaskList,
  key: readonly Sealed[],
): Promise<{ packets: Packet[]; unreadable: Unreadable[] }> => {
  const packets: Packet[] = [];
  const unreadable: Unreadable[] = [];
  for (const sealed of key.filter((s) => s.entry.arm !== 'seeded')) {
    const task = list.tasks.find((t) => t.id === sealed.entry.task);
    if (task === undefined) throw new TaskRefused(`${sealed.label} names ${sealed.entry.task}, not a Set B task`);
    try {
      const made = await fetchPacket(hub, list.repo, sealed.entry, sealed.label, task);
      if (isUnreadable(made)) unreadable.push(made);
      else packets.push(made);
    } catch (error) {
      unreadable.push({
        label: sealed.label,
        reason: `unreadable by fetch: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const pending = packets.filter((p) => p.ci.state === 'pending').map((p) => p.label);
  if (pending.length > 0)
    throw new TaskRefused(`CI is still pending on ${pending.join(', ')}; run judge after every check has finished`);
  return { packets, unreadable };
};

const main = async (argv: string[]): Promise<number> => {
  const [command = '', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string', default: HERE },
      entries: { type: 'string' },
      key: { type: 'string' },
      seeded: { type: 'string', default: join(HERE, 'calibration', 'seeded.json') },
      judged: { type: 'string' },
      label: { type: 'string' },
      out: { type: 'string' },
      home: { type: 'string' },
      'wall-ms': { type: 'string' },
      'operator-minutes': { type: 'string' },
      'root-minutes': { type: 'string' },
      tokens: { type: 'string' },
    },
  });
  const need = (name: keyof typeof values): string => {
    const v = values[name];
    if (typeof v !== 'string') throw new TaskRefused(`${command} needs --${name}`);
    return v;
  };
  const num = (v: string | undefined): number | null => (v === undefined ? null : Number(v));
  if (command === 'freeze') {
    const bytes = readFileSync(join(values.dir, TASKS_FILE));
    parseTaskList(JSON.parse(bytes.toString('utf8')));
    writeFileSync(join(values.dir, SHA_FILE), `${shaOf(bytes)}\n`);
    console.log(shaOf(bytes));
    return 0;
  }
  if (command === 'check') {
    const list = loadFrozen(values.dir);
    console.log(
      `${list.tasks.length} tasks frozen at ${list.frozenAtSha.slice(0, 7)}, sha ${shaOf(readFileSync(join(values.dir, TASKS_FILE)))}`,
    );
    return 0;
  }
  if (command === 'label') {
    const list = loadFrozen(values.dir);
    const entries = read<Entry[]>(need('entries'));
    const seeds = read<Seed[]>(values.seeded);
    for (const e of [...entries, ...seeds])
      if (!list.tasks.some((t) => t.id === e.task)) throw new TaskRefused(`${e.task} is not a Set B task`);
    const withSeeds: Entry[] = [
      ...entries,
      ...seeds.map((s, i) => ({ task: s.task, arm: 'seeded' as const, pr: -(i + 1), readyHeadSha: '0'.repeat(40) })),
    ];
    const key = assignLabels(withSeeds);
    writeFileSync(need('key'), `${JSON.stringify(key, null, 2)}\n`);
    console.log(key.map((s) => s.label).join('\n'));
    return 0;
  }
  if (command === 'judge') {
    if (process.env.AW_BENCH_LOGIN_CONFIRMED !== '1')
      throw new TaskRefused('not run, needs operator login confirmation');
    const list = loadFrozen(values.dir);
    const key = read<Sealed[]>(need('key'));
    const out = judgedOutPath(values.dir, need('out'));
    if (existsSync(out)) throw new TaskRefused(`${out} already exists, judge writes a new file for each run`);
    const voids = voidsLogPath(values.dir, shaOf(readFileSync(join(values.dir, TASKS_FILE))));
    refuseAfterVoids(voids, voidScanDirs(values.dir));
    const { packets, unreadable } = await realPackets(ghHub, list, key);
    const seeded = seededPackets(read<Seed[]>(values.seeded), key, list, packets);
    const run = await runJudge(
      claudeModel(values.home === undefined ? {} : { configDir: resolve(values.home) }),
      packets,
      seeded,
      Date,
      unreadable,
    );
    // The void is logged before the output is written, so a write that fails afterwards cannot lose it.
    if (run.voided !== null) recordVoid(voids, run.voided);
    writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
    console.log(
      run.voided === null ? `${run.judged.length} judged, ${run.unreadable.length} unreadable` : `VOID: ${run.voided}`,
    );
    return run.voided === null ? 0 : 4;
  }
  if (command === 'grade') {
    const key = read<Sealed[]>(need('key'));
    const entry = sealedEntry(key, need('label'));
    refuseSeededGrade(entry);
    const judged = read<{ judged: Judged[]; unreadable: Unreadable[]; voided: string | null }>(need('judged'));
    if (judged.voided !== null) throw new TaskRefused(`the judge run is void: ${judged.voided}`);
    const mine =
      judged.judged.find((j) => j.label === values.label) ?? judged.unreadable.find((u) => u.label === values.label);
    if (mine === undefined) throw new TaskRefused(`no judgement for ${values.label}`);
    const list = loadFrozen(values.dir);
    const pull = await ghReadPull(list.repo, entry.pr);
    const row = gradeSetB({
      entry: { ...entry, arm: entry.arm },
      judged: mine,
      pull,
      ci: await ghHub.ci(list.repo, entry.readyHeadSha),
      paths: await ghPullFiles(list.repo, entry.pr),
      wallMs: num(values['wall-ms']) ?? 0,
      tokens: values.tokens === undefined ? null : JSON.parse(values.tokens),
      operatorMinutes: num(values['operator-minutes']),
      rootMinutes: num(values['root-minutes']),
      calibration: readWindow(join(values.dir, 'window.json')),
    });
    appendFileSync(need('out'), `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
    return 0;
  }
  console.error('usage: node bench/setb/cli.ts check|freeze|label|judge|grade [--dir dir] ...');
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
