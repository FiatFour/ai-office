import { TaskRefused } from '../model.ts';
import { RUBRIC } from './rubric.ts';

export interface Ci {
  readonly sha: string;
  readonly state: 'green' | 'red' | 'pending' | 'none';
  readonly note: string;
  /** How many check runs the head has. */
  readonly checks: number;
}

export interface Packet {
  readonly label: string;
  readonly headSha: string;
  readonly issue: { readonly title: string; readonly body: string };
  readonly diff: string;
  readonly ci: Ci;
}

const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a co-author trailer', /Co-Authored-By:/i],
  ['a session trailer', /Claude-Session:/i],
  ['the agent mail address', /noreply@anthropic\.com/i],
  ['a generated-by line', /Generated with \[?Claude Code/i],
];

export interface Unreadable {
  readonly label: string;
  readonly reason: string;
  readonly attempts?: number;
}

export const armLeaks = (text: string, secrets: readonly string[] = []): string[] => [
  ...LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name),
  ...secrets.filter((s) => s !== '' && text.includes(s)).map((s) => `the text ${JSON.stringify(s)}`),
];

export const buildPacket = (p: Packet, secrets: readonly string[] = []): Packet => {
  const seen = armLeaks(`${p.issue.title}\n${p.issue.body}\n${p.diff}`, secrets);
  if (seen.length > 0) throw new TaskRefused(`${p.label}: the packet would show the arm through ${seen.join(', ')}`);
  return p;
};

export const packetOrUnreadable = (p: Packet, secrets: readonly string[] = []): Packet | Unreadable => {
  try {
    return buildPacket(p, secrets);
  } catch (error) {
    if (!(error instanceof TaskRefused)) throw error;
    return { label: p.label, reason: `unreadable by leak: ${error.message}` };
  }
};

export const isUnreadable = (x: Packet | Unreadable): x is Unreadable => 'reason' in x;

/** A fence longer than any backtick run in the text, so the text cannot close it. */
export const fenceFor = (text: string): string =>
  '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

export const renderPrompt = (p: Packet): string => {
  const fence = fenceFor(p.diff);
  return [
    RUBRIC,
    '',
    `## Issue: ${p.issue.title}`,
    '',
    p.issue.body,
    '',
    `## CI result: ${p.ci.state}`,
    '',
    p.ci.note,
    '',
    '## Diff',
    '',
    `${fence}diff`,
    p.diff,
    fence,
  ].join('\n');
};
