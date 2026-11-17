import type { TaskId, Verdict } from '@agent-works/core';
import type { ChangeFact, CommentFact, FileEdit, HeadFile, LineComment } from '../githost/host.ts';

export type RuntimeId = 'claude-code' | 'codex' | 'scripted';

export interface Ticket {
  readonly id: TaskId;
  readonly kind: 'feature' | 'defect' | 'chore';
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly risk: { readonly level: 'LOW' | 'MEDIUM' | 'HIGH'; readonly reason: string } | null;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

interface JobBase {
  readonly task: TaskId;
  readonly worker: string;
  readonly ticket: Ticket;
  readonly round: number;
  readonly signal: AbortSignal;
}

export type AgentJob = JobBase &
  (
    | { readonly role: 'author'; readonly comments: readonly CommentFact[] }
    | { readonly role: 'reviewer'; readonly change: ChangeFact; readonly files: readonly HeadFile[] }
  );

export type AgentResult =
  | {
      readonly role: 'author';
      readonly files: readonly FileEdit[];
      readonly message: string;
      readonly usage: Usage | null;
    }
  | {
      readonly role: 'reviewer';
      readonly verdict: Verdict;
      readonly body: string;
      readonly comments: readonly LineComment[];
      readonly usage: Usage | null;
    };

export interface AgentRuntime {
  readonly id: RuntimeId;
  run(job: AgentJob): Promise<AgentResult>;
}

export class RuntimeUnavailable extends Error {}
export class AgentFailed extends Error {}

const VERDICTS: readonly Verdict[] = ['approve', 'changes', 'comment'];

export const parseReview = (text: string): Omit<Extract<AgentResult, { role: 'reviewer' }>, 'usage' | 'role'> => {
  const block = /```json\s*([\s\S]*?)```/.exec(text)?.[1];
  if (block === undefined) throw new AgentFailed('the reviewer gave no ```json verdict block');
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    throw new AgentFailed('the reviewer verdict block is not JSON');
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!VERDICTS.includes(o.verdict as Verdict))
    throw new AgentFailed('the reviewer verdict is not approve, changes or comment');
  if (typeof o.body !== 'string') throw new AgentFailed('the reviewer verdict has no body');
  const comments = Array.isArray(o.comments) ? o.comments : [];
  return {
    verdict: o.verdict as Verdict,
    body: o.body,
    comments: comments.map((c: Record<string, unknown>) => {
      if (
        typeof c.path !== 'string' ||
        !Number.isSafeInteger(c.line) ||
        (c.line as number) < 1 ||
        typeof c.body !== 'string'
      )
        throw new AgentFailed('a review comment needs a path, a line and a body');
      return { path: c.path, line: c.line as number, body: c.body };
    }),
  };
};
