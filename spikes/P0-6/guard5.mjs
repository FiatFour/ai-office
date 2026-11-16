import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { HARDENED_ARGS, HARDENED_ENV } from '../P0-3/git-scan.mjs';
import { isProtectedPath } from '../P0-3/protected-paths.mjs';

/**
 * @typedef {'protected-file' | 'secret' | 'ci-secret-step' | 'ci-file-changed'} Rule
 * @typedef {{ rule: Rule, path: string, line: number | null, blocks: boolean, detail: string }} Finding
 * @typedef {{ path: string, added: { line: number, text: string }[] }} FileDiff
 * @typedef {{ localRef: string, localSha: string, remoteRef: string, remoteSha: string }} PushUpdate
 */

const NO_CTX = { home: '/nonexistent', cwd: '/' };
const ZERO_SHA = /^0+$/;

const CI_PATHS = [
  /^\.github\/(workflows|actions)\/.+/,
  /^\.github\/(CODEOWNERS|dependabot\.ya?ml)$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.gitlab\/.+/,
  /^\.circleci\/.+/,
  /^azure-pipelines\.ya?ml$/,
  /(^|\/)Jenkinsfile[^/]*$/,
  /^\.buildkite\/.+/,
];

const SECRET_NAME = '[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)';
const CI_SECRET_STEP = [
  /\bsecrets\s*(?:\.\s*[A-Za-z_*]|\[)/i,
  /toJSON\(\s*secrets\s*\)/i,
  /\bgithub\.token\b/,
  /\bprintenv\b/,
  /(^|[\s;&|])env\s*($|[|;&>])/,
  /\bexport\s+-p\b/,
  /\bdeclare\s+-[a-zA-Z]*x/,
  /\/proc\/[^\s/]+\/environ/,
  /\bset\s*\|/,
  new RegExp(String.raw`\$\{?${SECRET_NAME}\}?[^\n#]*\|\s*(?:base64|curl|wget|nc|openssl)\b`),
  /\bpull_request_target\b/,
  /\bpermissions\s*:\s*write-all\b/,
  /\$\{\{[^}]*\bgithub\.(?:head_ref|event\.[\w.[\]*]*\.(?:title|body|message|ref|label|name|email))\b/,
];

const SECRET_PATTERNS = [
  { name: 'aws access key id', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: 'private key block', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { name: 'slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    name: 'credential assignment',
    pattern: /\b(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key)\w*\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
];

const C_ESCAPES = /** @type {Record<string, string>} */ ({ t: '\t', n: '\n', '"': '"', '\\': '\\' });

/** @param {string} quoted a path git wrote between double quotes, with C escapes and octal bytes */
const cUnquote = (quoted) => {
  /** @type {number[]} */
  const bytes = [];
  const inner = quoted.slice(1, -1);
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner[at] ?? '';
    const octal = /^[0-7]{3}/.exec(inner.slice(at + 1));
    if (char !== '\\') bytes.push(...Buffer.from(char));
    else if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      at += 3;
    } else {
      bytes.push(...Buffer.from(C_ESCAPES[inner[at + 1] ?? ''] ?? inner[at + 1] ?? ''));
      at += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

/** @param {string} raw */
const unquote = (raw) => (raw.startsWith('"') ? cUnquote(raw) : raw);

/**
 * The path a `diff --git` header names for the new side. A header with two equal halves names that path, one with
 * different halves is a rename and names the second.
 * @param {string} header
 */
const headerPath = (header) => {
  const rest = header.slice('diff --git '.length);
  const quoted = [...rest.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((match) => match[0]);
  if (quoted.length > 0) {
    const last = unquote(quoted[quoted.length - 1] ?? '');
    return last.startsWith('b/') ? last.slice(2) : '';
  }
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && rest.slice(2, 2 + half) === rest.slice(rest.length - half)) {
    return rest.slice(2, 2 + half);
  }
  const at = rest.lastIndexOf(' b/');
  return at < 0 ? '' : rest.slice(at + 3);
};

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Reads the added lines of every file in a unified diff. A file is opened by its `diff --git` header and a hunk body is
 * consumed by the line counts in its `@@` header, so an added line that looks like a file header (`++ b/README.md`
 * after the diff's own `+`) stays content of the file it is in. A deleted file yields nothing.
 * @param {string} text
 * @returns {FileDiff[]}
 */
export const parseDiff = (text) => {
  /** @type {FileDiff[]} */
  const files = [];
  /** @type {FileDiff | null} */
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  for (const row of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (row.startsWith('\\')) continue;
      if (row.startsWith('+')) {
        newLeft -= 1;
        line += 1;
        current?.added.push({ line, text: row.slice(1) });
      } else if (row.startsWith('-')) {
        oldLeft -= 1;
      } else {
        oldLeft -= 1;
        newLeft -= 1;
        line += 1;
      }
      continue;
    }
    if (row.startsWith('diff --git ')) {
      const path = headerPath(row);
      current = path === '' ? null : { path, added: [] };
      if (current) files.push(current);
    } else if (
      current &&
      (row === 'deleted file mode' || row.startsWith('deleted file mode ') || row === '+++ /dev/null')
    ) {
      files.pop();
      current = null;
    } else if (current) {
      const hunk = HUNK.exec(row);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
        line = Number(hunk[2]) - 1;
      }
    }
  }
  return files;
};

/**
 * The layer 5 scan over a diff: a protected file that is added, a gitleaks-style secret in an added line, a CI file that
 * changes (review) and an added CI line that prints or ships secrets (blocks). It matches text on the diff and nothing
 * more, so a secret split across literals, or a secret step hidden in a script the workflow only calls, is outside it.
 * @param {string} diffText
 * @returns {Finding[]}
 */
export const scanDiff = (diffText) => {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of parseDiff(diffText)) {
    if (isProtectedPath(file.path, NO_CTX)) {
      findings.push({
        rule: 'protected-file',
        path: file.path,
        line: null,
        blocks: true,
        detail: 'a protected path is added',
      });
    }
    const isCi = CI_PATHS.some((pattern) => pattern.test(file.path));
    if (isCi) {
      findings.push({
        rule: 'ci-file-changed',
        path: file.path,
        line: null,
        blocks: false,
        detail: 'a CI file changes, a human reviews it',
      });
    }
    for (const { line, text } of file.added) {
      const secret = SECRET_PATTERNS.find(({ pattern }) => pattern.test(text));
      if (secret) {
        findings.push({ rule: 'secret', path: file.path, line, blocks: true, detail: secret.name });
      }
      if (isCi && CI_SECRET_STEP.some((pattern) => pattern.test(text))) {
        findings.push({
          rule: 'ci-secret-step',
          path: file.path,
          line,
          blocks: true,
          detail: 'an added CI line reads or prints secrets or the environment',
        });
      }
    }
  }
  return findings;
};

/**
 * @param {PushUpdate[]} updates
 * @param {string[]} baseBranches
 * @returns {{ refused: boolean, reasons: string[] }}
 */
export const checkPush = (updates, baseBranches) => {
  const protectedRefs = new Set(baseBranches.map((branch) => `refs/heads/${branch}`));
  const reasons = updates
    .filter((update) => protectedRefs.has(update.remoteRef))
    .map((update) =>
      ZERO_SHA.test(update.localSha)
        ? `deleting ${update.remoteRef} is refused`
        : `pushing to ${update.remoteRef} is refused, open a PR from the factory branch`,
    );
  return { refused: reasons.length > 0, reasons };
};

/** @param {string} text */
const shellQuote = (text) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * @param {'pre-commit' | 'pre-push'} name
 * @param {{ guard: string, base: string[] }} options
 */
export const hookScript = (name, { guard, base }) =>
  `#!/bin/sh\nexec node ${shellQuote(guard)} ${name} --base ${shellQuote(base.join(','))} "$@"\n`;

const LOCATION_VARS = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE'];

/** @param {string} path a path whose last component may not exist yet */
const realish = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return join(realpathSync(dirname(path)), basename(path));
  }
};

/**
 * Of the variables git sets for a commit that builds its own index (`commit -a`, `commit <path>`), the ones that may
 * reach the guard's git: a path counts only when it resolves, symlinks followed, inside one of `roots`. A variable the
 * agent pointed elsewhere is refused, not dropped, so the guard never scans a different index than the commit uses.
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @param {string[]} roots
 * @returns {{ allowed: Record<string, string>, refused: string[] }}
 */
export const locationEnv = (env, cwd, roots) => {
  /** @type {Record<string, string>} */
  const allowed = {};
  /** @type {string[]} */
  const refused = [];
  for (const name of LOCATION_VARS) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    let resolved = '';
    try {
      resolved = realish(resolve(cwd, value));
    } catch {}
    const inside = roots.some((root) => {
      const path = relative(root, resolved);
      return resolved !== '' && !path.startsWith('..') && !isAbsolute(path);
    });
    if (inside) allowed[name] = resolved;
    else refused.push(name);
  }
  return { allowed, refused };
};

