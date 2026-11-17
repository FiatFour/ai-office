import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const DEFAULT_PORT = 7420;
export const VERSION = '0.1.0';
export const DEFAULT_IMAGE = 'aw-cage:dev';

export const resolveHome = (env: NodeJS.ProcessEnv): string => env.AGENT_WORKS_HOME ?? join(homedir(), '.agent-works');

export const imageFor = (env: NodeJS.ProcessEnv): string => env.AGENT_WORKS_CAGE_IMAGE ?? DEFAULT_IMAGE;

export const hqIdFor = (home: string): string => {
  const path = join(home, 'hq-id');
  mkdirSync(home, { recursive: true });
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const id = randomBytes(3).toString('hex');
  writeFileSync(path, id);
  return id;
};

export interface RuntimeFile {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: number;
  readonly url: string;
}

export const runtimePath = (home: string): string => join(home, 'hq.json');

export const readRuntime = (home: string): RuntimeFile | null => {
  try {
    return JSON.parse(readFileSync(runtimePath(home), 'utf8')) as RuntimeFile;
  } catch {
    return null;
  }
};

export const writeRuntime = (home: string, runtime: RuntimeFile): void => {
  writeFileSync(runtimePath(home), JSON.stringify(runtime));
};

export const clearRuntime = (home: string, pid: number): void => {
  if (readRuntime(home)?.pid === pid) rmSync(runtimePath(home), { force: true });
};

const within = (parent: string, path: string): boolean => {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const agentWritableRoots = (home: string): string[] =>
  ['cages', 'homes'].map((name) => {
    const dir = join(home, name);
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  });

export const insideCage = (home: string, path: string): boolean => {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return agentWritableRoots(home).some((root) => within(root, real));
};
