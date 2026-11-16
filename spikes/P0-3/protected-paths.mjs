import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path/posix';

/**
 * @typedef {{
 *   home: string, cwd: string, mapDir?: ((path: string) => string) | undefined, maxEntries?: number,
 * }} PathContext
 * @typedef {{ blocked: false } | { blocked: true, reason: string, path: string }} Verdict
 * @typedef {{ tool_name: string, tool_input?: unknown }} ToolCall
 */

export const ALLOWED_NAMES = ['.env.example', '.env.sample', '.env.template'];
const ALLOWED_SUFFIXES = ['.pub'];

const NAME_GLOBS = [
  '.env',
  '.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  'id_rsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials*.json',
  '*secret*.json',
  '*.tfvars',
  'kubeconfig*',
  'secrets.json',
];
const PROTECTED_DIRS = ['.ssh', '.aws', '.azure', '.config/gcloud', '.config/glab-cli', '.agent-works'];
const PROTECTED_FILES = ['.config/gh/hosts.yml', '.docker/config.json', '.kube/config'];

/** @param {string} glob */
const globToRegExp = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`, 'i');
const NAME_PATTERNS = NAME_GLOBS.map(globToRegExp);

export const PROTECTED_GLOBS = {
  names: NAME_GLOBS,
  homeDirs: PROTECTED_DIRS,
  homeFiles: PROTECTED_FILES,
};

const SKIPPED_DIRS = new Set(['node_modules', '.git']);
export const MAX_ENTRIES = 250_000;

/** @param {string} raw @param {PathContext} ctx */
const expand = (raw, ctx) => {
  const home = raw.replace(/^~(?=\/|$)/, ctx.home).replace(/\$\{HOME\}|\$HOME/g, ctx.home);
  return isAbsolute(home) ? resolve(home) : resolve(ctx.cwd, home);
};

/** @param {string} path @param {PathContext} ctx */
const onDisk = (path, ctx) => (ctx.mapDir ? ctx.mapDir(path) : path);

/** @param {string} path @param {string[]} segments */
const hasSegments = (path, segments) => `/${path}/`.includes(`/${segments}/`);

/**
 * @param {string} raw
 * @param {PathContext} ctx
 */
export const isProtectedPath = (raw, ctx) => {
  const path = expand(raw, ctx).toLowerCase();
  const name = basename(path);
  if (ALLOWED_NAMES.includes(name) || ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (NAME_PATTERNS.some((pattern) => pattern.test(name))) return true;
  if (PROTECTED_DIRS.some((dir) => hasSegments(path, [dir]))) return true;
  return PROTECTED_FILES.some((file) => path.endsWith(`/${file}`));
};

export class ScanLimitError extends Error {}

/**
 * Walks a tree without a silent cutoff. node_modules and .git are skipped on purpose: packages ship
 * test keys that would make every recursive search look protected, and .git is covered by the git rules.
 * A tree over the entry cap throws, so every caller must fail closed.
 * @param {string} dir
 * @param {PathContext} ctx
 * @param {number} [limit]
 * @returns {string[]}
 */
export const findProtected = (dir, ctx, limit = Number.POSITIVE_INFINITY) => {
  const cap = ctx.maxEntries ?? MAX_ENTRIES;
  const found = [];
  const pending = [dir];
  let seen = 0;
  while (pending.length > 0 && found.length < limit) {
    const current = /** @type {string} */ (pending.pop());
    let entries;
    try {
      entries = readdirSync(onDisk(current, ctx), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > cap) throw new ScanLimitError(`${dir} is too large to scan (cap ${cap} entries)`);
      const full = join(current, entry.name);
      if (isProtectedPath(full, ctx)) found.push(full);
      else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) pending.push(full);
    }
  }
  return found;
};

/**
 * @param {string} dir
 * @param {PathContext} ctx
 */
export const directoryHoldsProtected = (dir, ctx) => findProtected(dir, ctx, 1).length > 0;

/**
 * Protected paths that git tracks in the index or holds in any reachable commit.
 * @param {string} dir
 * @param {PathContext} ctx
 * @returns {string[]}
 */
export const trackedProtected = (dir, ctx) => {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync('git', ['-c', 'safe.directory=*', '-C', onDisk(dir, ctx), ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let paths;
  try {
    const indexed = git(['ls-files', '-z']).split('\0');
    const history = git(['rev-list', '--all', '--objects'])
      .split('\n')
      .filter((line) => line.includes(' '))
      .map((line) => line.slice(line.indexOf(' ') + 1));
    paths = [...indexed, ...history];
  } catch {
    return [];
  }
  const inRepo = { ...ctx, cwd: '/' };
  return [...new Set(paths.filter((path) => path && isProtectedPath(`/${path}`, inRepo)))];
};

/** @param {string} path @param {PathContext} ctx */
const isDirectory = (path, ctx) => {
  try {
    return statSync(onDisk(path, ctx)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Splits a shell command into commands of words with a small, documented grammar. Quotes and
 * backslashes are removed, `$'..'` loses its `$`, `;&|()` backticks and newlines end a command,
 * and whitespace, `<`, `>` and `=` end a word.
 * @param {string} command
 * @returns {string[][]}
 */
export const parseCommands = (command) => {
  /** @type {string[][]} */
  const commands = [];
  /** @type {string[]} */
  let tokens = [];
  let current = '';
  /** @type {string | null} */
  let quote = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = '';
  };
  const endCommand = () => {
    flush();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = /** @type {string} */ (command[index]);
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (char === '\\') {
      const next = command[index + 1];
      index += 1;
      if (next !== undefined && next !== '\n') current += next;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '$' && command[index + 1] === "'") {
    } else if (char === '"' || char === "'") quote = char;
    else if (/[;&|()`\n]/.test(char)) endCommand();
    else if (/[\s<>=]/.test(char)) flush();
    else current += char;
  }
  endCommand();
  return commands;
};