/**
 * The only way the guard runs git: P0-3's hardened flags and environment, in `cwd`. `location` is what `locationEnv`
 * let through.
 * @param {string} [cwd]
 * @returns {(args: string[], location?: Record<string, string>) => string}
 */
export const hardenedGit =
  (cwd = process.cwd()) =>
  (args, location = {}) =>
    execFileSync('git', [...HARDENED_ARGS, '-c', 'core.quotePath=true', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...HARDENED_ENV, ...location, PATH: process.env.PATH ?? '' },
    });

/**
 * Every flag that fixes a diff setting the repository's own config could change: the `a/` and `b/` header prefixes
 * (`diff.noprefix`, `diff.srcPrefix`, `diff.dstPrefix`, `diff.mnemonicPrefix`), rename and copy detection, context size,
 * the algorithm, paths relative to the cwd and the file order. Header parsing and the line scan read one fixed format.
 */
const DIFF_FLAGS = [
  '-U0',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--diff-algorithm=myers',
  '-O/dev/null',
];

/** @param {Finding[]} findings */
const report = (findings) => {
  for (const finding of findings) {
    const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    console.error(`layer 5 ${finding.blocks ? 'refuses' : 'flags'} ${finding.rule} at ${where}: ${finding.detail}`);
  }
  return findings.some((finding) => finding.blocks);
};

