import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AgentRuntime } from '../server/agents/runtime.ts';
import { github } from '../server/githost/github.ts';
import {
  type ApiCall,
  type GitHost,
  type HttpRequest,
  type HttpResponse,
  type Transport,
  WriteRefused,
} from '../server/githost/host.ts';
import { cagesMode } from '../server/modes/cages.ts';
import { runBinary } from '../server/sandbox/engine.ts';
import { type FactoryEnv, type Failure, removedVia } from './arms-live.ts';
import { TaskRefused } from './model.ts';
import type { Prepared } from './workspace.ts';

export const SCRATCH_REPO = 'FiatFour/agent-works-scratch';
export const AUTHOR = 'nova';
export const REVIEWER = 'vega';

const BASE_REF = /^bench-base\/t-[0-9a-f]{8}-r[1-9]\d{0,2}$/;
const WORK_REF = /^aw\/bench\/t-[0-9a-f]{8}-r[1-9]\d{0,2}$/;
const SCRATCH_NAME = /^[\w-][\w.-]*\/[\w.-]*-scratch$/;
const GITHUB_REMOTE =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w-]+\/[\w.-]+?)(?:\.git)?$/;

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

const isBareRepo = (path: string): boolean =>
  existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects')) && !existsSync(join(path, '.git'));

export const remoteProblem = (repo: string, remote: string): string | null => {
  if (isAbsolute(remote))
    return isBareRepo(remote) ? null : `${remote} is a local path, and a local remote must be a bare repository`;
  const named = GITHUB_REMOTE.exec(remote)?.[1];
  if (named === undefined) return `${remote} is neither a github.com URL of ${repo} nor a bare repository path`;
  return named.toLowerCase() === repo.toLowerCase() ? null : `the remote names ${named}, not ${repo}`;
};

export class ScratchTarget {
  readonly repo: string;
  readonly remote: string;

  private constructor(repo: string, remote: string) {
    this.repo = repo;
    this.remote = remote;
  }

  static of(repo: string, remote: string = `git@github.com:${repo}.git`): ScratchTarget {
    const problem = scratchRepoProblem(repo) ?? remoteProblem(repo, remote);
    if (problem !== null) throw new TaskRefused(problem);
    return new ScratchTarget(repo, remote);
  }
}

export const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  ...(process.env.SSH_AUTH_SOCK === undefined ? {} : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
  ...(process.env.GIT_SSH_COMMAND === undefined ? {} : { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND }),
});

const git = (cwd: string, args: readonly string[]) =>
  runBinary('git', ['-C', cwd, ...args], { env: gitEnv(), timeoutMs: 180_000 });

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

const treeOf = async (dir: string): Promise<Map<string, string>> => {
  const listed = (await must(dir, ['ls-tree', '-r', '-z', 'HEAD'])).split('\0').filter(Boolean);
  return new Map(
    listed.map((entry) => {
      const [meta = '', path = ''] = entry.split('\t');
      return [path, meta];
    }),
  );
};

const underGithub = (path: string): boolean => path === '.github' || path.startsWith('.github/');

