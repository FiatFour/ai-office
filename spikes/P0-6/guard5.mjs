import { execFileSync } from 'node:child_process';
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
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.github\/actions\/.+\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.yml$/,
  /^azure-pipelines\.ya?ml$/,
  /^Jenkinsfile$/,
  /^\.buildkite\/.+/,
];

const CI_SECRET_STEP = [
  /\$\{\{\s*secrets\./i,
  /toJSON\(\s*secrets\s*\)/i,
  /\bprintenv\b/,
  /(^|[\s;&|])env\s*($|[|;&>])/,
  /\/proc\/[^\s/]+\/environ/,
  /\bset\s*\|/,
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

/** @param {string} raw */
const unquote = (raw) => (raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);

/**
 * Reads the added lines of every file in a unified diff. A deleted file has no `+++ b/` line and yields nothing.
 * @param {string} text
 * @returns {FileDiff[]}
 */
export const parseDiff = (text) => {
  /** @type {FileDiff[]} */
  const files = [];
  /** @type {FileDiff | null} */
  let current = null;
  let line = 0;
  for (const row of text.split('\n')) {
    if (row.startsWith('diff --git ')) {
      current = null;
    } else if (row.startsWith('+++ ')) {
      const target = unquote(row.slice(4));
      current = target.startsWith('b/') ? { path: target.slice(2), added: [] } : null;
      if (current) files.push(current);
    } else if (row.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(row)?.[1] ?? 1) - 1;
    } else if (current && row.startsWith('+')) {
      line += 1;
      current.added.push({ line, text: row.slice(1) });
    } else if (current && !row.startsWith('-')) {
      line += 1;
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

/** @param {string[]} args */
const git = (args) =>
  execFileSync('git', [...HARDENED_ARGS, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...HARDENED_ENV, PATH: process.env.PATH ?? '' },
  });

const DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv'];

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

/** @param {PushUpdate} update */
const pushedDiff = ({ localSha, remoteSha }) => {
  if (ZERO_SHA.test(localSha)) return '';
  const range = ZERO_SHA.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
  return git(['log', '-p', '--format=', '-m', ...DIFF_FLAGS, ...range]);
};

async function main() {
  const { positionals, values } = parseArgs({
    options: { base: { type: 'string', default: 'main' } },
    allowPositionals: true,
    strict: false,
  });
  const [hook] = positionals;
  const base = String(values.base).split(',').filter(Boolean);
  if (hook === 'pre-commit') {
    const diff = git(['diff', '--cached', '--diff-filter=ACMR', ...DIFF_FLAGS]);
    process.exitCode = report(scanDiff(diff)) ? 1 : 0;
    return;
  }
  if (hook === 'pre-push') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const updates = parsePushLines(Buffer.concat(chunks).toString('utf8'));
    const verdict = checkPush(updates, base);
    for (const reason of verdict.reasons) console.error(`layer 5 refuses: ${reason}`);
    const blocked = updates.some((update) => report(scanDiff(pushedDiff(update))));
    process.exitCode = verdict.refused || blocked ? 1 : 0;
    return;
  }
  throw new Error('usage: guard5.mjs pre-commit|pre-push [--base main,develop]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
