import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runBinary } from '../../server/sandbox/engine.ts';
import { ghReadPull } from '../merge-state.ts';
import { TaskRefused } from '../model.ts';
import { claudeModel, type Judged, runJudge } from './judge.ts';
import { assignLabels, type Entry, type Sealed, sealedEntry } from './labels.ts';
import { ghReadCi, gradeSetB, readWindow } from './outcome.ts';
import { buildPacket, type Packet } from './packet.ts';
import { loadFrozen, parseTaskList, SHA_FILE, shaOf, TASKS_FILE } from './task.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

interface Seed {
  readonly task: string;
  readonly issue: Packet['issue'];
  readonly diff: string;
  readonly ci: Pick<Packet['ci'], 'state' | 'note'>;
}

export const seededPackets = (seeds: readonly Seed[], key: readonly Sealed[]): Packet[] =>
  seeds.map((seed) => {
    const sealed = key.find((s) => s.entry.arm === 'seeded' && s.entry.task === seed.task);
    if (sealed === undefined) throw new TaskRefused(`no label for the seeded PR on ${seed.task}`);
    return buildPacket({
      label: sealed.label,
      headSha: sealed.entry.readyHeadSha,
      issue: seed.issue,
      diff: seed.diff,
      ci: { sha: sealed.entry.readyHeadSha, ...seed.ci },
    });
  });

const ghJson = async <T>(path: string): Promise<T> => {
  const ran = await runBinary('gh', ['api', '-X', 'GET', path], { timeoutMs: 60_000 });
  if (ran.code !== 0) throw new TaskRefused(`gh could not read ${path}: ${ran.err.trim().slice(-200)}`);
  return JSON.parse(ran.out) as T;
};

const main = async (argv: string[]): Promise<number> => {
  const [command = '', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string', default: HERE },
      entries: { type: 'string' },
      key: { type: 'string' },
      packets: { type: 'string' },
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
    const entries = read<Entry[]>(need('entries'));
    const seeds = read<Seed[]>(values.seeded);
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
    const key = read<Sealed[]>(need('key'));
    const packets = read<Packet[]>(need('packets'));
    const seeded = seededPackets(read<Seed[]>(values.seeded), key);
    const run = await runJudge(
      claudeModel(values.home === undefined ? {} : { configDir: resolve(values.home) }),
      packets.map((p) => buildPacket(p)),
      seeded,
    );
    writeFileSync(need('out'), `${JSON.stringify(run, null, 2)}\n`);
    console.log(run.voided === null ? `${run.judged.length} judged` : `VOID: ${run.voided}`);
    return run.voided === null ? 0 : 4;
  }
  if (command === 'grade') {
    const key = read<Sealed[]>(need('key'));
    const entry = sealedEntry(key, need('label'));
    if (entry.arm === 'seeded') throw new TaskRefused('a seeded-bad PR is never graded');
    const judged = read<{ judged: Judged[]; voided: string | null }>(need('judged'));
    if (judged.voided !== null) throw new TaskRefused(`the judge run is void: ${judged.voided}`);
    const mine = judged.judged.find((j) => j.label === values.label);
    if (mine === undefined) throw new TaskRefused(`no judgement for ${values.label}`);
    const list = loadFrozen(values.dir);
    const pull = await ghReadPull(list.repo, entry.pr);
    const files = await ghJson<{ filename: string; previous_filename?: string }[]>(
      `repos/${list.repo}/pulls/${entry.pr}/files?per_page=100`,
    );
    const row = gradeSetB({
      entry: { ...entry, arm: entry.arm },
      judged: mine,
      pull,
      ci: await ghReadCi(list.repo, entry.readyHeadSha),
      paths: files.flatMap((f) => [f.filename, ...(f.previous_filename === undefined ? [] : [f.previous_filename])]),
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
