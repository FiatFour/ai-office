const TAIL = 6_000;
const MARKED = 2_000;
const LINE = 400;
/** Redaction runs on at most this much of one line, so a huge line costs little. */
const SCANNED = 4_000;

export const MAX_OUTPUT = TAIL + MARKED + 100;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what is removed
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const SECTION = /section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?\r?/g;
const ERROR_MARK = '##[error]';
const FAILED_LINE = /^\s*(?:ERR(?:OR)?\b|FAIL(?:ED)?\b|not ok\b|[✗✖×]|SURVIVED\b)|\berror TS\d+|##\[error\]/;

const HIDDEN = '[redacted]';
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/;
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9]{16,}|github_pat_\w{20,}/g, HIDDEN],
  [/gl[a-z]{2,6}-[\w-]{16,}/g, HIDDEN],
  [/\bsk-[\w-]{16,}|\bnpm_[A-Za-z0-9]{30,}|\bAIza[\w-]{30,}|\bxox[aboprs]-[\w-]{10,}/g, HIDDEN],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, HIDDEN],
  [/(authorization["']?\s*[:=]\s*).+/gi, `$1${HIDDEN}`],
  [/\b(bearer\s+)[\w.~+/=-]{12,}/gi, `$1${HIDDEN}`],
  [/(:\/\/)[^/\s:@]{0,100}:[^/\s@]{1,200}@/g, `$1${HIDDEN}@`],
  [
    /((?:token|secret|passw(?:or)?d|api_?key|access_?key|private_?key|credential)[\w.-]{0,40}["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
    `$1${HIDDEN}`,
  ],
];

const redact = (line: string): string =>
  SECRETS.reduce((text, [find, put]) => text.replace(find, put), line.slice(0, SCANNED));

/** A private key spans lines, so it is hidden before any line is chosen. */
const withoutKeys = (lines: readonly string[]): string[] => {
  let inside = false;
  return lines.map((line) => {
    const hidden = inside || KEY_BEGIN.test(line);
    if (hidden) inside = !KEY_END.test(line);
    return hidden ? HIDDEN : line;
  });
};

const lastThatFit = (lines: readonly string[], room: number): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = redact(lines[i] as string).slice(0, LINE);
    used += line.length + 1;
    if (used > room) break;
    kept.unshift(line);
  }
  return kept;
};

/**
 * The part of a CI job log that an author needs, bounded and with known secret shapes removed: the lines up to the last
 * error GitHub Actions marked (the job's cleanup comes after it), and any earlier line that reports a failure. Removing
 * secrets is best effort. The text is untrusted and stays data.
 */
export const logExcerpt = (raw: string): string | null => {
  const lines = withoutKeys(
    raw
      .split('\n')
      .map((line) => line.replace(ANSI, '').replace(STAMP, '').replace(SECTION, '').replace(/\r/g, '').trimEnd()),
  );
  const marked = lines.findLastIndex((line) => line.startsWith(ERROR_MARK));
  const upTo = marked < 0 ? lines : lines.slice(0, marked + 1);
  const tail = lastThatFit(upTo, TAIL);
  const earlier = lastThatFit(
    upTo.slice(0, upTo.length - tail.length).filter((line) => FAILED_LINE.test(line)),
    MARKED,
  );
  const text = (earlier.length === 0 ? tail : [...earlier, '[...]', ...tail]).join('\n').trim();
  return text === '' ? null : text;
};