/** @param {string} stdin @returns {PushUpdate[]} */
const parsePushLines = (stdin) =>
  stdin
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = row.split(' ');
      return { localRef, localSha, remoteRef, remoteSha };
    });

/** @param {PushUpdate} update @param {ReturnType<typeof hardenedGit>} git */
const pushedDiff = ({ localSha, remoteSha }, git) => {
  if (ZERO_SHA.test(localSha)) return '';
  const range = ZERO_SHA.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
  return git(['log', '-p', '--format=', '-m', ...DIFF_FLAGS, ...range]);
};

/**
 * What the pre-commit hook scans: the index this commit will record. `git` is the runner, the hardened one unless a
 * replay mutation swaps it.
 * @param {ReturnType<typeof hardenedGit>} git
 * @param {Record<string, string>} [location]
 */
export const scanStaged = (git, location = {}) =>
  scanDiff(git(['diff', '--cached', '--diff-filter=ACMR', ...DIFF_FLAGS], location));

async function main() {
  const { positionals, values } = parseArgs({
    options: { base: { type: 'string', default: 'main' } },
    allowPositionals: true,
    strict: false,
  });
  const [hook] = positionals;
  const base = String(values.base).split(',').filter(Boolean);
  if (hook === 'pre-commit') {
    const git = hardenedGit();
    const gitDir = realpathSync(git(['rev-parse', '--absolute-git-dir']).trim());
    const { allowed, refused } = locationEnv(process.env, process.cwd(), [realpathSync(process.cwd()), gitDir]);
    for (const name of refused) console.error(`layer 5 refuses: ${name} points outside this repository`);
    if (refused.length > 0) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = report(scanStaged(git, allowed)) ? 1 : 0;
    return;
  }
  if (hook === 'pre-push') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const updates = parsePushLines(Buffer.concat(chunks).toString('utf8'));
    const verdict = checkPush(updates, base);
    for (const reason of verdict.reasons) console.error(`layer 5 refuses: ${reason}`);
    const git = hardenedGit();
    const blocked = updates.some((update) => report(scanDiff(pushedDiff(update, git))));
    process.exitCode = verdict.refused || blocked ? 1 : 0;
    return;
  }
  throw new Error('usage: guard5.mjs pre-commit|pre-push [--base main,develop]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
