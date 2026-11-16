import { LANE_LABEL, run } from './cage.mjs';

const SPIKE_DIR = new URL('.', import.meta.url).pathname;

/**
 * The container the preflight scan runs in: no network, no capabilities, a read-only root and a read-only repo,
 * so a core.fsmonitor or hook planted in the repo's own config can run, at worst, inside a throwaway container.
 * @param {{ repo: string, image: string, runId: string, mounts?: string[] }} options
 */
export const preflightArgs = ({ repo, image, runId, mounts = [] }) => [
  'run',
  '--rm',
  '--network',
  'none',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
  '--label',
  LANE_LABEL,
  '--label',
  `agent-works.run=${runId}`,
  '-v',
  `${repo}:/repo:ro`,
  '-v',
  `${SPIKE_DIR}:/spike:ro`,
  ...mounts.flatMap((mount) => ['-v', mount]),
  '--entrypoint',
  'node',
  image,
  '/spike/git-scan.mjs',
  '/repo',
];

/**
 * @param {string} engine
 * @param {{ repo: string, image: string, runId: string, mounts?: string[], timeoutMs?: number }} options
 * @returns {import('./git-scan.mjs').ScanResult}
 */
export const preflightInContainer = (engine, { timeoutMs = 300_000, ...options }) => {
  const result = run(engine, preflightArgs(options), { timeout: timeoutMs });
  try {
    return JSON.parse(result.out);
  } catch {
    return {
      clean: false,
      protectedPaths: [],
      unreachable: 0,
      units: 0,
      issues: [`the contained preflight failed (exit ${result.code}): ${result.err.trim().slice(-300)}`],
    };
  }
};
