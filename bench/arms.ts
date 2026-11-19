import { setTimeout as sleep } from 'node:timers/promises';
import type { FileEdit } from '../server/githost/host.ts';
import type { ArmName, TaskA, Tokens } from './model.ts';
import type { Prepared } from './workspace.ts';

export interface ArmRun {
  readonly files: readonly FileEdit[];
  readonly deleted: readonly string[];
  readonly reviewRounds: number | null;
  readonly tokens: Tokens | null;
  readonly webRequests: number | null;
  readonly quotaWindows: number | null;
  readonly humanMinutes: number | null;
  readonly note: string;
}

export interface Arm {
  readonly name: ArmName;
  readonly scripted: boolean;
  run(task: TaskA, prepared: Prepared, signal: AbortSignal, run: number): Promise<ArmRun>;
}

export class ArmFailed extends Error {}

export interface Script {
  readonly files: readonly FileEdit[];
  readonly deleted?: readonly string[];
  readonly reviewRounds?: number;
  readonly tokens?: Tokens;
  readonly webRequests?: number;
  readonly workMs?: number;
  readonly hang?: boolean;
  readonly fail?: string;
}

export const scriptedArm = (name: ArmName, scripts: Readonly<Record<string, Script>>): Arm => ({
  name,
  scripted: true,
  async run(task, _prepared, signal) {
    const script = scripts[task.id];
    if (script === undefined) throw new ArmFailed(`no script for ${task.id}`);
    if (script.hang === true) await sleep(24 * 3_600_000, undefined, { signal });
    if (script.workMs) await sleep(script.workMs, undefined, { signal });
    if (script.fail !== undefined) throw new ArmFailed(script.fail);
    return {
      files: script.files,
      deleted: script.deleted ?? [],
      reviewRounds: name === 'factory' ? (script.reviewRounds ?? 0) : null,
      tokens: script.tokens ?? null,
      webRequests: script.webRequests ?? null,
      quotaWindows: null,
      humanMinutes: null,
      note: 'scripted',
    };
  },
});
