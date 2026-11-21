import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { LANE_LABEL, run } from './cage.mjs';

const SPIKE_DIR = new URL('.', import.meta.url).pathname;
const SCAN_MEMORY = '2g';
const SCAN_PIDS = '256';

/** @param {string} src @param {string} dst */
const readOnlyMount = (src, dst) => `type=bind,src=${src},dst=${dst},readonly`;

/**
 * The container the preflight scan runs in: no network, no capabilities, a read-only root, a read-only repo and
 * bounded memory and processes, so a core.fsmonitor or hook planted in the repo's own config can run, at worst,
 * inside a throwaway container. `--mount type=bind` errors on a missing source where `-v` would create a
 * root-owned directory on the host.
 * @param {{ repo: string, image: string, runId: string, name: string, mounts?: string[] }} options
 */
export const preflightArgs = ({ repo, image, runId, name, mounts = [] }) => [
  'run',
  '--rm',
  '--name',
  name,
  '--network',
  'none',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
  '--pids-limit',
  SCAN_PIDS,
  '--memory',
  SCAN_MEMORY,
  '--label',
  LANE_LABEL,
  '--label',
  `agent-works.run=${runId}`,
  '--mount',
  readOnlyMount(repo, '/repo'),
  '--mount',
  readOnlyMount(SPIKE_DIR, '/spike'),
  ...mounts.flatMap((mount) => ['-v', mount]),
  '--entrypoint',
  'node',
  image,
  '/spike/git-scan.mjs',
  '/repo',
];

/**
 * @param {string} reason
 * @returns {import('./git-scan.mjs').ScanResult}
 */
const notClean = (reason) => ({ clean: false, protectedPaths: [], unreachable: 0, units: 0, issues: [reason] });

/**
 * @param {string} engine
 * @param {{ repo: string, image: string, runId: string, mounts?: string[], timeoutMs?: number }} options
 * @returns {import('./git-scan.mjs').ScanResult}
 */
export const preflightInContainer = (engine, { timeoutMs = 300_000, ...options }) => {
  let isDir = false;
  try {
    isDir = statSync(options.repo).isDirectory();
  } catch {}
  if (!isDir) return notClean(`${options.repo} does not exist or is not a directory, so it cannot be vouched for`);
  if (/[,"]/.test(options.repo))
    return notClean(`${options.repo} has a comma or quote the container mount cannot carry`);
  const name = `aw-p0-3-preflight-${options.runId}-${randomBytes(3).toString('hex')}`;
  const result = run(engine, preflightArgs({ ...options, name }), { timeout: timeoutMs, killSignal: 'SIGKILL' });
  run(engine, ['rm', '-f', name]);
  if (result.timedOut) return notClean(`the contained preflight timed out after ${timeoutMs} ms and was killed`);
  try {
    return JSON.parse(result.out);
  } catch {
    return notClean(`the contained preflight failed (exit ${result.code}): ${result.err.trim().slice(-300)}`);
  }
};

/**
 * Recomputes the git verdict from a fresh scan and hands it to the guard, so a lane that may have written the
 * repo never runs on a stale clean flag.
 * @param {{ setGitClean: (value: boolean) => unknown }} server
 * @param {() => { clean: boolean }} scan
 */
export const refreshGitClean = (server, scan) => {
  const { clean } = scan();
  server.setGitClean(clean);
  return clean;
};
