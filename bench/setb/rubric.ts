export const VERDICTS = ['MERGE AS IS', 'MERGE AFTER EDITS', 'REJECT'] as const;
export type Verdict = (typeof VERDICTS)[number];

export class JudgeUnparseable extends Error {}

export const RUBRIC = `You are a maintainer reviewing a pull request against a real issue. You get the issue, the diff and the CI result. You do not know who wrote the diff.

Decide with this fixed rubric.
- MERGE AS IS: the diff fixes exactly what the issue item asks, with a test that fails without the fix, no unrelated change, nothing you would edit.
- MERGE AFTER EDITS: the fix is right in direction but you would change it before merging. Give every edit as a unified diff in a \`\`\`diff block.
- REJECT: the diff does not fix the item, fixes it wrongly, weakens or skips tests, or does harm beyond the item.
CI green is necessary and not sufficient. A change to .github is always REJECT.

Reason briefly, then end with one line, exactly:
VERDICT: MERGE AS IS
or VERDICT: MERGE AFTER EDITS
or VERDICT: REJECT`;

const STRICTNESS: Readonly<Record<Verdict, number>> = { 'MERGE AS IS': 0, 'MERGE AFTER EDITS': 1, REJECT: 2 };

export interface Judgement {
  readonly verdict: Verdict;
  readonly editLines: number;
}

const VERDICT_LINE = /^[ \t]*VERDICT:[ \t]*(MERGE AS IS|MERGE AFTER EDITS|REJECT)[ \t]*$/gm;
const DIFF_BLOCK = /```diff\n([\s\S]*?)```/g;

export const editLinesOf = (reply: string): number =>
  [...reply.matchAll(DIFF_BLOCK)].reduce(
    (n, block) => n + (block[1] ?? '').split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length,
    0,
  );

export const parseVerdict = (reply: string): Judgement => {
  const found = [...reply.matchAll(VERDICT_LINE)].map((m) => m[1] as Verdict);
  if (found.length === 0) throw new JudgeUnparseable('the reply has no VERDICT line');
  const verdict = found.reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a));
  if (verdict !== 'MERGE AFTER EDITS') return { verdict, editLines: 0 };
  const editLines = editLinesOf(reply);
  if (editLines === 0) throw new JudgeUnparseable('MERGE AFTER EDITS came with no edit diff');
  return { verdict, editLines };
};
