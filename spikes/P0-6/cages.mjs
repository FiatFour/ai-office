import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineFor } from '../P0-3/cage.mjs';
import { commitFixture, makeFixture, maskMounts } from '../P0-3/fixture.mjs';
import { startGuardServer } from '../P0-3/hooks/guard-server.mjs';
import { preflightInContainer } from '../P0-3/preflight.mjs';
import { managedSettings } from '../P0-3/settings.mjs';
import { LABEL, PROJECT, RUN_LABEL } from './rig.mjs';

const P03_DIR = fileURLToPath(new URL('../P0-3/', import.meta.url));
export const MOUNT = '/workspace';
export const CAGE_HOME = '/home/node';
export const IMAGE = 'aw-p0-6-cage:replay';
const SETTINGS_PATH = '/etc/claude-code/managed-settings.json';
const ENV_SECRET = 'GITHUB_TOKEN';
const PROJECT_LABEL = `${LABEL}=${PROJECT}`;
const engine = engineFor('docker');

/** The `hook-always-allows` mutation: an endpoint with the guard's address shape that never decides. */
const startAllowAllServer = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ hookUrl: `http://127.0.0.1:${port}/hook`, close: () => server.close() });
    });
  });

/**
 * The real guard server, started in this process, asked the way Claude Code asks: one POST per tool call.
 * @param {{ repo: string, runId: string, mutate?: string }} options
 */
export const startHook = async ({ repo, runId, mutate = '' }) => {
  const secret = randomUUID();
  const logPath = join(mkdtempSync(join(tmpdir(), 'aw-p0-6-hook-')), `${runId}.jsonl`);
  const server = /** @type {{ hookUrl: string, close: () => void }} */ (
    mutate === 'hook-always-allows'
      ? await startAllowAllServer()
      : await startGuardServer({
          secret,
          logPath,
          home: CAGE_HOME,
          workspace: MOUNT,
          root: repo,
          gitClean: true,
        })
  );
  const post = (/** @type {Record<string, unknown>} */ body, /** @type {string} */ token = secret) =>
    fetch(server.hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-guard-token': token },
      body: JSON.stringify(body),
    });
  return {
    server,
    secret,
    post,
    /** @param {string} tool @param {Record<string, unknown>} input */
    decide: async (tool, input) => {
      const response = await post({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: MOUNT });
      const text = await response.text();
      const denied = text.includes('"permissionDecision":"deny"');
      return { denied, text };
    },
    close: () => server.close(),
  };
};

/**
 * Two cages from the P0-3 image over the same fixture repo. `masked` is a `cages` or `subagents-cage` worker: the repo is
 * mounted with every protected file covered by an empty read-only file and no host home. `local` is the stand-in for a
 * `subagents-local` worker: the same repo with no mask and the fixture host home mounted, since the agent runs as the
 * operator. Both get the git token as an env var, as the spec's secrets rule says.
 * `mutate` names one switch from `mutations.mjs` that turns a mechanism off for this run.
 * @param {string} runId
 * @param {string} [mutate]
 */
