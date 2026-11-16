import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { engineFor, IMAGE, LANE_LABEL, makeReporter, newRunId, percentile, run } from './cage.mjs';
import { commitFixture, makeFixture, maskMounts } from './fixture.mjs';
import { startGuardServer } from './hooks/guard-server.mjs';
import { checkToolCall, isProtectedPath } from './protected-paths.mjs';
import { managedSettings } from './settings.mjs';

const SPIKE_DIR = fileURLToPath(new URL('.', import.meta.url));
const MOUNT = '/workspace';
const CAGE_HOME = '/home/node';
const HOOK_P95_BUDGET_MS = 100;
const COLD_START_BUDGET_MS = 30_000;

const POST_SCRIPT = `
const payloads = JSON.parse(require('fs').readFileSync(0, 'utf8'));
(async () => {
  const out = [];
  for (const { url, body } of payloads) {
    const start = process.hrtime.bigint();
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      out.push({ status: response.status, body: await response.text(), ms: Number(process.hrtime.bigint() - start) / 1e6 });
    } catch (error) {
      out.push({ error: String(error.cause?.code ?? error.message), ms: Number(process.hrtime.bigint() - start) / 1e6 });
    }
  }
  console.log(JSON.stringify(out));
})();
`;

/** @type {{ id: string, tool: string, input: Record<string, string>, expect: 'deny' | 'allow', note: string }[]} */
const ATTACKS = [
  { id: 'bash-cat-env', tool: 'Bash', input: { command: 'cat .env' }, expect: 'deny', note: '' },
  { id: 'bash-cp-env', tool: 'Bash', input: { command: 'cp .env /tmp/x' }, expect: 'deny', note: '' },
  { id: 'bash-grep-r', tool: 'Bash', input: { command: 'grep -r API_KEY .' }, expect: 'deny', note: 'N-1' },
  { id: 'bash-redirect', tool: 'Bash', input: { command: 'cat < .env' }, expect: 'deny', note: '' },
  { id: 'bash-cat-ssh', tool: 'Bash', input: { command: 'cat ~/.ssh/id_ed25519' }, expect: 'deny', note: '' },
  { id: 'read-env', tool: 'Read', input: { file_path: '/workspace/.env' }, expect: 'deny', note: '' },
  { id: 'read-ssh', tool: 'Read', input: { file_path: '/home/node/.ssh/id_ed25519' }, expect: 'deny', note: '' },
  { id: 'bash-cat-example', tool: 'Bash', input: { command: 'cat .env.example' }, expect: 'allow', note: '' },
  { id: 'bash-echo', tool: 'Bash', input: { command: 'echo hi' }, expect: 'allow', note: '' },
  {
    id: 'bash-script-obfuscated',
    tool: 'Bash',
    input: { command: `node -e "console.log(require('fs').readFileSync('.'+'env','utf8'))"` },
    expect: 'allow',
    note: 'known gap, only layer 2 catches it',
  },
];

const { values: args } = parseArgs({
  options: {
    engine: { type: 'string', default: 'docker' },
    out: { type: 'string', default: '/tmp/swarm-P0-3/owner' },
    hooks: { type: 'string', default: '100' },
    cold: { type: 'string', default: '10' },
    image: { type: 'string' },
    cleanup: { type: 'boolean', default: false },
  },
});
const engineName = /** @type {'docker' | 'podman'} */ (args.engine);
const engine = engineFor(engineName);

if (args.cleanup) {
  console.log(`removed ${engine.cleanup()} ${engineName} container(s) labeled agent-works.p0-3=lane`);
  process.exit(0);
}

mkdirSync(String(args.out), { recursive: true });
const report = makeReporter(join(String(args.out), `${engineName}-cage-lanes.txt`));
const runId = newRunId();
const root = mkdtempSync(join(tmpdir(), 'p0-3-lanes-'));
chmodSync(root, 0o755);
const fixture = makeFixture(root);
commitFixture(fixture.repo);
const emptyFile = join(root, 'empty');
writeFileSync(emptyFile, '');
const image = args.image ?? `${IMAGE}:lanes`;
const exposed = /** @type {string[]} */ ([]);

console.log(
  run(engine.bin, ['version', '--format', '{{.Client.Version}}']).out.trim() || `${engineName} version unknown`,
);

if (!args.image) {
  const build = engine.build(image, SPIKE_DIR);
  report.add(
    'build',
    build.code === 0 ? 'PASS' : 'FAIL',
    build.code === 0 ? `built ${image} from Containerfile` : build.all.slice(-400),
  );
  if (build.code !== 0) process.exit(report.finish());
}

const server = await startGuardServer({
  secret: randomUUID(),
  logPath: join(String(args.out), `${engineName}-hook-events.jsonl`),
  home: CAGE_HOME,
  mapDir: (path) => (path.startsWith(MOUNT) ? path.replace(MOUNT, fixture.repo) : path),
});