/** @param {string} command */
export const tokenize = (command) => parseCommands(command).flat();

/** @param {string} glob */
const nameGlob = (glob) => {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = /** @type {string} */ (glob[index]);
    const close = char === '[' ? glob.indexOf(']', index + 2) : -1;
    if (close > 0) {
      const body = glob
        .slice(index + 1, close)
        .replace(/^[!^]/, '^')
        .replace(/\\/g, '\\\\');
      source += `[${body}]`;
      index = close;
    } else if (char === '{' && glob.indexOf('}', index) > 0) {
      const end = glob.indexOf('}', index);
      source += `(?:${glob
        .slice(index + 1, end)
        .split(',')
        .map((part) => part.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
        .join('|')})`;
      index = end;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
};

const GLOB_CHARS = /[*?[{]/;

/**
 * @param {string} glob a glob whose last segment may use wildcards
 * @param {string[]} names
 */
const globMatchesAny = (glob, names) => {
  const pattern = nameGlob(basename(glob));
  const dotted = basename(glob).startsWith('.');
  return names.some((name) => (dotted || !name.startsWith('.')) && pattern.test(name));
};

/**
 * @param {string} token
 * @param {PathContext} ctx
 */
const globHitsProtected = (token, ctx) => {
  if (!GLOB_CHARS.test(basename(token)) || GLOB_CHARS.test(dirname(token))) return false;
  const parent = expand(dirname(token), ctx);
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(onDisk(parent, ctx));
  } catch {
    return false;
  }
  const pattern = nameGlob(basename(token));
  const dotted = basename(token).startsWith('.');
  return names.some(
    (name) => (dotted || !name.startsWith('.')) && pattern.test(name) && isProtectedPath(join(parent, name), ctx),
  );
};

/** @param {string} token */
const candidates = (token) => {
  const pieces = [token];
  const colon = token.lastIndexOf(':');
  if (colon >= 0) pieces.push(token.slice(colon + 1));
  if (/[{},]/.test(token)) pieces.push(...token.split(/[{},]/));
  return pieces.filter(Boolean);
};

/** @param {string} command */
const withAssignments = (command) => {
  let text = command;
  for (let pass = 0; pass < 3; pass++) {
    const names = new Map();
    for (const match of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|()]*)/g)) {
      names.set(match[1], String(match[2]).replace(/^["']|["']$/g, ''));
    }
    const next = text.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, a, b) => names.get(a ?? b) ?? whole);
    if (next === text) break;
    text = next;
  }
  return text;
};

