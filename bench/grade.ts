import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Change, TaskA } from './model.ts';
import { TaskRefused } from './model.ts';
import { canonical, isTestSide, protectedReason } from './protected.ts';
import type { Runner } from './runner.ts';
import { isNewTestFile, refusesTestSide, suspectReasons, type TestSide, testSideOf } from './testside.ts';
import { insideOf, type Prepared, readTree } from './workspace.ts';

export interface SpecCount {
  readonly file: string;
  readonly passed: number;
  readonly failed: number;
}

export interface Grade {
  readonly outcome: 'pass' | 'fail' | 'timeout';
  readonly note: string;
  readonly specs: readonly SpecCount[] | null;
  readonly suspect: readonly string[];
  readonly dropped: readonly string[];
}

export const NO_CHANGE: Change = { files: [], deleted: [] };

const WORK = '.aw-bench';
const RESULT = `${WORK}/result.json`;
const NODE_REPORTER = fileURLToPath(new URL('./reporters/node-json.mjs', import.meta.url));

const tail = (text: string): string => text.trim().split('\n').slice(-3).join(' | ').slice(-240);

const reporterFlags = (task: TaskA): string[] =>
  task.reporter === 'vitest'
    ? ['--reporter=json', `--outputFile=${RESULT}`]
    : [`--test-reporter=./${WORK}/node-json.mjs`, `--test-reporter-destination=${RESULT}`];

export const gradedArgv = (task: TaskA): string[] =>
  task.reporter === 'vitest'
    ? [...task.testCommand, ...reporterFlags(task)]
    : [task.testCommand[0] ?? '', ...reporterFlags(task), ...task.testCommand.slice(1)];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const parseSpecs = (reporter: TaskA['reporter'], text: string): SpecCount[] | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (reporter === 'node-test') {
    if (!Array.isArray(raw.files)) return null;
    const specs: SpecCount[] = [];
    for (const f of raw.files) {
      if (!isRecord(f) || typeof f.file !== 'string' || typeof f.passed !== 'number' || typeof f.failed !== 'number')
        return null;
      specs.push({ file: f.file, passed: f.passed, failed: f.failed });
    }
    return specs;
  }
  if (!Array.isArray(raw.testResults)) return null;
  const specs: SpecCount[] = [];
  for (const t of raw.testResults) {
    if (!isRecord(t) || typeof t.name !== 'string' || !Array.isArray(t.assertionResults)) return null;
    const statuses = t.assertionResults.map((a) => (isRecord(a) ? a.status : undefined));
    const failed = statuses.filter((s) => s === 'failed').length;
    specs.push({
      file: t.name,
      passed: statuses.filter((s) => s === 'passed').length,
      failed: failed === 0 && t.status === 'failed' ? 1 : failed,
    });
  }
  return specs;
};

const specFor = (specs: readonly SpecCount[], rel: string): SpecCount | undefined =>
  specs.find((s) => {
    const file = s.file.replace(/\\/g, '/');
    return file === rel || file.endsWith(`/${rel}`);
  });

const readResult = (work: string): string => {
  try {
    return readFileSync(join(work, RESULT), 'utf8');
  } catch {
    return '';
  }
};

const refusal = (change: Change): string | null => {
  for (const path of [...change.files.map((f) => f.path), ...change.deleted]) {
    const reason = protectedReason(path);
    if (reason !== null) return reason;
  }
  return null;
};

const dropTestSide = (
  change: Change,
  side: TestSide,
): { readonly kept: Change; readonly dropped: readonly string[] } => {
  const isDropped = (path: string): boolean => refusesTestSide(side, path);
  const droppedFiles = change.files.filter((f) => isDropped(f.path)).map((f) => f.path);
  const droppedDeleted = change.deleted.filter(isDropped);
  return {
    kept: {
      files: change.files.filter((f) => !isDropped(f.path)),
      deleted: change.deleted.filter((p) => !isDropped(p)),
    },
    dropped: [...new Set([...droppedFiles, ...droppedDeleted])],
  };
};

export const totalPassed = (specs: readonly SpecCount[]): number => specs.reduce((n, s) => n + s.passed, 0);

const baseText = (root: string, rel: string): string => {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return '';
  }
};

const throughLink = (root: string, rel: string): boolean => {
  let at = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    at = join(at, part);
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat === undefined) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
};

const pruneEmpty = (root: string, dir: string): void => {
  for (let at = dir; at !== root && at.startsWith(root); at = dirname(at)) {
    try {
      rmdirSync(at);
    } catch {
      return;
    }
  }
};

