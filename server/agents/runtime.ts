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
const PATH_KEYS = ['path', 'file'] as const;

const lineOf = (raw: unknown): number | null => {
  const n = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(n) && (n as number) >= 1 ? (n as number) : null;
};

const pathOf = (c: Record<string, unknown>): string | null => {
  const key = PATH_KEYS.find((k) => typeof c[k] === 'string' && c[k] !== '');
  return key === undefined ? null : (c[key] as string);
};

const commentOf = (raw: unknown): LineComment[] => {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'string') return raw.trim() === '' ? [] : [{ path: null, line: null, body: raw }];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ path: null, line: null, body: JSON.stringify(raw) }];
  const c = raw as Record<string, unknown>;
  const key = TEXT_KEYS.find((k) => typeof c[k] === 'string' && (c[k] as string).trim() !== '');
  if (key === undefined)
    return Object.keys(c).length === 0 ? [] : [{ path: null, line: null, body: JSON.stringify(c) }];
  return [{ path: pathOf(c), line: lineOf(c.line), body: c[key] as string }];
};

const commentsOf = (raw: unknown): LineComment[] => (Array.isArray(raw) ? raw.flatMap(commentOf) : commentOf(raw));

const EXCERPT = 500;

/** The verdict a block claims, ignoring case and surrounding space, or null when it claims none. */
const verdictOf = (c: Record<string, unknown>): Verdict | null => {
  if (typeof c.verdict !== 'string') return null;
  const v = c.verdict.trim().toLowerCase();
  return VERDICTS.find((k) => k === v) ?? null;
};

const balancedEnd = (text: string, from: number): number => {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      else if (ch === '\n') return i;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch === '`' && text.startsWith('```', i)) return i;
  }
  return text.length;
};

/**
 * Every top-level json object in the text, fenced or bare, in order. A block ends at its closing brace or
 * at the next fence outside a string, and the scan resumes right after it, so several objects in one fence,
 * on one line or mixed with prose are all seen. Each step moves forward, so the scan is linear.
 */
const objectsIn = (text: string): Record<string, unknown>[] => {
  const found: Record<string, unknown>[] = [];
  let pos = text.indexOf('{');
  while (pos >= 0) {
    const end = balancedEnd(text, pos);
    try {
      const parsed: unknown = JSON.parse(text.slice(pos, end));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        found.push(parsed as Record<string, unknown>);
    } catch {}
    pos = text.indexOf('{', end);
  }
  return found;
};

/** A quoted "verdict": "changes" key as it appears in raw text. Inside a json string its quotes are escaped, so a comment that merely mentions it does not match. */
const CHANGES_KEY = /"verdict"\s*:\s*"\s*changes/i;

const bodyOf = (o: Record<string, unknown>): string => {
  if (typeof o.body === 'string' && o.body.trim() !== '') return o.body;
  if (typeof o.summary === 'string' && o.summary.trim() !== '') return o.summary;
  if (o.body === undefined || o.body === null || typeof o.body === 'string') return '';
  return JSON.stringify(o.body);
};

export const parseReview = (text: string): Omit<Extract<AgentResult, { role: 'reviewer' }>, 'usage' | 'role'> => {
  const reviews = objectsIn(text).flatMap((r) => {
    const verdict = verdictOf(r);
    return verdict === null ? [] : [{ r, verdict }];
  });
  const chosen = reviews.findLast((x) => x.verdict === 'changes') ?? reviews.at(-1);
  if (chosen === undefined)
    throw new AgentFailed(
      `the reviewer gave no json block with a verdict of approve, changes or comment. Reviewer text: ${text.slice(0, EXCERPT)}`,
    );
  // Fail closed: a changes verdict we could not parse (quoted, in a ~~~ fence, with a trailing comma or a comment)
  // must never let the review count as anything weaker.
  if (chosen.verdict !== 'changes' && CHANGES_KEY.test(text))
    throw new AgentFailed(
      `the reviewer text holds a changes verdict that could not be read as json, so it is not treated as ${chosen.verdict}. Reviewer text: ${text.slice(0, EXCERPT)}`,
    );
  return {
    verdict: chosen.verdict,
    body: bodyOf(chosen.r),
    comments: commentsOf(chosen.r.comments),
  };
};
