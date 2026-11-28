import type { HeadTree, TreeEntry } from '../githost/host.ts';
import { isProtectedPath } from '../sandbox/protected-paths.mjs';
import type { CageShell } from './claude-code.ts';
import { AgentFailed, AgentRefused } from './runtime.ts';

export const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];

/** Files an agent CLI obeys on start. A change under review must not be able to set them for its own reviewer. */
const AGENT_SETTINGS = /(^|\/)(\.claude(\/|$)|(claude|claude\.local|agents)\.md$|\.mcp\.json$)/i;

/** The rule the cage export applies, asked of the path and of each folder above it. */
const isCredential = (path: string): boolean =>
  path
    .split('/')
    .some((_, i, parts) => isProtectedPath(`/${parts.slice(0, i + 1).join('/')}`, { home: '/nonexistent', cwd: '/' }));

const GIT_TIMEOUT_MS = 120_000;

/** Each blob the cage lacks is one request on the host account, and the cage's disk is the host's. */
export const MAX_BLOBS = 300;
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;

/** Nothing a cage or its home configures may change what HQ's git writes, or where. */
const checkoutGit = (args: readonly string[], index?: string): string[] => [
  'env',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_CONFIG_GLOBAL=/dev/null',
  ...(index === undefined ? [] : [`GIT_INDEX_FILE=${index}`]),
  ...GIT,
  '-c',
  'core.symlinks=false',
  '--git-dir=.git',
  '--work-tree=.',
  ...args,
];

/** Outranks the head's own .gitattributes, so a file in /work is byte for byte its blob and no filter runs. */
const RAW_BYTES = '* -text -ident -filter !working-tree-encoding\n';

const records = (out: string): string[] => out.split('\0').filter(Boolean);

const entryOf = (record: string): TreeEntry & { type: string } => {
  const tab = record.indexOf('\t');
  const [mode = '', type = '', sha = ''] = record.slice(0, tab).split(' ');
  return { mode, type, sha, path: record.slice(tab + 1) };
};

const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean => a?.sha === b?.sha && a?.mode === b?.mode;

/**
 * Makes /work hold the files of `headSha`, as a local commit on the cage's export. It trusts the repository in /work,
 * so the caller passes a shell whose cage is fresh. The host's git objects come in on stdin, so the cage needs no
 * remote and no credential. Credential files are left out, agent settings stay as the export has them, and a symbolic
 * link is a plain file holding its target, so no read of it leaves /work. Returns the paths that differ from the head.
 */
export const checkoutHead = async (
  shell: CageShell,
  headSha: string,
  tree: HeadTree,
  signal: AbortSignal,
): Promise<string[]> => {
  const run = async (what: string, argv: readonly string[], input?: string | Uint8Array): Promise<string> => {
    const ran = await shell.exec(argv, {
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(input === undefined ? {} : { input }),
    });
    if (ran.code !== 0) {
      const why = ran.timedOut ? 'ran past its time limit' : `failed: ${ran.err.trim()}`;
      throw new AgentFailed(`${what} in the cage ${why}, so ${headSha} is not checked out`);
    }
    return ran.out;
  };
  const git = (args: readonly string[], input?: string | Uint8Array, index?: string): Promise<string> =>
    run(`git ${args.join(' ')}`, checkoutGit(args, index), input);

  const exported = (await git(['rev-parse', 'HEAD'])).trim();
  await run('writing .git/info/attributes', ['tee', '.git/info/attributes'], RAW_BYTES);
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
  const missing = known
    .split('\n')
    .filter((line) => line.endsWith(' missing'))
    .map((line) => line.slice(0, -' missing'.length));
  const refuse = (why: string): never => {
    throw new AgentRefused(
      `${headSha} is not reviewed: ${why}. Bring the \`source\` clone up to date, or review this change by hand`,
    );
  };
  if (missing.length > MAX_BLOBS)
    refuse(`${missing.length} of its files are not in the cage's export, and HQ reads at most ${MAX_BLOBS}`);
  let bytes = 0;
  for (const sha of missing) {
    const blob = await tree.read(sha);
    bytes += blob.length;
    if (bytes > MAX_BLOB_BYTES)
      refuse(`its files that are not in the cage's export pass ${MAX_BLOB_BYTES} bytes in total`);
    const written = (await git(['hash-object', '-w', '--stdin', '--no-filters'], blob)).trim();
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
  await git(['clean', '-qffdx']);

  // An exit code of 0 does not show the files are there. Index the working tree again and compare.
  const check = '.git/agent-works-check';
  await git(['read-tree', written], undefined, check);
  await git(['add', '-A', '-f'], undefined, check);
  if ((await git(['write-tree'], undefined, check)).trim() !== written)
    throw new AgentFailed(`the files in the cage are not those of ${headSha} after the checkout`);
  return notAtHead;
};
