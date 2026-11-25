// Checks the pinned Set B base against the frozen task list. Read-only: it never calls a model and writes nothing outside
// a scratch directory. For each task it
//   1. lists the task's test files and the relative-import closure of those files, and says whether any blob differs
//      between the freeze commit and the pinned base;
//   2. says whether the task's source files differ between the two commits;
//   3. runs the task's test command in a scratch worktree of each commit and compares the exit codes and counts.
// A task whose test file or source files moved, or whose test result differs between the two commits, is reported as DROP.
// Modules in the import closure that moved are listed under `moved` and are judged by the test result.
//
//   node bench/setb/verify-base.ts [--base <sha>] [--frozen <sha>] [--only id,id] [--no-run]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: '56db6a1e227ca3b46a15d6ac1f1c2794daea042d' },
    frozen: { type: 'string' },
    only: { type: 'string' },
    'no-run': { type: 'boolean', default: false },
  },
});
const list = JSON.parse(readFileSync(join(ROOT, 'bench/setb/tasks.json'), 'utf8')) as {
  frozenAtSha: string;
  tasks: Array<{ id: string; check: string; files: string[]; testCommand: string[] }>;
};
const frozen = values.frozen ?? list.frozenAtSha;
const only = values.only === undefined ? null : new Set(values.only.split(','));

const git = (...args: string[]) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
const blob = (sha: string, path: string): string | null => {
  const r = git('rev-parse', '--verify', '--quiet', `${sha}:${path}`);
  return r.status === 0 ? r.stdout.trim() : null;
};
const show = (sha: string, path: string): string | null => {
  const r = git('show', `${sha}:${path}`);
  return r.status === 0 ? r.stdout : null;
};

const IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const resolveAt = (sha: string, from: string, spec: string): string | null => {
  const target = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const cand of [target, `${target}.ts`, `${target}.mjs`, `${target}.js`, `${target}/index.ts`])
    if (blob(sha, cand) !== null) return cand;
  return null;
};
const closureOf = (sha: string, entries: string[]): string[] => {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const text = show(sha, file);
    if (text === null) continue;
    seen.add(file);
    for (const m of text.matchAll(IMPORT)) {
      const next = resolveAt(sha, file, m[1] as string);
      if (next !== null) queue.push(next);
    }
  }
  return [...seen].sort();
};

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'setb-verify-'));
const worktrees = new Map<string, string>();
const tree = (sha: string): string => {
  const known = worktrees.get(sha);
  if (known !== undefined) return known;
  const dir = join(scratch, sha.slice(0, 7));
  const added = git('worktree', 'add', '--detach', dir, sha);
  if (added.status !== 0) throw new Error(`worktree ${sha}: ${added.stderr}`);
  const installed = spawnSync('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: dir, encoding: 'utf8' });
  if (installed.status !== 0)
    throw new Error(`install at ${sha}: ${(installed.stderr || installed.stdout).slice(-300)}`);
  worktrees.set(sha, dir);
  return dir;
};
const run = (sha: string, command: string[]) => {
  const dir = tree(sha);
  const r = spawnSync(command[0] as string, [...command.slice(1), '--reporter=json'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    timeout: 600_000,
  });
  let counts: { total: number; passed: number; failed: number } | null = null;
  try {
    const j = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{')));
    counts = { total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests };
  } catch {}
  return { code: r.status, counts };
};

interface Row {
  id: string;
  check: string;
  tests: string[];
  closure: number;
  moved: string[];
  sourcesMoved: string[];
  atFrozen?: ReturnType<typeof run>;
  atBase?: ReturnType<typeof run>;
  sameResult?: boolean;
  verdict?: 'KEEP' | 'DROP';
}
const rows: Row[] = [];
try {
  for (const task of list.tasks) {
    if (only !== null && !only.has(task.id)) continue;
    const tests = task.testCommand.filter((a) => /\.test\.(ts|mjs|js)$/.test(a));
    const closure = closureOf(frozen, tests);
    const moved = closure.filter((f) => blob(frozen, f) !== blob(values.base, f));
    const sources = task.files.filter((f) => blob(frozen, f) !== blob(values.base, f));
    const row: Row = { id: task.id, check: task.check, tests, closure: closure.length, moved, sourcesMoved: sources };
    if (!values['no-run']) {
      row.atFrozen = run(frozen, task.testCommand);
      row.atBase = run(values.base, task.testCommand);
      row.sameResult = JSON.stringify(row.atFrozen) === JSON.stringify(row.atBase);
    }
    const entriesMoved = tests.filter((f) => blob(frozen, f) !== blob(values.base, f));
    // A moved module in the closure is reported, and decides nothing by itself: the test result at both commits does.
    row.verdict = entriesMoved.length === 0 && sources.length === 0 && (row.sameResult ?? true) ? 'KEEP' : 'DROP';
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  for (const dir of worktrees.values()) git('worktree', 'remove', '--force', dir);
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
}
const dropped = rows.filter((r) => r.verdict !== 'KEEP');
console.log(`${rows.length - dropped.length} keep, ${dropped.length} drop: ${dropped.map((r) => r.id).join(', ')}`);
process.exit(dropped.length === 0 ? 0 : 1);