export const seedBase = async (
  source: string,
  target: ScratchTarget,
  branch: string,
  workRoot: string,
): Promise<Seed> => {
  refProblem(BASE_REF, branch);
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'seed-'));
  try {
    const tar = await runBinary('sh', ['-c', 'git -C "$0" archive --format=tar HEAD | tar -x -C "$1"', source, dir], {
      env: gitEnv(),
    });
    if (tar.code !== 0) throw new TaskRefused(`archive of ${source} failed: ${tar.err.trim()}`);
    rmSync(join(dir, '.github'), { recursive: true, force: true });
    await must(dir, ['init', '--quiet', '-b', 'main']);
    await must(dir, ['add', '-A']);
    const tracked = (await must(dir, ['ls-files', '-z'])).split('\0').filter(Boolean);
    if (tracked.some(underGithub))
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
    const sealed = await treeOf(source);
    const seeded = await treeOf(dir);
    const drift = [...new Set([...sealed.keys(), ...seeded.keys()])]
      .filter((path) => !underGithub(path) && sealed.get(path) !== seeded.get(path))
      .sort();
    if (drift.length > 0)
      throw new TaskRefused(
        `the seeded tree differs from the sealed tree at ${drift.slice(0, 5).join(', ')}: export-ignore or export-subst in a .gitattributes would make git archive drop or rewrite it`,
      );
    const sha = (await must(dir, ['rev-parse', 'HEAD'])).trim();
    await must(dir, ['push', '--quiet', '--force', target.remote, `HEAD:refs/heads/${branch}`]);
    const seen = (await must(dir, ['ls-remote', target.remote, `refs/heads/${branch}`])).split('\t')[0];
    if (seen !== sha) throw new TaskRefused(`the scratch host holds ${seen ?? 'nothing'} on ${branch}, not ${sha}`);
    return { branch, sha, files: tracked.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const dropBase = async (target: ScratchTarget, branch: string, workRoot: string): Promise<void> => {
  refProblem(BASE_REF, branch);
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'drop-'));
  try {
    await must(dir, ['init', '--quiet']);
    const present = (await must(dir, ['ls-remote', target.remote, `refs/heads/${branch}`])).trim() !== '';
    if (present) await must(dir, ['push', '--quiet', target.remote, '--delete', `refs/heads/${branch}`]);
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

export const dropWork = async (
  host: GitHost,
  send: Transport,
  target: ScratchTarget,
  branch: string,
): Promise<number> => {
  refProblem(WORK_REF, branch);
  const { repo } = target;
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

export interface Crew {
  readonly workers: Record<string, AgentRuntime>;
  failure(): Failure | null;
  fail(error: unknown): void;
}

export const oneSessionEach = (runtimes: Readonly<Record<string, AgentRuntime>>): Crew => {
  let failure: Failure | null = null;
  const started = new Set<string>();
  const fail = (error: unknown) => {
    failure ??= {
      message: error instanceof Error ? error.message : String(error),
      refused: error instanceof WriteRefused,
    };
  };
  const watch = (runtime: AgentRuntime): AgentRuntime => ({
    ...runtime,
    async run(job) {
      if (failure !== null) throw new Error(`no session starts after a failure: ${failure.message}`);
      const turn = `${job.task} ${job.role} ${job.round}`;
      if (started.has(turn)) {
        const again = new Error(`a session for ${turn} was already started, and none is ever started twice`);
        fail(again);
        throw again;
      }
      started.add(turn);
      try {
        return await runtime.run(job);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
  });
  return {
    workers: Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, watch(runtime)])),
    failure: () => failure,
    fail,
  };
};

export const logged =
  (send: Transport, log: (call: ApiCall) => void): Transport =>
  async (request) => {
    const started = performance.now();
    const note = (status: number) =>
      log({
        ts: new Date().toISOString(),
        host: 'github',
        method: request.method,
        path: request.path,
        status,
        ms: Math.round(performance.now() - started),
      });
    try {
      const response = await send(request);
      note(response.status);
      return response;
    } catch (error) {
      note(0);
      throw error;
    }
  };

export interface ScratchOptions {
  readonly repo: string;
  readonly remote?: string;
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
  const target = ScratchTarget.of(o.repo, o.remote);
  const send = logged(o.send, o.log);
  return {
    ...(o.reviewPollMs === undefined ? {} : { reviewPollMs: o.reviewPollMs }),
    async open(_task, ticket, prepared) {
      const names = namesOf(ticket.id);
      const host = github({ repo: target.repo, base: names.base, send: o.send, log: o.log });
      const clear = async () => {
        await dropWork(host, send, target, names.work);
        await dropBase(target, names.base, o.workRoot);
      };
      await clear();
      await seedBase(prepared.source, target, names.base, o.workRoot);
      const home = mkdtempSync(join(o.workRoot, 'hq-'));
      const crew = oneSessionEach(o.workers(prepared));
      return {
        failure: crew.failure,
        host,
        repo: target.repo,
        base: names.base,
        home,
        reviewer: REVIEWER,
        mode: cagesMode({
          host,
          repo: target.repo,
          base: names.base,
          tickets: { [ticket.id]: ticket },
          author: AUTHOR,
          reviewer: REVIEWER,
          workers: crew.workers,
          onJobFailed: (_task, error) => crew.fail(error),
          pollMs: o.pollMs ?? 10_000,
          ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
        }),
        removed: (change) => removedVia(send, target.repo, change.number),
        close: async () => {
          rmSync(home, { recursive: true, force: true });
          if (o.keep !== true) await clear();
        },
      };
    },
  };
};
