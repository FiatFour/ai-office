import type { Verdict } from '@agent-works/core';
import type { RuntimeId, Ticket } from '../agents/runtime.ts';
import type { ChangeFact, CheckFact } from '../githost/host.ts';
import { inlineCode, plainLine, quoteBlock } from '../githost/sanitize.ts';

export const BRIEF_FIELDS = [
  'summary',
  'what_changed',
  'tests',
  'review',
  'risk',
  'before_merge',
  'how_to_check',
  'roll_back',
  'based_on',
  'evidence',
  'root_cause',
] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

export const EVIDENCE_KINDS = ['screenshots', 'ci_runs', 'test_output', 'logs'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type Section =
  | { readonly state: 'collected'; readonly lines: readonly string[] }
  | { readonly state: 'not_collected'; readonly reason: string }
  | { readonly state: 'not_applicable'; readonly reason: string };

export interface ReviewRound {
  readonly round: number;
  readonly reviewer: string;
  readonly runtime: RuntimeId;
  readonly verdict: Verdict;
  readonly headSha: string;
  readonly asked: readonly string[];
}

export interface BriefInput {
  readonly ticket: Ticket;
  readonly change: ChangeFact;
  readonly files: readonly string[];
  readonly checks: readonly CheckFact[];
  readonly rounds: readonly ReviewRound[];
  readonly author: { readonly runtime: RuntimeId };
  readonly evidence: Partial<Record<Exclude<EvidenceKind, 'ci_runs'>, readonly string[]>>;
  readonly notes: { readonly beforeMerge?: readonly string[]; readonly howToCheck?: readonly string[] };
}

export interface MergeBrief {
  readonly task: string;
  readonly pr: number;
  readonly url: string;
  readonly headSha: string;
  readonly risk: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  readonly flagged: boolean;
  readonly sections: Readonly<Record<BriefField, Section>>;
  readonly evidence: Readonly<Record<EvidenceKind, Section>>;
}

const FILE_LIST_BUDGET = 20_000;

const fileLines = (files: readonly string[]): string[] => {
  const lines: string[] = [];
  let used = 0;
  for (const file of files) {
    const line = inlineCode(file);
    used += line.length + 3;
    if (used > FILE_LIST_BUDGET) return [...lines, `${files.length - lines.length} more files not listed`];
    lines.push(line);
  }
  return lines;
};

const collected = (lines: readonly string[]): Section => ({ state: 'collected', lines });
const missing = (reason: string): Section => ({ state: 'not_collected', reason });
const orMissing = (lines: readonly string[] | undefined, reason: string): Section =>
  lines !== undefined && lines.length > 0 ? collected(lines) : missing(reason);
const plain = (lines: readonly string[] | undefined) => lines?.map((line) => plainLine(line, 500));

const EVIDENCE_REASONS: Record<Exclude<EvidenceKind, 'ci_runs'>, string> = {
  screenshots: 'the worker attached no before and after screenshots',
  test_output: 'the worker attached no test output that fails before the change and passes after it',
  logs: 'no log source is set for this line',
};

export const mergeBrief = (input: BriefInput): MergeBrief => {
  const { ticket, change, checks, rounds } = input;
  const head = checks.filter((check) => check.headSha === change.headSha);
  const checkLines = head.map((check) => `${inlineCode(check.name)}: ${check.state}`);
  const ciRuns = orMissing(checkLines, `the host reported no checks on ${change.headSha.slice(0, 12)}`);
  const evidence: Record<EvidenceKind, Section> = {
    screenshots: orMissing(plain(input.evidence.screenshots), EVIDENCE_REASONS.screenshots),
    ci_runs: ciRuns,
    test_output: orMissing(
      plain(input.evidence.test_output),
      ticket.kind === 'defect'
        ? EVIDENCE_REASONS.test_output
        : `${EVIDENCE_REASONS.test_output}; the work order is a ${ticket.kind}`,
    ),
    logs: orMissing(plain(input.evidence.logs), EVIDENCE_REASONS.logs),
  };
  const anyEvidence = Object.values(evidence).some((section) => section.state === 'collected');
  const sameRuntime = rounds.some((round) => round.runtime === input.author.runtime);
  const reviewLines = rounds.map(
    (round) =>
      `Round ${round.round}: ${round.reviewer} (${round.runtime}) gave ${round.verdict} on ${round.headSha.slice(0, 12)}${
        round.asked.length > 0 ? `, asked:\n${quoteBlock(round.asked.join('\n'))}` : ''
      }`,
  );
  if (sameRuntime)
    reviewLines.push(
      `Cross-runtime review not collected: the reviewer ran on ${input.author.runtime}, the author's runtime, because Codex is deferred (G0).`,
    );
  const sections: Record<BriefField, Section> = {
    summary: collected([
      `${plainLine(ticket.title)}. ${plainLine(ticket.body.split(/(?<=\.)\s/)[0] ?? '', 500)}`.trim(),
    ]),
    what_changed: orMissing(fileLines(input.files), 'the host listed no changed files'),
    tests: orMissing(checkLines, 'no check ran on the head commit, so no test result is known'),
    review: orMissing(reviewLines, 'no peer review was recorded'),
    risk:
      ticket.risk === null
        ? missing('the work order sets no risk level')
        : collected([`${ticket.risk.level}: ${plainLine(ticket.risk.reason, 500)}`]),
    before_merge: orMissing(
      plain(input.notes.beforeMerge),
      'neither the work order nor the worker named a step before merge',
    ),
    how_to_check: orMissing(plain(input.notes.howToCheck), 'the work order names no manual check'),
    roll_back: collected([`Revert the merge commit of ${change.host === 'gitlab' ? 'MR !' : 'PR #'}${change.number}.`]),
    based_on: collected([
      `Work order ${inlineCode(ticket.id)}${ticket.url === null ? '' : ` (${inlineCode(ticket.url)})`}`,
    ]),
    evidence: anyEvidence
      ? collected(EVIDENCE_KINDS.filter((kind) => evidence[kind].state === 'collected'))
      : missing('no evidence of any kind was collected'),
    root_cause:
      ticket.kind === 'defect'
        ? missing('the worker did not report a root cause')
        : { state: 'not_applicable', reason: `the work order is a ${ticket.kind}, not a defect` },
  };
  const risk = ticket.risk?.level ?? null;
  return {
    task: ticket.id,
    pr: change.number,
    url: change.url,
    headSha: change.headSha,
    risk,
    flagged: risk === 'HIGH' && !anyEvidence,
    sections,
    evidence,
  };
};

const TITLES: Record<BriefField | EvidenceKind, string> = {
  summary: 'Summary',
  what_changed: 'What changed',
  tests: 'Tests',
  review: 'Review',
  risk: 'Risk',
  before_merge: 'Before merge',
  how_to_check: 'How to check',
  roll_back: 'Roll back',
  based_on: 'Based on',
  evidence: 'Evidence',
  root_cause: 'Root cause',
  screenshots: 'Screenshots',
  ci_runs: 'CI runs',
  test_output: 'Test output',
  logs: 'Logs',
};

const render = (title: string, section: Section): string[] => {
  if (section.state === 'collected') return [`**${title}**`, ...section.lines.map((line) => `- ${line}`), ''];
  const label = section.state === 'not_collected' ? 'not collected' : 'not applicable';
  return [`**${title}**`, `- ${label}: ${section.reason}`, ''];
};

export const briefMarker = (task: string, headSha: string): string =>
  `<!-- agent-works:merge-brief task=${task} head=${headSha} -->`;

export const renderBrief = (brief: MergeBrief): string =>
  [
    `## Merge brief for ${inlineCode(brief.task)}`,
    '',
    brief.flagged ? 'HIGH risk with no evidence. Read the change before you merge.\n' : '',
    ...BRIEF_FIELDS.filter((field) => field !== 'evidence').flatMap((field) =>
      render(TITLES[field], brief.sections[field]),
    ),
    '**Evidence**',
    ...EVIDENCE_KINDS.map((kind) => {
      const section = brief.evidence[kind];
      return section.state === 'collected'
        ? `- ${TITLES[kind]}: ${section.lines.join(', ')}`
        : `- ${TITLES[kind]}: ${section.state === 'not_collected' ? 'not collected' : 'not applicable'}, ${section.reason}`;
    }),
    '',
    'HQ never merges. A person merges this on the host.',
    briefMarker(brief.task, brief.headSha),
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
