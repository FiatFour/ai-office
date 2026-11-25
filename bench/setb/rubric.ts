export const VERDICTS = ['MERGE AS IS', 'MERGE AFTER EDITS', 'REJECT'] as const;
export type Verdict = (typeof VERDICTS)[number];

export class JudgeUnparseable extends Error {}

export const RUBRIC = `You are a maintainer reviewing a pull request against a real issue. You get the issue, the diff and the CI result. You do not know who wrote the diff.

Decide with this fixed rubric.
- MERGE AS IS: the diff fixes exactly what the issue item asks, with a test that fails without the fix, no unrelated change, nothing you would edit.
- MERGE AFTER EDITS: the fix is right in direction but you would change it before merging. Give every edit as a unified diff in a \`\`\`diff block.
- REJECT: the diff does not fix the item, fixes it wrongly, weakens or skips tests, or does harm beyond the item.
CI green is necessary and not sufficient. A change to .github is always REJECT.

Reason briefly. Then end your reply with exactly one final line, which is one of these three and nothing else: the word VERDICT, a colon, a space and MERGE AS IS; or the word VERDICT, a colon, a space and MERGE AFTER EDITS; or the word VERDICT, a colon, a space and REJECT. Nothing may follow that line. No earlier line may begin with the word VERDICT and a colon; a reply that breaks this cannot be read and is discarded.`;

export interface Judgement {
  readonly verdict: Verdict;
  readonly editLines: number;
}

const MARKS = /[*_`]/g;
/** The line without markdown emphasis and backticks. */
const plain = (line: string): string => line.replace(MARKS, '');
const FINAL = new RegExp(`^\\s*VERDICT:\\s?(${VERDICTS.join('|')})\\.?\\s*$`, 'i');
/** After the marks and any heading, quote or list marker are dropped, the line starts with the word VERDICT and a colon. */
export const startsWithVerdict = (line: string): boolean =>
  /^verdict\s*:/i.test(plain(line).replace(/^(?:[\s#>+-]|\d+[.)]\s)*/, ''));
const FENCE = /^\s*```/;
const DIFF_BLOCK = /```diff[ \t]*\r?\n([\s\S]*?)```/g;
const LINES = /\r?\n/;
const isChange = (l: string): boolean => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l);

const quotesOriginal = (block: string, original: string): boolean => {
  const text = block.split(LINES).join('\n').trim();
  return text !== '' && original.split(LINES).join('\n').includes(text);
};

export const editLinesOf = (reply: string, original = ''): number =>
  [...reply.matchAll(DIFF_BLOCK)].reduce((n, block) => {
    const body = block[1] ?? '';
    return quotesOriginal(body, original) ? n : n + body.split(LINES).filter(isChange).length;
  }, 0);

/**
 * The contract: the last non-empty line is `VERDICT: <name>` (emphasis, backticks, a trailing period, any case and CRLF are
 * tolerated), no earlier line outside a code fence starts with `VERDICT:`, and the last line is not inside an open fence
 * (a diff block cut off by the end of the reply). Nothing else is looked for.
 */
const finalVerdict = (reply: string): Verdict => {
  const lines = reply.split(LINES).filter((l) => l.trim() !== '');
  const last = lines.pop();
  if (last === undefined) throw new JudgeUnparseable('the reply is empty');
  let open = false;
  for (const line of lines) {
    if (FENCE.test(line)) open = !open;
    else if (!open && startsWithVerdict(line))
      throw new JudgeUnparseable('the reply has a line starting with VERDICT: before its final line');
  }
  if (open) throw new JudgeUnparseable('the final line of the reply sits inside an open code fence');
  const name = FINAL.exec(plain(last))?.[1];
  if (name === undefined) throw new JudgeUnparseable('the final line of the reply is not a VERDICT line');
  return name.toUpperCase() as Verdict;
};

export const parseVerdict = (reply: string, original = ''): Judgement => {
  const verdict = finalVerdict(reply);
  if (verdict !== 'MERGE AFTER EDITS') return { verdict, editLines: 0 };
  const editLines = editLinesOf(reply, original);
  if (editLines === 0) throw new JudgeUnparseable('MERGE AFTER EDITS came with no edit diff');
  return { verdict, editLines };
};