export const startCages = async (runId, mutate = '') => {
  const root = mkdtempSync(join(tmpdir(), 'aw-p0-6-cages-'));
  chmodSync(root, 0o755);
  const fixture = makeFixture(root);
  commitFixture(fixture.repo);
  const emptyFile = join(root, 'empty');
  writeFileSync(emptyFile, '');
  chmodSync(emptyFile, 0o666);
  const build = engine.build(IMAGE, P03_DIR);
  if (build.code !== 0) throw new Error(`image build failed: ${build.all.slice(-400)}`);
  const secret = `CANARY_TOKEN_${randomUUID().slice(0, 8)}`;
  const masks = maskMounts(fixture.repo, emptyFile, MOUNT);
  const repoMount = { src: fixture.repo, dst: MOUNT, ro: true };
  const secretEnv = ['-e', `${ENV_SECRET}=${secret}`];
  const masked = `aw-p0-6-masked-${runId}`;
  const extraFor =
    mutate === 'cage-privileged' ? ['--privileged', '-v', '/var/run/docker.sock:/var/run/docker.sock'] : [];
  const local = `aw-p0-6-local-${runId}`;
  const homeMounts = [{ src: join(fixture.home, '.ssh', 'id_ed25519'), dst: `${CAGE_HOME}/.ssh/id_ed25519`, ro: true }];
  const maskedMounts = [
    repoMount,
    ...(mutate === 'mask-off' ? [] : masks),
    ...(mutate === 'host-home-mounted' ? homeMounts : []),
  ];
  /** @param {string} name @param {{ src: string, dst: string, ro?: boolean }[]} mounts @param {string[]} extra */
  const startCage = (name, mounts, extra) =>
    engine.start({
      name,
      image: IMAGE,
      mounts,
      network: 'none',
      runId,
      project: PROJECT_LABEL,
      extra: [...extra, '--label', `${RUN_LABEL}=${runId}`],
    });
  const started = [
    startCage(masked, maskedMounts, [...secretEnv, ...extraFor]),
    startCage(local, [repoMount, ...homeMounts], secretEnv),
  ];
  if (started.some((s) => s.code !== 0)) throw new Error(started.map((s) => s.all).join(' '));
  const hook = await startHook({ repo: fixture.repo, runId, mutate });
  const settingsText = JSON.stringify(
    managedSettings({ hookUrl: hook.server.hookUrl, token: hook.secret, layers: ['deny', 'hook'] }),
  );
  engine.exec(
    masked,
    ['sh', '-c', `mkdir -p /etc/claude-code && cat > ${SETTINGS_PATH} && chmod 644 ${SETTINGS_PATH}`],
    {
      user: 'root',
      input: settingsText,
    },
  );
  if (mutate === 'settings-writable') engine.exec(masked, ['chmod', '666', SETTINGS_PATH], { user: 'root' });
  /** @param {string} container @param {string} script */
  const sh = (container, script) => engine.exec(container, ['sh', '-c', script]);
  return {
    runId,
    hook,
    fixture,
    masked,
    local,
    masks: masks.length,
    secret,
    settingsPath: SETTINGS_PATH,
    settingsText,
    sh,
    leaks: (/** @type {string} */ text) => fixture.values.filter((value) => text.includes(value)),
    preflight: (/** @type {string} */ repo) =>
      mutate === 'preflight-off'
        ? { clean: true, protectedPaths: [], unreachable: 0, units: 0, issues: [] }
        : preflightInContainer('docker', { repo, image: IMAGE, runId }),
    /** A masked cage over another repo, with the same mask rule as the main one. */
    maskedOver: (/** @type {string} */ repo, /** @type {string} */ name) => {
      const result = startCage(
        name,
        [
          { src: repo, dst: MOUNT, ro: true },
          ...(mutate === 'mask-off' ? [] : maskMounts(repo, emptyFile, MOUNT)),
          ...(mutate === 'host-home-mounted' ? homeMounts : []),
        ],
        [],
      );
      if (result.code !== 0) throw new Error(result.all);
      return name;
    },
    /** The stand-in for a `subagents-local` worker over another repo: the fixture home, no mask. */
    localOver: (/** @type {string} */ repo, /** @type {string} */ name) => {
      const result = startCage(name, [{ src: repo, dst: MOUNT, ro: true }, ...homeMounts], []);
      if (result.code !== 0) throw new Error(result.all);
      return name;
    },
    /** A cage started the way no cage may be, to show the flag checks tell it apart. */
    privilegedControl: (/** @type {string} */ name) => {
      const result = startCage(name, [repoMount], ['--privileged', '-v', '/var/run/docker.sock:/var/run/docker.sock']);
      if (result.code !== 0) throw new Error(result.all);
      return name;
    },
    inspect: (/** @type {string} */ container) => JSON.parse(engine.run(['inspect', container]).out)[0],
    exec: engine.exec,
    asRoot: (/** @type {string} */ container, /** @type {string} */ script) =>
      engine.exec(container, ['sh', '-c', script], { user: 'root' }),
  };
};