const RECURSIVE_SEARCH = /^(rg|ag|ack|grep|egrep|fgrep|find)$/;
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'sudo',
  'builtin',
  'timeout',
  'stdbuf',
  'setsid',
]);
const INTERPRETERS = /^(python[\d.]*|node|nodejs|deno|bun|ruby|perl|php|sh|bash|zsh|dash|ksh|awk|gawk|lua)$/;
const WHOLE_TREE_READERS = new Set(['tar', 'zip', '7z', '7za', 'cpio']);
const COPIERS = new Set(['cp', 'rsync', 'scp']);
const GIT_READERS = new Set([
  'show',
  'cat-file',
  'grep',
  'log',
  'diff',
  'diff-tree',
  'diff-index',
  'blame',
  'archive',
  'format-patch',
  'stash',
  'whatchanged',
  'rev-list',
  'difftool',
]);

/** @param {string[]} tokens */
const unwrap = (tokens) => {
  let index = 0;
  while (index < tokens.length && WRAPPERS.has(basename(/** @type {string} */ (tokens[index])))) {
    index += 1;
    while (
      index < tokens.length &&
      (/^-/.test(/** @type {string} */ (tokens[index])) || /^\d+$/.test(/** @type {string} */ (tokens[index])))
    )
      index += 1;
  }
  return tokens.slice(index);
};

/** @param {string[]} tokens @param {PathContext} ctx */
const directoryOperands = (tokens, ctx) =>
  tokens
    .slice(1)
    .filter((token) => !token.startsWith('-'))
    .map((token) => expand(token, ctx))
    .filter((path) => isDirectory(path, ctx));

/**
 * @param {string} dir
 * @param {PathContext} ctx
 */
const holds = (dir, ctx) => {
  try {
    return directoryHoldsProtected(dir, ctx);
  } catch (error) {
    if (error instanceof ScanLimitError) return true;
    throw error;
  }
};

/**
 * @param {string[]} tokens
 * @param {PathContext} ctx
 * @returns {string | null}
 */
const recursiveSearchHit = (tokens, ctx) => {
  const [first = ''] = tokens;
  const program = basename(first);
  /** @type {string[]} */
  let targets = [];
  if (RECURSIVE_SEARCH.test(program)) {
    const grepLike = /^(grep|egrep|fgrep)$/.test(program);
    const flags = tokens.slice(1).filter((token) => token.startsWith('-'));
    const recurse = tokens.includes('recurse') && (flags.includes('-d') || flags.includes('--directories'));
    const recursive =
      program === 'find' ||
      !grepLike ||
      recurse ||
      flags.some(
        (flag) => flag === '--recursive' || flag === '--dereference-recursive' || /^-[a-zA-Z]*[rR]/.test(flag),
      );
    if (!recursive) return null;
    const operands = tokens.slice(1).filter((token) => !token.startsWith('-') && token !== 'recurse');
    const paths = program === 'find' ? operands : operands.slice(1);
    targets =
      paths.length === 0 ? [ctx.cwd] : paths.map((path) => expand(path, ctx)).filter((path) => isDirectory(path, ctx));
  } else if (WHOLE_TREE_READERS.has(program)) {
    targets = directoryOperands(tokens, ctx);
  } else if (
    COPIERS.has(program) &&
    tokens.some((token) => /^-[a-zA-Z]*[rRa]/.test(token) || token === '--recursive')
  ) {
    targets = directoryOperands(tokens, ctx).filter(
      (path) => path !== expand(/** @type {string} */ (tokens.at(-1)), ctx),
    );
  }
  return targets.find((target) => holds(target, ctx)) ?? null;
};

/**
 * @param {string[]} tokens
 * @param {PathContext} ctx
 * @returns {string | null}
 */
const trackedGitHit = (tokens, ctx) => {
  if (basename(tokens[0] ?? '') !== 'git') return null;
  let repo = ctx.cwd;
  let index = 1;
  while (index < tokens.length && /^-/.test(/** @type {string} */ (tokens[index]))) {
    if (tokens[index] === '-C') repo = expand(tokens[index + 1] ?? '.', ctx);
    index += tokens[index] === '-C' || tokens[index] === '-c' ? 2 : 1;
  }
  if (!GIT_READERS.has(tokens[index] ?? '')) return null;
  return trackedProtected(repo, ctx)[0] ?? null;
};

/** @param {string} text @param {PathContext} ctx */
const embeddedName = (text, ctx) => text.split(/[^\w.\-/~$]+/).find((piece) => piece && isProtectedPath(piece, ctx));

