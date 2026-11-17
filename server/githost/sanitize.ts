const MAX_BODY = 60_000;
const MAX_QUOTE = 4_000;
const MAX_INLINE = 200;

export const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_-]{0,62}';
export const TASK_ID = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
export const BRANCH = new RegExp(`^aw/${SEGMENT}/${SEGMENT}$`);

const CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;
const SLASHES = '/\u2044\u2215\u2571\u27cb\u29f8\u3033';
const LEAD = new RegExp(`^(?:[\\s>*+\\-|#.)]|\\d+[.)]|\\[[ xX]?\\])*[${SLASHES}]`, 'u');
const MARKER_LINE = /^<!-- agent-works:[a-z-]+(?: [a-z]+=[\w./-]+)* -->$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const clean = (text: string): string => text.replace(/\r\n?/g, '\n').replace(CONTROL, '');

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n(cut: ${text.length - max} more characters)`;

const longestRun = (text: string): number => Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));

const unlinkRefs = (text: string): string => text.replace(/#(?=\d)/g, '#\u2060');

export const quoteBlock = (text: string, max = MAX_QUOTE): string => {
  const body = unlinkRefs(clip(clean(text), max));
  const fence = '`'.repeat(Math.max(3, longestRun(body) + 1));
  return [`${fence}text`, ...body.split('\n').map((line) => `│ ${line}`), fence].join('\n');
};

export const inlineCode = (text: string, max = MAX_INLINE): string => {
  const flat = unlinkRefs(clean(text).replace(/\s+/g, ' ').trim().slice(0, max)) || '(empty)';
  const fence = '`'.repeat(longestRun(flat) + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
};

export const plainLine = (text: string, max = MAX_INLINE): string =>
  clean(text)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .,:;_()'"?+=/-]/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])\//gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
    .slice(0, max);

const outsideCode = (line: string): string => {
  let out = '';
  let from = 0;
  const runs = /`+/g;
  for (let run = runs.exec(line); run !== null; run = runs.exec(line)) {
    const close = new RegExp(`(?<!\`)${run[0]}(?!\`)`, 'g');
    close.lastIndex = run.index + run[0].length;
    const end = close.exec(line);
    if (end === null) continue;
    out += line.slice(from, run.index);
    from = end.index + end[0].length;
    runs.lastIndex = from;
  }
  return out + line.slice(from);
};

const startsWithSlash = (line: string): boolean => LEAD.test(line.normalize('NFKC').replace(CONTROL, ''));

export const bodyProblem = (text: string): string | null => {
  if (text.length > MAX_BODY) return `is longer than ${MAX_BODY} characters`;
  let fence: string | null = null;
  for (const line of text.split(/\r\n?|\n/)) {
    if (startsWithSlash(line))
      return `has a line that starts with a slash command: ${JSON.stringify(line.slice(0, 80))}`;
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    if (MARKER_LINE.test(line)) continue;
    const prose = outsideCode(line);
    if (/@[\p{L}\p{N}_]/u.test(prose))
      return `mentions someone outside a code span: ${JSON.stringify(line.slice(0, 80))}`;
    if (prose.includes('<')) return `holds raw HTML outside a code span: ${JSON.stringify(line.slice(0, 80))}`;
    if (/\]\s*[([:]/.test(prose))
      return `holds a markdown link outside a code span: ${JSON.stringify(line.slice(0, 80))}`;
  }
  return null;
};

export const unquote = (text: string): string => {
  const block = /^(`{3,})text\n([\s\S]*)\n\1$/.exec(text);
  return block?.[2] === undefined ? text : block[2].replace(/^│ /gm, '');
};
