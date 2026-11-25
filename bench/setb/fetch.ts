import { runBinary } from '../../server/sandbox/engine.ts';
import { TaskRefused } from '../model.ts';
import type { Entry } from './labels.ts';
import { ghReadCi, type PullFile, readPaths } from './outcome.ts';
import { type Ci, type Packet, packetOrUnreadable, type Unreadable } from './packet.ts';
import type { SetBTask } from './task.ts';

export interface PullView {
  readonly head: { readonly sha: string; readonly ref: string };
  readonly base: { readonly sha: string };
  readonly labels: readonly { readonly name: string }[];
}

export interface Hub {
  pull(repo: string, pr: number): Promise<PullView>;
  diff(repo: string, base: string, head: string): Promise<string>;
  ci(repo: string, sha: string): Promise<Ci>;
}

const gh = async (args: string[]): Promise<string> => {
  const ran = await runBinary('gh', ['api', '-X', 'GET', ...args], { timeoutMs: 120_000 });
  if (ran.code !== 0) throw new TaskRefused(`gh failed on ${args.at(-1)}: ${ran.err.trim().slice(-200)}`);
  return ran.out;
};

export const ghHub: Hub = {
  pull: async (repo, pr) => JSON.parse(await gh([`repos/${repo}/pulls/${pr}`])) as PullView,
  diff: (repo, base, head) =>
    gh(['-H', 'Accept: application/vnd.github.diff', `repos/${repo}/compare/${base}...${head}`]),
  ci: ghReadCi,
};

export const ghPullFiles = async (repo: string, pr: number): Promise<string[]> =>
  readPaths(
    async (n) =>
      JSON.parse(await gh([`repos/${repo}/pulls/${pr}/files?per_page=100&page=${n}`])) as readonly PullFile[],
  );

export const secretsOf = (pull: PullView): string[] => [
  pull.head.ref,
  ...(pull.head.ref.match(/t-[0-9a-f]{8}/g) ?? []),
  ...pull.labels.map((l) => l.name),
];

export const fetchPacket = async (
  hub: Hub,
  repo: string,
  entry: Entry,
  label: string,
  task: SetBTask,
): Promise<Packet | Unreadable> => {
  const ready = entry.readyHeadSha;
  const pull = await hub.pull(repo, entry.pr);
  const diff = await hub.diff(repo, pull.base.sha, ready);
  const ci = await hub.ci(repo, ready);
  return packetOrUnreadable(
    { label, headSha: ready, issue: { title: task.title, body: task.body }, diff, ci },
    secretsOf(pull),
  );
};