const apply = (work: string, change: Change, skipped: ReadonlySet<string>): string | null => {
  const act = (rel: string, linkCheck: string, step: (target: string) => void): string | null => {
    try {
      const target = insideOf(work, rel);
      if (throughLink(work, linkCheck)) return `${rel} goes through a symbolic link`;
      if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true) return `${rel} is a directory`;
      step(target);
      return null;
    } catch (error) {
      if (error instanceof TaskRefused) return error.message;
      return `${rel} cannot be applied: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  // Deletes go first so a typechange (file <-> directory) can be written over what it replaced.
  for (const rel of change.deleted) {
    const problem = act(rel, dirname(rel), (target) => {
      rmSync(target, { force: true });
      pruneEmpty(work, dirname(target));
    });
    if (problem !== null) return problem;
  }
  for (const edit of change.files) {
    if (skipped.has(edit.path)) continue;
    const problem = act(edit.path, edit.path, (target) => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, edit.content);
    });
    if (problem !== null) return problem;
  }
  return null;
};

const runGraded = async (
  task: TaskA,
  prepared: Prepared,
  change: Change,
  ignored: ReadonlySet<string>,
  runner: Runner,
  scratch: string,
  minPassed: number,
): Promise<Omit<Grade, 'suspect' | 'dropped'>> => {
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, `${task.id}-`));
  try {
    cpSync(prepared.installed, work, { recursive: true, verbatimSymlinks: true });
    const problem = apply(work, change, ignored);
    if (problem !== null) return { outcome: 'fail', note: `the PR is refused: ${problem}`, specs: null };
    for (const rel of readTree(prepared.hidden)) {
      const target = join(work, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(prepared.hidden, rel), target);
    }
    rmSync(join(work, WORK), { recursive: true, force: true });
    mkdirSync(join(work, WORK));
    if (task.reporter === 'node-test') cpSync(NODE_REPORTER, join(work, WORK, 'node-json.mjs'));
    const ran = await runner.run({
      argv: gradedArgv(task),
      cwd: work,
      image: task.image,
      network: false,
      timeoutMs: task.timeoutMs,
    });
    if (ran.timedOut) return { outcome: 'timeout', note: 'the hidden tests ran past the time limit', specs: null };
    const specs = parseSpecs(task.reporter, readResult(work));
    const output = `${ran.out}\n${ran.err}`;
    if (specs === null)
      return {
        outcome: 'fail',
        note: `no structured test report (exit ${ran.code}): ${tail(output)}`,
        specs: null,
      };
    const missing = task.specs.filter((rel) => (specFor(specs, rel)?.passed ?? 0) === 0);
    const failed = specs.reduce((n, s) => n + s.failed, 0);
    if (failed > 0 || ran.code !== 0) {
      const red = specs.filter((s) => s.failed > 0).map((s) => basename(s.file));
      return {
        outcome: 'fail',
        note: `exit ${ran.code}, ${failed} failed in ${red.join(', ') || 'no spec'}`,
        specs,
      };
    }
    if (missing.length > 0)
      return { outcome: 'fail', note: `no passing test reported for ${missing.join(', ')}`, specs };
    const passed = totalPassed(specs);
    if (passed < minPassed)
      return {
        outcome: 'fail',
        note: `${passed} tests passed, the upstream fix passes ${minPassed}: a suite that shrank cannot pass`,
        specs,
      };
    return { outcome: 'pass', note: `${passed} tests passed in ${specs.length} files`, specs };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const canonicalChange = (change: Change): Change => ({
  files: change.files.map((f) => ({ ...f, path: canonical(f.path) })),
  deleted: change.deleted.map(canonical),
});

export const grade = async (
  task: TaskA,
  prepared: Prepared,
  asked: Change,
  runner: Runner,
  scratch: string,
  minPassed = 0,
): Promise<Grade> => {
  const side = testSideOf(prepared.installed, prepared.hidden);
  let change: Change;
  try {
    change = canonicalChange(asked);
  } catch (error) {
    if (!(error instanceof TaskRefused)) throw error;
    return { outcome: 'fail', note: `the PR is refused: ${error.message}`, specs: null, suspect: [], dropped: [] };
  }
  const refused = refusal(change);
  if (refused !== null)
    return { outcome: 'fail', note: `the PR is refused: ${refused}`, specs: null, suspect: [], dropped: [] };
  const { kept, dropped } = dropTestSide(change, side);
  const ignored = new Set(kept.files.filter((f) => isNewTestFile(side, f.path)).map((f) => f.path));
  if (dropped.length > 0 && kept.files.every((f) => ignored.has(f.path)) && kept.deleted.length === 0)
    return {
      outcome: 'fail',
      note: `nothing to grade: the PR touches only test-side files, dropped ${dropped.join(', ')}`,
      specs: null,
      suspect: [],
      dropped,
    };
  const suspect = kept.files
    .filter((f) => !ignored.has(f.path) && !isTestSide(f.path))
    .flatMap((f) => suspectReasons(f.path, baseText(prepared.installed, f.path), f.content));
  return { ...(await runGraded(task, prepared, kept, ignored, runner, scratch, minPassed)), suspect, dropped };
};

export const revertSanity = async (
  task: TaskA,
  prepared: Prepared,
  runner: Runner,
  scratch: string,
): Promise<{ readonly failsAtBase: boolean; readonly note: string }> => {
  const base = await grade(task, prepared, NO_CHANGE, runner, scratch);
  if (base.outcome !== 'fail')
    return { failsAtBase: false, note: `at the reverted base the hidden tests gave ${base.outcome}: ${base.note}` };
  const hiddenFailed = base.specs?.some((s) => s.failed > 0 && task.specs.some((rel) => specFor([s], rel)));
  return hiddenFailed === true
    ? { failsAtBase: true, note: base.note }
    : {
        failsAtBase: false,
        note: `the run failed at the base, but not as a test failure of a hidden test: ${base.note}`,
      };
};
