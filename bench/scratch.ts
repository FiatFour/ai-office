import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime } from '../server/agents/runtime.ts';
import { github } from '../server/githost/github.ts';
import type { ApiCall, GitHost, HttpRequest, HttpResponse, Transport } from '../server/githost/host.ts';
import { cagesMode } from '../server/modes/cages.ts';
import { runBinary } from '../server/sandbox/engine.ts';
import { type FactoryEnv, removedVia } from './arms-live.ts';
import { TaskRefused } from './model.ts';
import type { Prepared } from './workspace.ts';

export const SCRATCH_REPO = 'FiatFour/agent-works-scratch';
export const AUTHOR = 'nova';
export const REVIEWER = 'vega';

const BASE_REF = /^bench-base\/t-[0-9a-f]{8}$/;
const WORK_REF = /^aw\/bench\/t-[0-9a-f]{8}$/;
const SCRATCH_NAME = /^[\w-][\w.-]*\/[\w.-]*-scratch$/;

export interface ScratchNames {
  readonly base: string;
  readonly work: string;
}

export const namesOf = (ticketId: string): ScratchNames => ({
  base: `bench-base/${ticketId.split('/').at(-1) ?? ''}`,
  work: `aw/${ticketId}`,
});

export const scratchRepoProblem = (repo: string): string | null =>
  SCRATCH_NAME.test(repo) ? null : `${repo} is not a scratch repo: its name must end in -scratch`;

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_TERMINAL_PROMPT: '0',
  ...(process.env.SSH_AUTH_SOCK === undefined ? {} : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
  ...(process.env.GIT_SSH_COMMAND === undefined ? {} : { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND }),
};

const git = (cwd: string, args: readonly string[]) =>
  runBinary('git', ['-C', cwd, ...args], { env: GIT_ENV, timeoutMs: 180_000 });

const must = async (cwd: string, args: readonly string[]): Promise<string> => {
  const ran = await git(cwd, args);
  if (ran.code !== 0) throw new TaskRefused(`git ${args.join(' ')} failed: ${(ran.err || ran.out).trim().slice(-300)}`);
  return ran.out;
};

const refProblem = (pattern: RegExp, ref: string): void => {
  if (!pattern.test(ref)) throw new TaskRefused(`${ref} is not a ref the bench may write on the scratch host`);
};

export interface Seed {
  readonly branch: string;
  readonly sha: string;
  readonly files: number;
}

