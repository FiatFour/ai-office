import { readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/**
 * @typedef {{ home: string, cwd: string, mapDir?: ((path: string) => string) | undefined }} PathContext
 * @typedef {{ blocked: false } | { blocked: true, reason: string, path: string }} Verdict
 * @typedef {{ tool_name: string, tool_input?: Record<string, unknown> }} ToolCall
 */

export const ALLOWED_NAMES = ['.env.example', '.env.sample', '.env.template'];
const ALLOWED_SUFFIXES = ['.pub'];

const NAME_GLOBS = [
  '.env',
  '.env.*',
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
const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
const NAME_PATTERNS = NAME_GLOBS.map(globToRegExp);

export const PROTECTED_GLOBS = {
  names: NAME_GLOBS,
  homeDirs: PROTECTED_DIRS,
  homeFiles: PROTECTED_FILES,
};

const SKIPPED_DIRS = new Set(['node_modules', '.git']);
const WALK_LIMIT = 5000;

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
  const path = expand(raw, ctx);
  const name = basename(path);
  if (ALLOWED_NAMES.includes(name) || ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (NAME_PATTERNS.some((pattern) => pattern.test(name))) return true;
  if (PROTECTED_DIRS.some((dir) => hasSegments(path, [dir]))) return true;
  return PROTECTED_FILES.some((file) => path.endsWith(`/${file}`));
};

/**
 * @param {string} dir
 * @param {PathContext} ctx
 * @param {number} [limit]
 * @returns {string[]}
 */
export const findProtected = (dir, ctx, limit = Number.POSITIVE_INFINITY) => {
  const found = [];
  const pending = [dir];
  let seen = 0;
  while (pending.length > 0 && seen < WALK_LIMIT && found.length < limit) {
    const current = /** @type {string} */ (pending.pop());
    let entries;
    try {
      entries = readdirSync(onDisk(current, ctx), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
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

/** @param {string} path @param {PathContext} ctx */
const isDirectory = (path, ctx) => {
  try {
    return statSync(onDisk(path, ctx)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * @param {string} command
 */
export const tokenize = (command) => {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  /** @type {string | null} */
  let quote = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = '';
  };
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/[\s;&|<>()=`]/.test(char)) flush();
    else current += char;
  }
  flush();
  return tokens;
};

const RECURSIVE_SEARCH = /^(rg|ag|ack|grep|egrep|fgrep|find)$/;

/**
 * @param {string[]} tokens
 * @param {PathContext} ctx
 * @returns {string | null}
 */
const recursiveSearchHit = (tokens, ctx) => {
  const [first = ''] = tokens;
  const program = basename(first);
  if (!RECURSIVE_SEARCH.test(program)) return null;
  const grepLike = /^(grep|egrep|fgrep)$/.test(program);
  const flags = tokens.slice(1).filter((token) => token.startsWith('-'));
  const recursive =
    program === 'find' ||
    !grepLike ||
    flags.some((flag) => flag === '--recursive' || flag === '--dereference-recursive' || /^-[a-zA-Z]*[rR]/.test(flag));
  if (!recursive) return null;
  const operands = tokens.slice(1).filter((token) => !token.startsWith('-'));
  const paths = program === 'find' ? operands : operands.slice(1);
  const targets =
    paths.length === 0 ? [ctx.cwd] : paths.map((path) => expand(path, ctx)).filter((path) => isDirectory(path, ctx));
  return targets.find((target) => directoryHoldsProtected(target, ctx)) ?? null;
};

/**
 * @param {string} command
 * @param {PathContext} ctx
 * @returns {Verdict}
 */
const checkBash = (command, ctx) => {
  const tokens = tokenize(command);
  const named = tokens.find((token) => isProtectedPath(token, ctx));
  if (named) return { blocked: true, path: named, reason: `the command names the protected path ${named}` };
  const segments = command.split(/&&|\|\||;|\|/).map(tokenize);
  for (const segment of segments) {
    const hit = recursiveSearchHit(segment, ctx);
    if (hit) return { blocked: true, path: hit, reason: `a recursive search would read protected files under ${hit}` };
  }
  return { blocked: false };
};

const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern'];
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']);

/**
 * @param {ToolCall} call
 * @param {PathContext} ctx
 * @returns {Verdict}
 */
export const checkToolCall = (call, ctx) => {
  const input = call.tool_input ?? {};
  if (call.tool_name === 'Bash') return checkBash(String(input.command ?? ''), ctx);
  if (!FILE_TOOLS.has(call.tool_name)) return { blocked: false };
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || value === '') continue;
    if (isProtectedPath(value, ctx))
      return { blocked: true, path: value, reason: `${call.tool_name} targets the protected path ${value}` };
    const resolved = expand(value, ctx);
    if (field !== 'pattern' && isDirectory(resolved, ctx) && directoryHoldsProtected(resolved, ctx)) {
      return { blocked: true, path: value, reason: `${call.tool_name} would read protected files under ${value}` };
    }
  }
  return { blocked: false };
};