/**
 * @param {string} command
 * @param {PathContext} ctx
 * @returns {Verdict}
 */
const checkBash = (command, ctx) => {
  for (const text of new Set([command, withAssignments(command)])) {
    const commands = parseCommands(text);
    for (const token of commands.flat()) {
      const named =
        candidates(token).find((piece) => isProtectedPath(piece, ctx)) ??
        (globHitsProtected(token, ctx) ? token : undefined);
      if (named) return { blocked: true, path: named, reason: `the command names the protected path ${named}` };
    }
    for (const raw of commands) {
      const segment = unwrap(raw);
      if (INTERPRETERS.test(basename(segment[0] ?? ''))) {
        const hidden = segment.map((token) => embeddedName(token, ctx)).find(Boolean);
        if (hidden)
          return { blocked: true, path: hidden, reason: `the script text names the protected path ${hidden}` };
      }
      const hit = recursiveSearchHit(segment, ctx);
      if (hit) {
        return {
          blocked: true,
          path: hit,
          reason: `a recursive read of ${hit} would reach protected files, or the tree is too large to scan`,
        };
      }
      const tracked = trackedGitHit(segment, ctx);
      if (tracked) {
        return {
          blocked: true,
          path: tracked,
          reason: `git holds the protected path ${tracked} in a tracked file or a commit, so a git reader would print it (preflight must untrack it)`,
        };
      }
    }
  }
  return { blocked: false };
};

const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern', 'glob'];
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);

/** @param {unknown} value @returns {string[]} */
const stringLeaves = (value) => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
};

/**
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {PathContext} ctx
 * @returns {Verdict}
 */
const checkFileTool = (tool, input, ctx) => {
  const deny = (/** @type {string} */ path, /** @type {string} */ reason) =>
    /** @type {Verdict} */ ({ blocked: true, path, reason });
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (value !== undefined && typeof value !== 'string') return deny(field, `${tool} has a non-string ${field}`);
  }
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
  const glob = typeof input.glob === 'string' ? input.glob : undefined;
  for (const value of [filePath, path, input.notebook_path, tool === 'Glob' ? pattern : undefined, glob]) {
    if (typeof value === 'string' && value !== '' && isProtectedPath(value, ctx)) {
      return deny(value, `${tool} targets the protected path ${value}`);
    }
  }
  if (tool !== 'Grep' && tool !== 'Glob') return { blocked: false };
  const root = expand(path ?? '.', ctx);
  if (!isDirectory(root, ctx)) return { blocked: false };
  const restriction = tool === 'Glob' ? pattern : glob;
  try {
    const found = findProtected(root, ctx);
    if (found.length === 0) return { blocked: false };
    if (restriction === undefined) return deny(path ?? '.', `${tool} would read protected files under ${root}`);
    if (
      globMatchesAny(
        restriction,
        found.map((file) => basename(file)),
      )
    ) {
      return deny(restriction, `${tool} pattern ${restriction} matches a protected file under ${root}`);
    }
  } catch (error) {
    if (!(error instanceof ScanLimitError)) throw error;
    return deny(root, `${tool} root ${root} is too large to scan for protected files`);
  }
  return { blocked: false };
};

/**
 * @param {ToolCall} call
 * @param {PathContext} ctx
 * @returns {Verdict}
 */
export const checkToolCall = (call, ctx) => {
  const malformed = (/** @type {string} */ what) =>
    /** @type {Verdict} */ ({ blocked: true, path: '', reason: `malformed tool call: ${what}` });
  if (typeof call.tool_name !== 'string') return malformed('tool name is not a string');
  const input = call.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return FILE_TOOLS.has(call.tool_name) || call.tool_name === 'Bash' || call.tool_name.startsWith('mcp__')
      ? malformed('tool input is not an object')
      : { blocked: false };
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  if (call.tool_name === 'Bash') {
    return typeof record.command === 'string' ? checkBash(record.command, ctx) : malformed('command is not a string');
  }
  if (FILE_TOOLS.has(call.tool_name)) return checkFileTool(call.tool_name, record, ctx);
  if (call.tool_name.startsWith('mcp__')) {
    const hit = stringLeaves(record).find((value) => isProtectedPath(value, ctx));
    if (hit) return { blocked: true, path: hit, reason: `${call.tool_name} argument names the protected path ${hit}` };
  }
  return { blocked: false };
};