export const seedBase = async (source: string, remote: string, branch: string, workRoot: string): Promise<Seed> => {
  refProblem(BASE_REF, branch);
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'seed-'));
  try {
    const tar = await runBinary('sh', ['-c', 'git -C "$0" archive --format=tar HEAD | tar -x -C "$1"', source, dir]);
    if (tar.code !== 0) throw new TaskRefused(`archive of ${source} failed: ${tar.err.trim()}`);
    rmSync(join(dir, '.github'), { recursive: true, force: true });
    await must(dir, ['init', '--quiet', '-b', 'main']);
    await must(dir, ['add', '-A']);
    const tracked = (await must(dir, ['ls-files', '-z'])).split('\0').filter(Boolean);
    if (tracked.some((path) => path === '.github' || path.startsWith('.github/')))
      throw new TaskRefused('the seeded tree still holds .github, which could start Actions on the scratch repo');
    await must(dir, [
      '-c',
      'user.name=agent-works-bench',
      '-c',
      'user.email=bench@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'task base',
    ]);
    const sha = (await must(dir, ['rev-parse', 'HEAD'])).trim();
    await must(dir, ['push', '--quiet', '--force', remote, `HEAD:refs/heads/${branch}`]);
    const seen = (await must(dir, ['ls-remote', remote, `refs/heads/${branch}`])).split('\t')[0];
    if (seen !== sha) throw new TaskRefused(`the scratch host holds ${seen ?? 'nothing'} on ${branch}, not ${sha}`);
    return { branch, sha, files: tracked.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const dropBase = async (remote: string, branch: string, workRoot: string): Promise<void> => {
  refProblem(BASE_REF, branch);
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'drop-'));
  try {
    await must(dir, ['init', '--quiet']);
    const present = (await must(dir, ['ls-remote', remote, `refs/heads/${branch}`])).trim() !== '';
    if (present) await must(dir, ['push', '--quiet', remote, '--delete', `refs/heads/${branch}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const cleanupProblem = (request: HttpRequest, repo: string): string | null => {
  const home = `/repos/${repo}`;
  if (!request.path.startsWith(`${home}/`)) return 'it names another repository';
  const tail = request.path.slice(home.length);
  if (request.method === 'GET') return null;
  if (request.method === 'PATCH' && /^\/pulls\/\d+$/.test(tail))
    return JSON.stringify(request.body) === '{"state":"closed"}' ? null : 'a PR is only ever closed';
  const ref = /^\/git\/refs\/heads\/(.+)$/.exec(tail)?.[1];
  if (request.method === 'DELETE' && ref !== undefined && WORK_REF.test(ref)) return null;
  return 'it is not a GET, a PR close or a delete of a bench work branch';
};

export const guardedCleanup =
  (send: Transport, repo: string): Transport =>
  async (request) => {
    const problem = cleanupProblem(request, repo);
    if (problem !== null)
      throw new TaskRefused(`refusing ${request.method} ${request.path} on the scratch host: ${problem}`);
    return send(request);
  };

const expect2xx = (what: string, response: HttpResponse, tolerated: readonly number[] = []): void => {
  if (response.status >= 400 && !tolerated.includes(response.status))
    throw new TaskRefused(`${what} failed with status ${response.status}`);
};

export const dropWork = async (host: GitHost, send: Transport, repo: string, branch: string): Promise<number> => {
  refProblem(WORK_REF, branch);
  const sender = guardedCleanup(send, repo);
  let closed = 0;
  for (
    let change = await host.findChange(repo, branch);
    change !== null;
    change = await host.findChange(repo, branch)
  ) {
    if (closed >= 20) throw new TaskRefused(`${repo} keeps open PRs on ${branch}`);
    expect2xx(
      `closing ${repo}#${change.number}`,
      await sender({ method: 'PATCH', path: `/repos/${repo}/pulls/${change.number}`, body: { state: 'closed' } }),
    );
    closed += 1;
  }
  expect2xx(
    `deleting ${branch}`,
    await sender({ method: 'DELETE', path: `/repos/${repo}/git/refs/heads/${branch}` }),
    [404, 422],
  );
  return closed;
};

export const failFast = (
  runtimes: Readonly<Record<string, AgentRuntime>>,
): { workers: Record<string, AgentRuntime>; failure: () => string | null } => {
  let failure: string | null = null;
  const watch = (runtime: AgentRuntime): AgentRuntime => ({
    ...runtime,
    async run(job) {
      if (failure !== null) throw new Error(`an earlier session failed: ${failure}`);
      try {
        return await runtime.run(job);
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  });
  return {
    workers: Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, watch(runtime)])),
    failure: () => failure,
  };
};

export interface ScratchOptions {
  readonly repo: string;
  readonly remote: string;
  readonly send: Transport;
  readonly log: (call: ApiCall) => void;
  readonly workers: (prepared: Prepared) => Readonly<Record<string, AgentRuntime>>;
  readonly workRoot: string;
  readonly keep?: boolean;
  readonly pollMs?: number;
  readonly settleMs?: number;
  readonly reviewPollMs?: number;
}

export const scratchEnv = (o: ScratchOptions): FactoryEnv => {
  const problem = scratchRepoProblem(o.repo);
  if (problem !== null) throw new TaskRefused(problem);
  return {
    ...(o.reviewPollMs === undefined ? {} : { reviewPollMs: o.reviewPollMs }),
    async open(_task, ticket, prepared) {
      const names = namesOf(ticket.id);
      const host = github({ repo: o.repo, base: names.base, send: o.send, log: o.log });
      const clear = async () => {
        await dropWork(host, o.send, o.repo, names.work);
        await dropBase(o.remote, names.base, o.workRoot);
      };
      await clear();
      await seedBase(prepared.source, o.remote, names.base, o.workRoot);
      const home = mkdtempSync(join(o.workRoot, 'hq-'));
      const crew = failFast(o.workers(prepared));
      return {
        failure: crew.failure,
        host,
        repo: o.repo,
        base: names.base,
        home,
        reviewer: REVIEWER,
        mode: cagesMode({
          host,
          repo: o.repo,
          base: names.base,
          tickets: { [ticket.id]: ticket },
          author: AUTHOR,
          reviewer: REVIEWER,
          workers: crew.workers,
          pollMs: o.pollMs ?? 10_000,
          ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
        }),
        removed: (change) => removedVia(o.send, o.repo, change.number),
        close: async () => {
          rmSync(home, { recursive: true, force: true });
          if (o.keep !== true) await clear();
        },
      };
    },
  };
};
