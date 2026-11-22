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
  readonly webRequests: number;
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

const commentOf = (raw: unknown): LineComment[] => {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.body !== 'string' || c.body.trim() === '') return [];
  const path = typeof c.path === 'string' && c.path !== '' ? c.path : null;
  const line = path !== null && Number.isSafeInteger(c.line) && (c.line as number) >= 1 ? (c.line as number) : null;
  return [{ path, line, body: c.body }];
};

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
  const comments = Array.isArray(o.comments) ? o.comments : [];
  return {
    verdict: o.verdict as Verdict,
    body: typeof o.body === 'string' ? o.body : '',
    comments: comments.flatMap(commentOf),
  };
};