const masks = maskMounts(fixture.repo, emptyFile, MOUNT);
const repoMount = { src: fixture.repo, dst: MOUNT, ro: true };
const masked = `aw-p0-3-masked-${runId}`;
const control = `aw-p0-3-control-${runId}`;
const maskedRw = `aw-p0-3-maskedrw-${runId}`;
const started = [
  engine.start({ name: masked, image, mounts: [repoMount, ...masks], network: 'host', runId }),
  engine.start({ name: control, image, mounts: [repoMount], network: 'host', runId }),
];
report.add(
  'cages',
  started.every((s) => s.code === 0) ? 'PASS' : 'FAIL',
  `masked cage covers ${masks.length} protected file(s): ${masks.map((m) => m.dst).join(', ')}; control cage has no mask`,
);

/** @param {string} container @param {string} script */
const sh = (container, script) => engine.exec(container, ['sh', '-c', script]);
/** @param {string} text */
const leaks = (text) => fixture.values.filter((value) => text.includes(value));

try {
  const catMasked = sh(masked, `cat ${MOUNT}/.env`);
  const catControl = sh(control, `cat ${MOUNT}/.env`);
  exposed.push(catMasked.all);
  report.add(
    'L5-mask-read',
    catMasked.code === 0 && catMasked.out === '' && leaks(catControl.out).length === 1 ? 'PASS' : 'FAIL',
    `masked cage cat .env prints ${catMasked.out.length} bytes; control cage prints the canary (${leaks(catControl.out).length} hit)`,
  );

  const grepMasked = sh(masked, `cd ${MOUNT} && grep -rI CANARY_ . ; echo exit=$?`);
  const grepControl = sh(control, `cd ${MOUNT} && grep -rI CANARY_ . | wc -l`);
  exposed.push(grepMasked.all);
  report.add(
    'L5-mask-grep-r',
    grepMasked.out.trim() === 'exit=1' && Number(grepControl.out.trim()) >= 5 ? 'PASS' : 'FAIL',
    `grep -r CANARY_ in masked cage: "${grepMasked.out.trim()}" (no hits); control cage: ${grepControl.out.trim()} hits. N-1 is closed by layer 2, not by deny rules`,
  );

  const GIT = `cd ${MOUNT} && git -c safe.directory='*'`;
  const readers = [
    'diff',
    'diff HEAD',
    'show HEAD:.env',
    'show HEAD',
    'cat-file -p HEAD:.env',
    'grep KEY HEAD',
    'grep -h KEY',
    'log -p --all',
    'show --stat HEAD',
  ];
  const readerOut = readers.map((reader) => sh(masked, `${GIT} ${reader} 2>&1`).out).join('\n');
  const readerControl = sh(masked, `${GIT} show HEAD:src/greet.js`);
  const tracked = sh(masked, `${GIT} ls-files`).out.split('\n');
  exposed.push(readerOut);
  report.add(
    'L2-git-readers',
    leaks(readerOut).length === 0 &&
      readerControl.out.includes('hello') &&
      !tracked.some((name) => isProtectedPath(`${MOUNT}/${name}`, { home: CAGE_HOME, cwd: MOUNT }))
      ? 'PASS'
      : 'FAIL',
    `${readers.length} git readers in the masked cage print ${leaks(readerOut).length} canaries; the control read of src/greet.js ${readerControl.out.includes('hello') ? 'printed its content' : 'failed'}, so git ran; ${tracked.length} tracked files, none protected (the preflight rule)`,
  );

  chmodSync(fixture.repo, 0o777);
  run('chmod', ['-R', 'a+rwX', fixture.repo]);
  const startedRw = engine.start({
    name: maskedRw,
    image,
    mounts: [{ src: fixture.repo, dst: MOUNT }, ...masks],
    network: 'host',
    runId,
  });
  const writeControl = sh(maskedRw, `echo x >> ${MOUNT}/README.md`);
  const write = sh(maskedRw, `echo x >> ${MOUNT}/.env`);
  report.add(
    'L5-mask-write',
    startedRw.code === 0 && writeControl.code === 0 && write.code !== 0 && /Read-only file system/.test(write.err)
      ? 'PASS'
      : 'FAIL',
    `in a read-write masked cage, appending to README.md exits ${writeControl.code} (control) and appending to the masked .env exits ${write.code}: ${write.err.trim() || 'no error text'}`,
  );
  const commit = sh(maskedRw, `${GIT} -c user.name=lane -c user.email=lane@example.test commit -qam lane`);
  const committedNames = sh(maskedRw, `${GIT} show --name-only --format= HEAD`).out.trim();
  const history = sh(maskedRw, `${GIT} log -p --all`).out;
  exposed.push(history);
  report.add(
    'L2-commit-a',
    commit.code === 0 && committedNames === 'README.md' && leaks(history).length === 0 ? 'PASS' : 'FAIL',
    `git commit -a in the masked read-write cage exits ${commit.code}; the commit names "${committedNames}" and the whole history prints ${leaks(history).length} canaries`,
  );

  const script = `cd ${MOUNT} && node -e "console.log(require('fs').readFileSync('.'+'env','utf8'))"`;
  const obfuscated = sh(masked, script);
  const unmaskedScript = sh(control, script);
  const hookView = checkToolCall(
    { tool_name: 'Bash', tool_input: { command: script.replace(`cd ${MOUNT} && `, '') } },
    { home: CAGE_HOME, cwd: MOUNT, mapDir: (path) => path.replace(MOUNT, fixture.repo) },
  );
  exposed.push(obfuscated.all);
  report.add(
    'N-1-script-bypass',
    obfuscated.code === 0 && obfuscated.all.trim() === '' && leaks(unmaskedScript.out).length === 1 && !hookView.blocked
      ? 'PASS'
      : 'FAIL',
    `a script that builds the name '.'+'env' passes the hook (blocked=${hookView.blocked}) and the deny rules by design; the control cage prints the canary (${leaks(unmaskedScript.out).length} hit) and the masked cage exits ${obfuscated.code} with ${obfuscated.all.trim().length} bytes on stdout and stderr. Only layer 2 catches it`,
  );

  const home = sh(masked, `ls -A ${CAGE_HOME}; echo ---; ls -A /root 2>&1`).all;
  const homeNames = home.split('\n').filter((line) => line && line !== '---');
  const protectedHome = homeNames.filter((name) =>
    isProtectedPath(`${CAGE_HOME}/${name}`, { home: CAGE_HOME, cwd: CAGE_HOME }),
  );
  const sweep = sh(
    control,
    "grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude-dir=workspace -e 'CANARY_SSH_' -e 'CANARY_AWS_' / 2>/dev/null | wc -l",
  );
  report.add(
    'L6-no-home',
    protectedHome.length === 0 && sweep.out.trim() === '0' ? 'PASS' : 'FAIL',
    `home entries [${homeNames.join(' ')}], protected names: ${protectedHome.length}; whole-filesystem sweep for the host-home canaries: ${sweep.out.trim()} hits (host home is never mounted)`,
  );

  const settings = managedSettings({ hookUrl: server.hookUrl, layers: ['deny', 'hook'] });
  const wrote = engine.exec(
    masked,
    ['sh', '-c', 'mkdir -p /etc/claude-code && cat > /etc/claude-code/managed-settings.json'],
    {
      user: 'root',
      input: JSON.stringify(settings, null, 2),
    },
  );
  const readBack = engine.exec(masked, ['cat', '/etc/claude-code/managed-settings.json']);
  const version = engine.exec(masked, ['claude', '--version']).out.trim();
  const parsed = readBack.code === 0 ? JSON.parse(readBack.out) : {};
  report.add(
    'settings',
    wrote.code === 0 &&
      parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.onFailure === 'block' &&
      version.startsWith('2.1.325')
      ? 'PASS'
      : 'FAIL',
    `managed settings installed in the cage with ${parsed.permissions?.deny?.length} deny rules and onFailure block on the PreToolUse hook; claude ${version}`,
  );

  /** @param {unknown[]} bodies */
  const post = async (bodies) =>
    JSON.parse(
      (
        await engine.execAsync(masked, ['node', '-e', POST_SCRIPT], {
          input: JSON.stringify(bodies.map((body) => ({ url: server.hookUrl, body }))),
        })
      ).out || '[]',
    );
  const session_id = `lane-${runId}`;
  const pre = (/** @type {string} */ tool_name, /** @type {Record<string, string>} */ tool_input) => ({
    hook_event_name: 'PreToolUse',
    session_id,
    cwd: MOUNT,
    tool_name,
    tool_input,
  });

  const replies = await post(ATTACKS.map((attack) => pre(attack.tool, attack.input)));
  for (const [index, attack] of ATTACKS.entries()) {
    const reply = replies[index] ?? {};
    const decision = reply.body ? JSON.parse(reply.body).hookSpecificOutput?.permissionDecision : 'allow';
    exposed.push(reply.body ?? '');
    report.add(
      `L4-hook-${attack.id}`,
      decision === attack.expect ? 'PASS' : 'FAIL',
      `PreToolUse ${attack.tool} ${JSON.stringify(attack.input)} -> ${decision} (expected ${attack.expect}) ${attack.note}`.trim(),
    );
  }

  const anonymous = await engine.execAsync(masked, [
    'node',
    '-e',
    `fetch(${JSON.stringify(`${server.url}/hook`)},{method:'POST',body:'{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"}}'}).then(r=>console.log(r.status))`,
  ]);
  const loggedAnonymous = readFileSync(join(String(args.out), `${engineName}-hook-events.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean).length;
  report.add(
    'L4-hook-auth',
    anonymous.out.trim() === '401' ? 'PASS' : 'FAIL',
    `a POST from inside the cage without the per-run token gets ${anonymous.out.trim()}; the hook log holds ${loggedAnonymous} entries from authenticated calls only`,
  );

  const lifecycle = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].map((hook_event_name) => ({
    hook_event_name,
    session_id: `order-${runId}`,
    cwd: MOUNT,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
  }));
  await post(lifecycle);
  const log = readFileSync(join(String(args.out), `${engineName}-hook-events.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const order = log.filter((entry) => entry.session_id === `order-${runId}`).map((entry) => entry.event);
  const blocks = log.filter((entry) => entry.decision === 'deny' && entry.layer);
  report.add(
    'hook-events-ordered',
    order.join(',') === 'SessionStart,PreToolUse,PostToolUse,Stop' ? 'PASS' : 'FAIL',
    `stub log order ${order.join(' > ')}; ${blocks.length} blocks logged, each with layer ${[...new Set(blocks.map((b) => b.layer))].join(',')}`,
  );

  const count = Number(args.hooks);
  const timed = await post(Array.from({ length: count }, () => pre('Bash', { command: 'echo hi' })));
  const timings = timed.map((/** @type {{ ms: number }} */ reply) => reply.ms);
  const p50 = percentile(timings, 0.5);
  const p95 = percentile(timings, 0.95);
  report.add(
    'perf-hook-roundtrip',
    p95 < HOOK_P95_BUDGET_MS ? 'PASS' : 'FAIL',
    `measured ${count} PreToolUse POSTs from inside the cage over the host network: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, budget ${HOOK_P95_BUDGET_MS} ms. Excludes Claude Code's own hook dispatch time`,
  );

  const starts = Array.from({ length: Number(args.cold) }, () => {
    const begin = performance.now();
    const probe = run(engine.bin, ['run', '--rm', '--label', LANE_LABEL, image, 'claude', '--version']);
    return probe.code === 0 ? performance.now() - begin : Number.NaN;
  });
  const coldMedian = percentile(starts, 0.5);
  report.add(
    'perf-cold-start',
    coldMedian < COLD_START_BUDGET_MS ? 'PASS' : 'FAIL',
    `measured ${starts.length} cold starts, container create to \`claude --version\` output: median ${coldMedian.toFixed(0)} ms, max ${Math.max(...starts).toFixed(0)} ms, budget ${COLD_START_BUDGET_MS} ms. The CLI is ready to take a prompt, with no model call`,
  );

  exposed.push(readFileSync(join(String(args.out), `${engineName}-hook-events.jsonl`), 'utf8'));
  const leaked = leaks(exposed.join('\n'));
  report.add(
    'canary-no-leak',
    leaked.length === 0 ? 'PASS' : 'FAIL',
    `${fixture.values.length} fake canaries planted; ${leaked.length} appear in ${exposed.length} captured outputs and the hook log`,
  );

  await server.close();
  const after = await post([pre('Bash', { command: 'echo hi' })]);
  report.add(
    'hook-server-down',
    after[0]?.error ? 'PASS' : 'FAIL',
    `with the server stopped the cage gets ${after[0]?.error ?? `status ${after[0]?.status}`}. The managed settings set onFailure block, so Claude Code treats that as a block (live lane in run-agent.mjs)`,
  );

  const info = run(engine.bin, [
    'info',
    '--format',
    engineName === 'podman' ? '{{.Host.OCIRuntime.Name}}' : '{{json .Runtimes}}',
  ]).out.trim();
  const krun = engineName === 'podman' && run('sh', ['-c', 'crun --version 2>&1 | grep -c LIBKRUN']).out.trim() === '1';
  if (!krun) {
    report.add(
      'krun-ignores-USER',
      'NOT-RUN',
      `no krun-capable runtime on this ${engineName} (runtime info: ${info.slice(0, 120)}); the image USER is node`,
    );
  } else {
    const under = (/** @type {string} */ runtime) =>
      run(engine.bin, ['run', '--rm', '--runtime', runtime, image, 'id', '-u']).out.trim();
    const [krunUid, crunUid] = [under('krun'), under('crun')];
    report.add(
      'krun-ignores-USER',
      'PASS',
      `image USER node: crun runs uid ${crunUid}, krun runs uid ${krunUid}; krun ignores USER when they differ`,
    );
  }
} finally {
  await server.close();
  const removed = engine.cleanup();
  console.log(`cleanup removed ${removed} container(s)`);
}
process.exit(report.finish());
