export const MAX_BODY = 60_000;
const MAX_QUOTE = 4_000;
const MAX_INLINE = 200;

export const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_-]{0,62}';
export const TASK_ID = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
export const BRANCH = new RegExp(`^aw/${SEGMENT}/${SEGMENT}$`);

const CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;
const SLASHES = '/\u2044\u2215\u2571\u27cb\u29f8\u3033';
const LEAD = new RegExp(`^(?:[\\s>*+\\-|#.)]|\\d+[.)]|\\[[ xX]?\\])*[${SLASHES}]`, 'u');
const MARKER_LINE = /^<!-- agent-works:[a-z-]+(?: [a-z]+=[\w./-]+)* -->$/;
const FENCE_OPEN = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

const LINE_BREAKS = new RegExp(LINE_BREAK.source, 'g');

const clean = (text: string): string => text.replace(LINE_BREAKS, '\n').replace(CONTROL, '');

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
    let slashes = 0;
    while (run.index - slashes - 1 >= from && line[run.index - slashes - 1] === '\\') slashes += 1;
    const escaped = slashes % 2 === 1;
    const ticks = escaped ? run[0].slice(1) : run[0];
    if (ticks === '') continue;
    const start = run.index + (escaped ? 1 : 0);
    const close = new RegExp(`(?<!\`)${ticks}(?!\`)`, 'g');
    close.lastIndex = run.index + run[0].length;
    const end = close.exec(line);
    if (end === null) continue;
    out += line.slice(from, start);
    from = end.index + end[0].length;
    runs.lastIndex = from;
  }
  return out + line.slice(from);
};

const startsWithSlash = (line: string): boolean => LEAD.test(line.normalize('NFKC').replace(CONTROL, ''));

const decodeEntities = (text: string): string =>
  text
    .replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));?/gi, (whole, hex?: string, dec?: string) => {
      const code = hex === undefined ? Number(dec) : Number.parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/&commat;?/gi, '@');

export const bodyProblem = (text: string): string | null => {
  if (text.length > MAX_BODY) return `is longer than ${MAX_BODY} characters`;
  let fence: string | null = null;
  for (const line of text.split(LINE_BREAK)) {
    if (startsWithSlash(line))
      return `has a line that starts with a slash command: ${JSON.stringify(line.slice(0, 80))}`;
    if (fence !== null) {
      const marker = FENCE_CLOSE.exec(line)?.[1];
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      if (open[1] !== '') return `has an indented code fence: ${JSON.stringify(line.slice(0, 80))}`;
      fence = open[2] ?? null;
      continue;
    }
    if (MARKER_LINE.test(line)) continue;
    const prose = outsideCode(line);
    if (/@[\p{L}\p{N}_]/u.test(decodeEntities(prose)))
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
