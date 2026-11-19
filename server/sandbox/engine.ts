import { execFile, spawn } from 'node:child_process';

export type EngineName = 'docker' | 'podman';

export interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly timedOut: boolean;
}

export interface EngineInfo {
  readonly ok: boolean;
  readonly version: string | null;
  readonly rootless: boolean;
  readonly error: string | null;
}

export interface RunOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export const runBinary = (bin: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGKILL' }),
      },
      (error, out, err) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({
          code,
          out,
          err: error !== null && code === -1 && err === '' ? error.message : err,
          timedOut: error?.killed === true,
        });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });

export class Engine {
  readonly name: EngineName;
  readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(name: EngineName, env: NodeJS.ProcessEnv = process.env, bin: string = name) {
    this.name = name;
    this.bin = bin;
    this.env = env;
  }

  run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return runBinary(this.bin, args, { env: this.env, ...options });
  }

  async ok(args: readonly string[], options: RunOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      throw new EngineError(
        `${this.name} ${args.slice(0, 3).join(' ')} failed (exit ${result.code}): ${result.err.trim()}`,
      );
    }
    return result.out;
  }

  follow(args: readonly string[], onLine: (line: string) => void): { stop: () => void } {
    const child = spawn(this.bin, [...args], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffered = '';
    const feed = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', () => {});
    return { stop: () => child.kill() };
  }

  async version(): Promise<string | null> {
    const result = await this.run(['--version'], { timeoutMs: 10_000 });
    return result.code === 0 ? result.out.trim() : null;
  }

  async info(): Promise<EngineInfo> {
    const format = this.name === 'docker' ? ['--format', '{{json .}}'] : ['--format', 'json'];
    const result = await this.run(['info', ...format], { timeoutMs: 20_000 });
    if (result.code !== 0) {
      const error = (result.err || result.out).trim().split('\n')[0] ?? 'no output';
      return { ok: false, version: null, rootless: false, error };
    }
    try {
      const info = JSON.parse(result.out) as {
        ServerVersion?: string;
        SecurityOptions?: string[];
        version?: { Version?: string };
        host?: { security?: { rootless?: boolean } };
      };
      if (this.name === 'docker') {
        const options = info.SecurityOptions ?? [];
        return {
          ok: true,
          version: String(info.ServerVersion ?? ''),
          rootless: options.some((option) => option.includes('rootless')),
          error: null,
        };
      }
      return {
        ok: true,
        version: String(info.version?.Version ?? ''),
        rootless: info.host?.security?.rootless === true,
        error: null,
      };
    } catch {
      return { ok: false, version: null, rootless: false, error: 'unreadable `info` output' };
    }
  }
}

export class EngineError extends Error {}

export const ENGINE_NAMES: readonly EngineName[] = ['docker', 'podman'];

export const pickEngine = async (preferred: string | undefined, env: NodeJS.ProcessEnv): Promise<Engine | null> => {
  const order: readonly EngineName[] = preferred === 'docker' || preferred === 'podman' ? [preferred] : ENGINE_NAMES;
  for (const name of order) {
    const engine = new Engine(name, env);
    if ((await engine.info()).ok) return engine;
  }
  return null;
};
