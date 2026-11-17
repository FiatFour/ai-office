import { describe, expect, it } from 'vitest';
import type { Ticket } from '../agents/runtime.ts';
import { BRIEF_FIELDS, type BriefInput, EVIDENCE_KINDS, mergeBrief, renderBrief } from '../brief/merge-brief.ts';

const ticket: Ticket = {
  id: 'alpha/t1',
  kind: 'feature',
  title: 'Add a greeting',
  body: 'Print hello. Keep it short.',
  url: 'https://example.invalid/orders/alpha-t1',
  risk: null,
};

const base: BriefInput = {
  ticket,
  change: {
    host: 'github',
    kind: 'change',
    repo: 'acme/app',
    headRepo: 'acme/app',
    number: 7,
    branch: 'aw/alpha/t1',
    author: 'aw-bot',
    state: 'open',
    headSha: 'f'.repeat(40),
    url: 'https://github.com/acme/app/pull/7',
    at: 1,
  },
  files: ['src/greet.txt'],
  checks: [],
  rounds: [],
  author: { runtime: 'claude-code' },
  evidence: {},
  notes: {},
};

describe('the merge brief', () => {
  it('lists every missing piece of evidence as not collected, with a reason', () => {
    const brief = mergeBrief(base);
    for (const kind of EVIDENCE_KINDS) {
      const section = brief.evidence[kind];
      expect(section.state, kind).toBe('not_collected');
      expect(section.state === 'not_collected' && section.reason.length > 10, kind).toBe(true);
    }
    const text = renderBrief(brief);
    for (const title of ['Screenshots', 'CI runs', 'Test output', 'Logs'])
      expect(text).toMatch(new RegExp(`- ${title}: not collected, \\S`));
    expect(text).toContain('**Risk**\n- not collected: the work order sets no risk level');
  });

  it('renders every field of the spec', () => {
    const text = renderBrief(mergeBrief(base));
    for (const title of [
      'Summary',
      'What changed',
      'Tests',
      'Review',
      'Risk',
      'Before merge',
      'How to check',
      'Roll back',
      'Based on',
      'Evidence',
      'Root cause',
    ])
      expect(text).toContain(`**${title}**`);
    expect(BRIEF_FIELDS).toHaveLength(11);
    expect(text).toContain('<!-- agent-works:merge-brief task=alpha/t1 head=ffff');
    expect(text).toContain('https://example.invalid/orders/alpha-t1');
  });

  it('shows collected evidence and the review rounds, and names a same-runtime review as a gap', () => {
    const brief = mergeBrief({
      ...base,
      checks: [
        {
          host: 'github',
          kind: 'check',
          repo: 'acme/app',
          headSha: 'f'.repeat(40),
          name: 'ci',
          state: 'success',
          at: 2,
        },
        { host: 'github', kind: 'check', repo: 'acme/app', headSha: 'old', name: 'ci', state: 'failure', at: 1 },
      ],
      rounds: [
        {
          round: 1,
          reviewer: 'vega',
          runtime: 'claude-code',
          verdict: 'changes',
          headSha: 'a'.repeat(40),
          asked: ['src/greet.txt:1 say hi'],
        },
      ],
      evidence: { screenshots: ['before.png', 'after.png'] },
    });
    expect(brief.evidence.ci_runs).toEqual({ state: 'collected', lines: ['ci: success'] });
    expect(brief.evidence.screenshots).toEqual({ state: 'collected', lines: ['before.png', 'after.png'] });
    expect(brief.sections.evidence).toEqual({ state: 'collected', lines: ['screenshots', 'ci_runs'] });
    const review = brief.sections.review;
    expect(review.state === 'collected' && review.lines.join('\n')).toMatch(
      /Round 1: vega \(claude-code\) gave changes.*say hi/,
    );
    expect(review.state === 'collected' && review.lines.join('\n')).toContain('Cross-runtime review not collected');
  });

  it('flags a HIGH risk change that has no evidence, and only that', () => {
    const high = { ...ticket, risk: { level: 'HIGH' as const, reason: 'touches auth' } };
    expect(mergeBrief({ ...base, ticket: high }).flagged).toBe(true);
    expect(renderBrief(mergeBrief({ ...base, ticket: high }))).toContain('HIGH risk with no evidence');
    expect(mergeBrief({ ...base, ticket: high, evidence: { logs: ['0 errors after'] } }).flagged).toBe(false);
    expect(mergeBrief({ ...base, ticket: { ...high, risk: { level: 'LOW', reason: 'docs' } } }).flagged).toBe(false);
  });

  it('asks a defect for a root cause and its test output, and marks root cause not applicable otherwise', () => {
    const defect = mergeBrief({ ...base, ticket: { ...ticket, kind: 'defect' } });
    expect(defect.sections.root_cause.state).toBe('not_collected');
    expect(mergeBrief(base).sections.root_cause.state).toBe('not_applicable');
  });
});
