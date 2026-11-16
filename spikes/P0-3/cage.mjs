import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/**
 * @typedef {'docker' | 'podman'} EngineName
 * @typedef {'PASS' | 'FAIL' | 'NOT-RUN'} Status
 * @typedef {{ src: string, dst: string, ro?: boolean }} Mount
 * @typedef {{ id: string, status: Status, detail: string }} Result
 */

export const PROJECT_LABEL = 'agent-works.project=p0-3-spike';
export const LIVE_PROJECT_LABEL = 'agent-works.project=p0-3-live';
export const LANE_LABEL = 'agent-works.p0-3=lane';
export const IMAGE = 'aw-p0-3-cage';

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions & { input?: string }} [options]
 */
export const run = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return {
    code: result.status ?? -1,
    out: String(result.stdout ?? ''),
    err: String(result.stderr ?? ''),
    all: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {string} [input]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
export const runAsync = (bin, args, input, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(timeoutMs ? { timeout: timeoutMs } : {}) });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    child.stdin.end(input ?? '');
  });

/**
 * @param {string} container
 * @param {string[]} command
 * @param {{ user?: string, cwd?: string, input?: string, timeoutMs?: number }} options
 */
const execArgs = (container, command, options) => {
  const flags = ['-i'];
  if (options.user) flags.push('-u', options.user);
  if (options.cwd) flags.push('-w', options.cwd);
  return ['exec', ...flags, container, ...command];
};

/** @param {EngineName} engine */
export const engineFor = (engine) => ({
  bin: engine,
  /** @param {string[]} args */
  run: (args) => run(engine, args),
  /**
   * @param {string} container
   * @param {string[]} command
   * @param {{ user?: string, cwd?: string, input?: string }} [options]
   */
  exec: (container, command, options = {}) =>
    run(engine, execArgs(container, command, options), options.input === undefined ? {} : { input: options.input }),
  /**
   * @param {string} container
   * @param {string[]} command
   * @param {{ user?: string, cwd?: string, input?: string, timeoutMs?: number }} [options]
   */
  execAsync: (container, command, options = {}) =>
    runAsync(engine, execArgs(container, command, options), options.input),
  /** @param {string} tag @param {string} context */
  build: (tag, context) =>
    run(engine, ['build', '-t', tag, '-f', `${context}/Containerfile`, context], { stdio: ['ignore', 'pipe', 'pipe'] }),
  /**
   * @param {{ name: string, image: string, mounts?: Mount[], network?: string, extra?: string[], runId: string, project?: string }} spec
   */
  start: ({ name, image, mounts = [], network, extra = [], runId, project = PROJECT_LABEL }) => {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      project,
      '--label',
      LANE_LABEL,
      '--label',
      `agent-works.run=${runId}`,
    ];
    if (network) args.push('--network', network);
    for (const mount of mounts) args.push('-v', `${mount.src}:${mount.dst}${mount.ro ? ':ro' : ''}`);
    return run(engine, [...args, ...extra, image]);
  },
  /** @param {string} [runId] */
  cleanup: (runId) => {
    const filters = [
      '--filter',
      `label=${LANE_LABEL}`,
      ...(runId ? ['--filter', `label=agent-works.run=${runId}`] : []),
    ];
    const ids = run(engine, ['ps', '-aq', ...filters])
      .out.split('\n')
      .filter(Boolean);
    if (ids.length > 0) run(engine, ['rm', '-f', ...ids]);
    return ids.length;
  },
});

export const newRunId = () => randomUUID().slice(0, 8);

/** @param {number[]} samples @param {number} fraction */
export const percentile = (samples, fraction) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? Number.NaN;
};

/** @param {string} path */
export const makeReporter = (path) => {
  /** @type {Result[]} */
  const results = [];
  return {
    results,
    /** @param {string} id @param {Status} status @param {string} detail */
    add: (id, status, detail) => {
      results.push({ id, status, detail });
      console.log(`${status} ${id}: ${detail}`);
    },
    finish: () => {
      writeFileSync(path, `${results.map((r) => `${r.status} ${r.id}: ${r.detail}`).join('\n')}\n`);
      return results.some((r) => r.status === 'FAIL') ? 1 : 0;
    },
  };
};
