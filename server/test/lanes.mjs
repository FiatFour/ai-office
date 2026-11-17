import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(ROOT, 'bin/agent-works.ts');
const out = process.argv[2] ?? '/tmp/swarm-P1-1/owner';
const IMAGE = process.env.AGENT_WORKS_CAGE_IMAGE ?? 'aw-test-cage:1';
process.env.AGENT_WORKS_CAGE_IMAGE = IMAGE;
mkdirSync(out, { recursive: true });

const work = realpathSync(mkdtempSync(join(tmpdir(), 'aw-lanes-')));
const home = join(work, 'home');
/** @param {string} name */
const repo = (name) => {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), name);
  writeFileSync(join(dir, '.env'), 'API_KEY=CANARY_LANES\n');
  git('add', '-A', '-f');
  git('commit', '-qm', 'init');
  git('remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
  return dir;
};

/** @param {string} cwd @param {string[]} args @param {NodeJS.ProcessEnv} [env] @param {string} [homeDir] */
const cli = (cwd, args, env = {}, homeDir = home) => {
  const res = spawnSync(process.execPath, [BIN, ...args, '--home', homeDir], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return {
    code: res.status,
    text: `$ agent-works ${args.join(' ')}   (cwd ${cwd})\n${res.stdout}${res.stderr}exit ${res.status}\n`,
  };
};

/** @type {string[]} */
const summary = [];
/** @param {number} lane @param {string} file @param {string} text @param {boolean} pass @param {string} why */
const record = (lane, file, text, pass, why) => {
  writeFileSync(join(out, file), text);
  const line = `${pass ? 'PASS' : 'FAIL'} lane ${lane} (${file}): ${why}`;
  console.log(line);
  summary.push(line);
};

/** @param {{ code: number | null }} res */
const ok = (res) => res.code === 0;
const factoryA = repo('alpha');
const factoryB = repo('beta');

const l1a = cli(factoryA, ['--no-open']);
const l1b = cli(factoryA, ['ls']);
const health = await fetch('http://127.0.0.1:7420/api/health')
  .then((r) => r.json())
  .catch(() => null);
record(
  1,
  'start-ls.txt',
  `${l1a.text}${l1b.text}GET /api/health -> ${JSON.stringify(health)}\n`,
  ok(l1a) && ok(l1b) && health?.service === 'agent-works' && l1b.text.includes('factory alpha'),
  'HQ answers on 7420 and ls lists the factory. Trunk has no CLI, so there is no regression baseline.',
);

const l2 = cli(factoryB, ['--no-open']);
const pidOf = (/** @type {string} */ t) => /pid (\d+)/.exec(t)?.[1];
const both = cli(factoryA, ['ls']);
record(
  2,
  'reuse.txt',
  `${l1a.text}${l2.text}${both.text}`,
  pidOf(l1a.text) === pidOf(l2.text) &&
    both.text.includes('factory alpha') &&
    both.text.includes('factory beta') &&
    l2.text.includes('reused'),
  `same pid ${pidOf(l2.text)} serves both factories`,
);

const l9a = cli(factoryA, ['add-repo', factoryB, '--factory', factoryB]);
const l9b = cli(factoryA, ['add-repo', factoryB]);
const repos = JSON.parse(readFileSync(join(home, 'repos.json'), 'utf8')).repos;
const facts = JSON.parse(readFileSync(join(home, 'factories.json'), 'utf8')).factories;
const listing = cli(factoryA, ['ls']);
const holders = Object.values(facts).filter((f) => f.repos.includes('github.com/acme/beta')).length;
record(
  9,
  'many-to-many.txt',
  `${l9a.text}${l9b.text}${listing.text}repos.json keys: ${Object.keys(repos).join(', ')}\nfactories holding github.com/acme/beta: ${holders}\n`,
  Object.keys(repos).filter((k) => k.endsWith('/beta')).length === 1 && holders === 2,
  'repos.json has one beta entry and two factories list it',
);

const deadDocker = cli(factoryA, ['doctor', '--json'], {
  DOCKER_HOST: 'unix:///nonexistent-aw.sock',
  AGENT_WORKS_ENGINE: 'docker',
});
const checks = JSON.parse(deadDocker.text.slice(deadDocker.text.indexOf('['), deadDocker.text.lastIndexOf(']') + 1));
const engine = checks.find((/** @type {{ id: string }} */ c) => c.id === 'engine');
record(
  3,
  'doctor-fail.txt',
  `${deadDocker.text}\n(the docker daemon was left running, it holds other cages. DOCKER_HOST points at a dead socket, the same error a stopped daemon gives.)\n`,
  deadDocker.code === 1 && engine?.status === 'FAIL' && /Docker Desktop|systemctl|service docker/.test(engine.fix),
  'exit 1 and the engine check names this OS fix',
);

const l4 = cli(factoryA, ['doctor']);
record(
  4,
  'doctor-wsl2.txt',
  l4.text,
  /Host: Linux \(WSL2 on Windows\)/.test(l4.text),
  'host row says Linux (WSL2 on Windows)',
);

const portHolder = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const busyPort = portHolder.address().port;
const l8 = cli(factoryA, ['--no-open', '--port', String(busyPort)], {}, join(work, 'home-busy'));
portHolder.close();
record(
  8,
  'port-busy.txt',
  l8.text,
  l8.code === 2 && l8.text.includes(`Port ${busyPort} is busy`) && l8.text.includes('--port'),
  'CLI says the port is busy and suggests --port',
);

const engineName = process.env.AGENT_WORKS_ENGINE ?? 'docker';
const label = (/** @type {string} */ id) => `label=agent-works.hq=${id}`;
const hqId = readFileSync(join(home, 'hq-id'), 'utf8').trim();
const l6start = cli(factoryA, ['cage', 'start', '--task', 'acme/lane6', '--worker', 'nova', '--source', factoryA], {
  AGENT_WORKS_CAGE_IMAGE: IMAGE,
});
const stillUp = () =>
  spawnSync(engineName, ['ps', '-a', '--filter', label(hqId), '--format', '{{.Names}}'], {
    encoding: 'utf8',
  }).stdout.trim();
const upBefore = stillUp();
const l6stop = cli(factoryA, ['stop']);
const upAfter = stillUp();
const networksAfter = spawnSync(engineName, ['network', 'ls', '--filter', label(hqId), '--format', '{{.Name}}'], {
  encoding: 'utf8',
}).stdout.trim();
const pids = (() => {
  const res = spawnSync('pgrep', ['-af', 'node'], { encoding: 'utf8' });
  return res.stdout
    .split('\n')
    .filter((line) => line.includes(home) || line.includes(`aw-${hqId}-`))
    .join('\n');
})();
const hqAlive = await fetch('http://127.0.0.1:7420/api/health')
  .then(() => true)
  .catch(() => false);
record(
  6,
  'stop.txt',
  `${l6start.text}containers before stop:\n${upBefore}\n${l6stop.text}containers after stop: [${upAfter}]\nnetworks after stop: [${networksAfter}]\nHQ still answering: ${hqAlive}\nleftover agent-works or log-follower processes:\n${pids}\n`,
  ok(l6start) &&
    upBefore.split('\n').length >= 2 &&
    ok(l6stop) &&
    upAfter === '' &&
    networksAfter === '' &&
    !hqAlive &&
    pids === '',
  'a cage and its proxy existed, then no process, container or network labeled for this HQ is left',
);

writeFileSync(join(out, 'lanes-summary.txt'), `${summary.join('\n')}\n`);
process.exit(summary.some((l) => l.startsWith('FAIL')) ? 1 : 0);
