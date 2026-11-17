import type { Verdict } from '@agent-works/core';
import type { RuntimeId, Ticket } from '../agents/runtime.ts';
import type { ChangeFact, CheckFact } from '../githost/host.ts';

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
  readonly author: { readonly worker: string; readonly runtime: RuntimeId };
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

const collected = (lines: readonly string[]): Section => ({ state: 'collected', lines });
const missing = (reason: string): Section => ({ state: 'not_collected', reason });
const orMissing = (lines: readonly string[] | undefined, reason: string): Section =>
  lines !== undefined && lines.length > 0 ? collected(lines) : missing(reason);

const EVIDENCE_REASONS: Record<Exclude<EvidenceKind, 'ci_runs'>, string> = {
  screenshots: 'the worker attached no before and after screenshots',
  test_output: 'the worker attached no test output that fails before the change and passes after it',
  logs: 'no log source is set for this line',
};

export const mergeBrief = (input: BriefInput): MergeBrief => {
  const { ticket, change, checks, rounds } = input;
  const head = checks.filter((check) => check.headSha === change.headSha);
  const ciRuns = orMissing(
    head.map((check) => `${check.name}: ${check.state}`),
    `the host reported no checks on ${change.headSha.slice(0, 12)}`,
  );
  const evidence: Record<EvidenceKind, Section> = {
    screenshots: orMissing(input.evidence.screenshots, EVIDENCE_REASONS.screenshots),
    ci_runs: ciRuns,
    test_output:
      ticket.kind === 'defect'
        ? orMissing(input.evidence.test_output, EVIDENCE_REASONS.test_output)
        : orMissing(input.evidence.test_output, `${EVIDENCE_REASONS.test_output}; the work order is a ${ticket.kind}`),
    logs: orMissing(input.evidence.logs, EVIDENCE_REASONS.logs),
  };
  const anyEvidence = Object.values(evidence).some((section) => section.state === 'collected');
  const sameRuntime = rounds.filter((round) => round.runtime === input.author.runtime);
  const reviewLines = rounds.map(
    (round) =>
      `Round ${round.round}: ${round.reviewer} (${round.runtime}) gave ${round.verdict} on ${round.headSha.slice(0, 12)}${
        round.asked.length > 0 ? `, asked: ${round.asked.join('; ')}` : ''
      }`,
  );
  if (sameRuntime.length > 0)
    reviewLines.push(
      `Cross-runtime review not collected: the reviewer ran on ${input.author.runtime}, the author's runtime, because Codex is deferred (G0).`,
    );
  const sections: Record<BriefField, Section> = {
    summary: collected([`${ticket.title}. ${ticket.body.split(/(?<=\.)\s/)[0] ?? ''}`.trim()]),
    what_changed: orMissing(input.files, 'the host listed no changed files'),
    tests: orMissing(
      head.map((check) => `${check.name}: ${check.state}`),
      'no check ran on the head commit, so no test result is known',
    ),
    review: orMissing(reviewLines, 'no peer review was recorded'),
    risk:
      ticket.risk === null
        ? missing('the work order sets no risk level')
        : collected([`${ticket.risk.level}: ${ticket.risk.reason}`]),
    before_merge: orMissing(input.notes.beforeMerge, 'neither the work order nor the worker named a step before merge'),
    how_to_check: orMissing(input.notes.howToCheck, 'the work order names no manual check'),
    roll_back: collected([`Revert the merge commit of ${change.host === 'gitlab' ? 'MR !' : 'PR #'}${change.number}.`]),
    based_on: collected([`Work order ${ticket.id}${ticket.url === null ? '' : ` (${ticket.url})`}`]),
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
    `## Merge brief for ${brief.task}`,
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
