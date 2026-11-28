import type { HeadTree, TreeEntry } from '../githost/host.ts';
import { isProtectedPath } from '../sandbox/protected-paths.mjs';
import type { CageShell } from './claude-code.ts';
import { AgentFailed } from './runtime.ts';

export const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];

/** Files an agent CLI obeys on start. A change under review must not be able to set them for its own reviewer. */
const AGENT_SETTINGS = /(^|\/)(\.claude(\/|$)|(claude|claude\.local|agents)\.md$|\.mcp\.json$)/i;

/** The rule the cage export applies, asked of the path and of each folder above it. */
const isCredential = (path: string): boolean =>
  path
    .split('/')
    .some((_, i, parts) => isProtectedPath(`/${parts.slice(0, i + 1).join('/')}`, { home: '/nonexistent', cwd: '/' }));

const GIT_TIMEOUT_MS = 120_000;

const records = (out: string): string[] => out.split('\0').filter(Boolean);

const entryOf = (record: string): TreeEntry & { type: string } => {
  const tab = record.indexOf('\t');
  const [mode = '', type = '', sha = ''] = record.slice(0, tab).split(' ');
  return { mode, type, sha, path: record.slice(tab + 1) };
};

const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean => a?.sha === b?.sha && a?.mode === b?.mode;

/**
 * Makes the cage's /work hold the files of `headSha`, as a local commit on the cage's export. The host's git
 * objects come in on stdin, so the cage needs no remote and no credential. Credential files are left out, and
 * agent settings stay as the export has them. Returns the paths that therefore differ from the head.
 */
export const checkoutHead = async (
  shell: CageShell,
  headSha: string,
  tree: HeadTree,
  signal: AbortSignal,
): Promise<string[]> => {
  const git = async (args: readonly string[], input?: string | Uint8Array): Promise<string> => {
    const ran = await shell.exec([...GIT, ...args], {
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(input === undefined ? {} : { input }),
    });
    if (ran.code !== 0) {
      const why = ran.timedOut ? 'ran past its time limit' : `failed: ${ran.err.trim()}`;
      throw new AgentFailed(`git ${args.join(' ')} in the cage ${why}, so ${headSha} is not checked out`);
    }
    return ran.out;
  };

  const exported = (await git(['rev-list', '--max-parents=0', 'HEAD'])).trim();
  const base = records(await git(['ls-tree', '-r', '-z', '--full-tree', exported])).map(entryOf);
  const baseAt = new Map(base.map((e) => [e.path, e]));
  const headAt = new Map(tree.entries.map((e) => [e.path, e]));

  const fromHead = tree.entries.filter((e) => !AGENT_SETTINGS.test(e.path) && !isCredential(e.path));
  const fromExport = base.filter((e) => e.type === 'blob' && AGENT_SETTINGS.test(e.path));
  const wanted = [...fromHead, ...fromExport];
  const notAtHead = [...new Set([...headAt.keys(), ...fromExport.map((e) => e.path)])].filter(
    (path) => isCredential(path) || (AGENT_SETTINGS.test(path) && !same(headAt.get(path), baseAt.get(path))),
  );

  const shas = [...new Set(wanted.map((e) => e.sha))];
  const known = await git(['cat-file', '--batch-check'], shas.map((sha) => `${sha}\n`).join(''));
  for (const line of known.split('\n')) {
    if (!line.endsWith(' missing')) continue;
    const sha = line.slice(0, -' missing'.length);
    const written = (await git(['hash-object', '-w', '--stdin', '--no-filters'], await tree.read(sha))).trim();
    if (written !== sha) throw new AgentFailed(`the host sent other bytes for blob ${sha} of ${headSha}`);
  }

  await git(['read-tree', '--empty']);
  await git(['update-index', '-z', '--index-info'], wanted.map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join(''));
  // git skips a path it will not write, such as `../x` or `.git/config`, and still exits 0.
  const indexed = new Set(records(await git(['ls-files', '-z'])));
  const refused = wanted.filter((e) => !indexed.has(e.path)).map((e) => e.path);
  if (refused.length > 0)
    throw new AgentFailed(`git will not check out ${JSON.stringify(refused.slice(0, 5))} of ${headSha}`);

  const written = (await git(['write-tree'])).trim();
  const commit = await git([
    '-c',
    'user.name=agent-works',
    '-c',
    'user.email=agent-works@localhost',
    'commit-tree',
    written,
    '-p',
    exported,
    '-m',
    `head ${headSha}`,
  ]);
  await git(['reset', '-q', '--hard', commit.trim()]);
  await git(['clean', '-qffdx', '-e', 'node_modules']);
  return notAtHead;
};
