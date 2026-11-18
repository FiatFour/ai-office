import { randomUUID } from 'node:crypto';
import { type RunResult, runBinary } from '../server/sandbox/engine.ts';

export interface RunSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly image: string;
  readonly network: boolean;
  readonly timeoutMs: number;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
}

const noEnv = (cwd: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME: cwd, CI: '1' });

export const localRunner: Runner = {
  run: ({ argv, cwd, timeoutMs }) => {
    return runBinary('sh', ['-c', 'cd "$0" && exec "$@"', cwd, ...argv], { timeoutMs, env: noEnv(cwd) });
  },
};

export const dockerRunner = (bin = 'docker'): Runner => ({
  async run({ argv, cwd, image, network, timeoutMs }) {
    const name = `aw-bench-${randomUUID()}`;
    const user = process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      network ? 'bridge' : 'none',
      ...user,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-e',
      'HOME=/tmp',
      '-e',
      'CI=1',
      '--mount',
      `type=bind,src=${cwd},dst=/work`,
      '-w',
      '/work',
      image,
      ...argv,
    ];
    const ran = await runBinary(bin, args, { timeoutMs });
    if (ran.timedOut) await runBinary(bin, ['rm', '-f', name]);
    return ran;
  },
});
