import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileEdit } from '../server/githost/host.ts';
import type { TaskA } from './model.ts';
import type { Runner } from './runner.ts';
import { insideOf, type Prepared, readTree } from './workspace.ts';

export interface Grade {
  readonly outcome: 'pass' | 'fail' | 'timeout';
  readonly note: string;
}

const tail = (text: string): string => text.trim().split('\n').slice(-3).join(' | ').slice(-240);

export const grade = async (
  task: TaskA,
  prepared: Prepared,
  files: readonly FileEdit[],
  runner: Runner,
  scratch: string,
): Promise<Grade> => {
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, `${task.id}-`));
  try {
    cpSync(prepared.installed, work, { recursive: true, verbatimSymlinks: true });
    for (const edit of files) {
      const target = insideOf(work, edit.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, edit.content);
    }
    for (const rel of readTree(prepared.hidden)) {
      const target = join(work, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(prepared.hidden, rel), target);
    }
    const ran = await runner.run({
      argv: task.testCommand,
      cwd: work,
      image: task.image,
      network: false,
      timeoutMs: task.timeoutMs,
    });
    if (ran.timedOut) return { outcome: 'timeout', note: 'the hidden tests ran past the time limit' };
    const output = `${ran.out}\n${ran.err}`;
    if (ran.code !== 0) return { outcome: 'fail', note: `exit ${ran.code}: ${tail(output)}` };
    if (!new RegExp(task.expect).test(output))
      return { outcome: 'fail', note: `exit 0 but the output lacks /${task.expect}/, so no test is shown to have run` };
    return { outcome: 'pass', note: tail(output) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

export const revertSanity = async (
  task: TaskA,
  prepared: Prepared,
  runner: Runner,
  scratch: string,
): Promise<{ readonly failsAtBase: boolean; readonly note: string }> => {
  const base = await grade(task, prepared, [], runner, scratch);
  return base.outcome === 'fail'
    ? { failsAtBase: true, note: base.note }
    : { failsAtBase: false, note: `at the reverted base the hidden tests gave ${base.outcome}: ${base.note}` };
};
