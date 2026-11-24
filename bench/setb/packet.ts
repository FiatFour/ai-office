import { TaskRefused } from '../model.ts';
import { RUBRIC } from './rubric.ts';

export interface Ci {
  readonly sha: string;
  readonly state: 'green' | 'red' | 'pending' | 'none';
  readonly note: string;
}

export interface Packet {
  readonly label: string;
  readonly headSha: string;
  readonly issue: { readonly title: string; readonly body: string };
  readonly diff: string;
  readonly ci: Ci;
}

const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a branch name', /\baw\/[\w.-]+\/[\w.-]+/],
  ['an agent-works label', /agent-works:[\w-]+/],
  ['a bench ticket id', /bench\/t-[0-9a-f]{8}/],
  ['a co-author trailer', /Co-Authored-By:/i],
  ['a generated-by line', /Generated with \[?Claude Code/i],
];

export const armLeaks = (text: string, extra: readonly string[] = []): string[] => [
  ...LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name),
  ...extra.filter((s) => s !== '' && text.includes(s)).map((s) => `the text ${JSON.stringify(s)}`),
];

export const buildPacket = (p: Packet, secrets: readonly string[] = []): Packet => {
  const seen = armLeaks(`${p.issue.title}\n${p.issue.body}\n${p.diff}`, secrets);
  if (seen.length > 0) throw new TaskRefused(`${p.label}: the packet would show the arm through ${seen.join(', ')}`);
  return p;
};

export const renderPrompt = (p: Packet): string =>
  [
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
    '```diff',
    p.diff,
    '```',
  ].join('\n');
