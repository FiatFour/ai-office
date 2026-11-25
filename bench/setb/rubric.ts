export const VERDICTS = ['MERGE AS IS', 'MERGE AFTER EDITS', 'REJECT'] as const;
export type Verdict = (typeof VERDICTS)[number];

export class JudgeUnparseable extends Error {}

export const RUBRIC = `You are a maintainer reviewing a pull request against a real issue. You get the issue, the diff and the CI result. You do not know who wrote the diff.

Decide with this fixed rubric.
- MERGE AS IS: the diff fixes exactly what the issue item asks, with a test that fails without the fix, no unrelated change, nothing you would edit.
- MERGE AFTER EDITS: the fix is right in direction but you would change it before merging. Give every edit as a unified diff in a \`\`\`diff block.
- REJECT: the diff does not fix the item, fixes it wrongly, weakens or skips tests, or does harm beyond the item.
CI green is necessary and not sufficient. A change to .github is always REJECT.

Reason briefly, then make the last line of your reply the word VERDICT, a colon, a space and one of the three names above, and nothing after it. Write no other line that starts with the word VERDICT and a colon.`;

const STRICTNESS: Readonly<Record<Verdict, number>> = { 'MERGE AS IS': 0, 'MERGE AFTER EDITS': 1, REJECT: 2 };

export interface Judgement {
  readonly verdict: Verdict;
  readonly editLines: number;
}

const NAMES = VERDICTS.join('|');
const OPEN = /^[\s#>*`_]*/;
const CLOSE = /[\s*`_.]*$/;
const INVISIBLE = /[\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;
/** The Thai word is normalised like the text it is matched against: NFKC splits sara am in two. */
const WORD = `(?:verdict|${'คำตัดสิน'.normalize('NFKC')})`;
const NAME_NEAR = new RegExp(`${WORD}[^\\n]{0,40}?\\b(?:${NAMES})\\b|\\b(?:${NAMES})\\b[^\\n]{0,40}?${WORD}`, 'i');
const COLON_NEAR = new RegExp(`${WORD}\\W{0,3}[:：]|verdict\\s*:`, 'i');
/** A line that states a verdict, wherever it sits: the word with a colon after it, or a verdict name near the word. */
const looksLikeVerdict = (line: string): boolean => {
  const text = line.normalize('NFKC').replace(INVISIBLE, '');
  return COLON_NEAR.test(text) || NAME_NEAR.test(text);
};
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

const trimmed = (piece: string): string =>
  piece
    .replace(OPEN, '')
    .replace(CLOSE, '')
    .replace(/\s+or$/i, '')
    .replace(CLOSE, '')
    .toUpperCase();

/** True when the lines before the final one leave a code fence open, so the final line is quoted text, not the verdict. */
const opensFence = (before: readonly string[]): boolean => before.filter((l) => /^\s*```/.test(l)).length % 2 === 1;

/** Only the final non-empty line is the verdict. Several verdicts on that line are allowed, the strictest wins. */
const finalVerdicts = (reply: string): Verdict[] => {
  const lines = reply.split(LINES).filter((l) => l.trim() !== '');
  const last = lines.pop();
  if (last === undefined) throw new JudgeUnparseable('the reply is empty');
  if (opensFence(lines)) throw new JudgeUnparseable('the final line of the reply sits inside an open code fence');
  if (lines.some(looksLikeVerdict))
    throw new JudgeUnparseable('the reply has a VERDICT-looking line before its final line');
  const [lead = '', ...pieces] = last.split(/VERDICT:/i);
  const names = pieces.map(trimmed);
  const isName = (n: string): n is Verdict => (VERDICTS as readonly string[]).includes(n);
  const leadIsPlain =
    lead
      .replace(OPEN, '')
      .replace(/\s*or\s*$/i, '')
      .trim() === '';
  if (names.length === 0 || !leadIsPlain || !names.every(isName))
    throw new JudgeUnparseable('the final line of the reply is not a VERDICT line');
  return names;
};

export const parseVerdict = (reply: string, original = ''): Judgement => {
  const found = finalVerdicts(reply);
  const verdict = found.reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a));
  if (verdict !== 'MERGE AFTER EDITS') return { verdict, editLines: 0 };
  const editLines = editLinesOf(reply, original);
  if (editLines === 0) throw new JudgeUnparseable('MERGE AFTER EDITS came with no edit diff');
  return { verdict, editLines };
};
