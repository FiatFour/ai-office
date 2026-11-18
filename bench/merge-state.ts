import { runBinary } from '../server/sandbox/engine.ts';
import type { Row, TaskB } from './model.ts';
import { TaskRefused } from './model.ts';

export interface HostPull {
  readonly state: string;
  readonly merged: boolean;
  readonly head: { readonly sha: string };
  readonly created_at: string;
  readonly merged_at: string | null;
}

export type ReadPull = (repo: string, pr: number) => Promise<HostPull>;

export const ghReadPull: ReadPull = async (repo, pr) => {
  const ran = await runBinary('gh', ['api', '-X', 'GET', `repos/${repo}/pulls/${pr}`], { timeoutMs: 60_000 });
  if (ran.code !== 0) throw new TaskRefused(`gh could not read ${repo}#${pr}: ${ran.err.trim().slice(-200)}`);
  return JSON.parse(ran.out) as HostPull;
};

export const readMergeState = async (
  task: TaskB,
  humanMinutes: number | null,
  read: ReadPull = ghReadPull,
): Promise<Row> => {
  const pull = await read(task.repo, task.pr);
  if (pull.state === 'open')
    throw new TaskRefused(`${task.repo}#${task.pr} is still open, the operator has not decided`);
  const unchanged = pull.merged && pull.head.sha === task.readyHeadSha;
  const wallMs = pull.merged_at === null ? 0 : Date.parse(pull.merged_at) - Date.parse(pull.created_at);
  const note = !pull.merged
    ? 'closed without a merge'
    : unchanged
      ? 'merged unchanged'
      : `merged after the head moved from ${task.readyHeadSha.slice(0, 7)} to ${pull.head.sha.slice(0, 7)}`;
  return {
    task: task.id,
    set: 'B',
    arm: 'factory',
    scripted: false,
    run: 1,
    outcome: unchanged ? 'pass' : 'fail',
    reviewRounds: null,
    wallMs,
    agentMs: 0,
    prepareMs: 0,
    tokens: null,
    flag: null,
    quotaWindows: null,
    humanMinutes,
    note,
  };
};
