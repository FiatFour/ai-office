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

const TEXT_KEYS = ['body', 'comment', 'message', 'text'] as const;

const commentOf = (raw: unknown): LineComment[] => {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'string') return raw.trim() === '' ? [] : [{ path: null, line: null, body: raw }];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ path: null, line: null, body: JSON.stringify(raw) }];
  const c = raw as Record<string, unknown>;
  const key = TEXT_KEYS.find((k) => typeof c[k] === 'string' && (c[k] as string).trim() !== '');
  if (key === undefined)
    return Object.keys(c).length === 0 ? [] : [{ path: null, line: null, body: JSON.stringify(c) }];
  const path = typeof c.path === 'string' && c.path !== '' ? c.path : null;
  const line = Number.isSafeInteger(c.line) && (c.line as number) >= 1 ? (c.line as number) : null;
  return [{ path, line, body: c[key] as string }];
};

const commentsOf = (raw: unknown): LineComment[] => (Array.isArray(raw) ? raw.flatMap(commentOf) : commentOf(raw));

const FENCE_OPEN = /```[ \t]*(?:json)?[ \t]*\r?\n?\s*(?=\{)/gi;
const EXCERPT = 500;

const hasVerdict = (c: Record<string, unknown>) => VERDICTS.includes(c.verdict as Verdict);

const objectsIn = (text: string): Record<string, unknown>[] => {
  const closers = [...text.matchAll(/```/g)].map((m) => m.index);
  const found: Record<string, unknown>[] = [];
  const take = (source: string) => {
    try {
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        found.push(parsed as Record<string, unknown>);
      return true;
    } catch {
      return false;
    }
  };
  for (const open of text.matchAll(FENCE_OPEN)) {
    const start = open.index + open[0].length;
    for (const end of closers) if (end > start && take(text.slice(start, end))) break;
  }
  if (!found.some(hasVerdict)) {
    const from = text.indexOf('{');
    const to = text.lastIndexOf('}');
    if (from >= 0 && to > from) take(text.slice(from, to + 1));
  }
  return found;
};

export const parseReview = (text: string): Omit<Extract<AgentResult, { role: 'reviewer' }>, 'usage' | 'role'> => {
  const o = objectsIn(text).findLast(hasVerdict);
  if (o === undefined)
    throw new AgentFailed(
      `the reviewer gave no json block with a verdict of approve, changes or comment. Reviewer text: ${text.slice(0, EXCERPT)}`,
    );
  return {
    verdict: o.verdict as Verdict,
    body: typeof o.body === 'string' ? o.body : '',
    comments: commentsOf(o.comments),
  };
};
