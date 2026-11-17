import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DRIVER = 'server/test/sandbox/driver.test.ts';
const EXPORT = 'server/test/sandbox/export.test.ts';
const REGISTRY = 'server/test/registry.test.ts';
const ATOMIC = 'server/test/atomic.test.ts';
const STORE = 'server/test/store.test.ts';
const HQ = 'server/test/hq.test.ts';
const CLI = 'server/test/cli.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]>, tests: string[], survives?: boolean }>} */
const MUTANTS = [
  {
    name: 'prune-live-head',
    claim: 'the head a change has now is never pruned',
    edits: [['server/store/prune.ts', 'return !superseded.has(sha) || live.has(sha);', 'return !superseded.has(sha);']],
    tests: ['server/test/store.test.ts'],
  },
  {
    name: 'prune-never',
    claim: 'facts of a replaced head are pruned',
    edits: [['server/store/prune.ts', 'if (superseded.size === 0) return state;', 'return state;']],
    tests: ['server/test/store.test.ts'],
  },
  {
    name: 'hq-any-host',
    claim: 'a foreign Host header is refused',
    edits: [['server/hq.ts', "if (!allowedHosts().has(req.headers.host ?? '')) return false;", '']],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'hq-any-origin',
    claim: 'a foreign Origin header is refused',
    edits: [
      [
        'server/hq.ts', // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text being mutated
        'return origin === undefined || origin === `http://${req.headers.host}`;',
        'return true;',
      ],
    ],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'event-no-host-time',
    claim: 'a change fact without host time is refused',
    edits: [
      [
        'server/events.ts',
        "headSha: str(o, 'headSha'),\n  at: num(o, 'at'),\n});",
        "headSha: str(o, 'headSha'),\n  at: 0,\n});",
      ],
    ],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'hq-no-rev-on-registry',
    claim: 'each registry change raises the pushed revision',
    edits: [['server/hq.ts', 'if (created) ledger.bump();', '']],
    tests: ['server/test/hq.test.ts'],
  },
  {
    name: 'registry-repo-per-factory',
    claim: 'one repo shared by two factories keeps one entry',
    edits: [
      [
        'server/registry.ts',
        ': repoIdFrom(remote, real);',
        ': repoIdFrom(remote, real) + factory.id;',
      ],
    ],
    tests: ['server/test/registry.test.ts'],
  },
  {
    name: 'doctor-exit-zero',
    claim: 'doctor exits 1 on a FAIL',
    edits: [
      [
        'server/preflight/checks.ts',
        "checks.some((c) => c.status === 'FAIL') ? 1 : 0",
        "checks.some((c) => c.status === 'FAIL') ? 0 : 0",
      ],
    ],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'doctor-rootful-passes',
    claim: 'rootful podman fails the doctor',
    edits: [['server/preflight/checks.ts', "usable.name === 'podman' && usable.info?.rootless !== true", 'false']],
    tests: ['server/test/preflight.test.ts'],
  },
  {
    name: 'cage-not-hardened',
    claim: 'the cage runs with all caps dropped, no-new-privileges and a read-only root',
    edits: [['server/sandbox/container.ts', 'firewall.internal,\n        ...hardenedArgs(),', 'firewall.internal,']],
    tests: [DRIVER],
  },
  {
    name: 'cage-root-user',
    claim: 'the cage runs as the host user',
    edits: [['server/sandbox/container.ts', "'4g',\n        ...(await this.user()),", "'4g',"]],
    tests: [DRIVER],
  },
  {
    name: 'network-not-internal',
    claim: 'the cage network has no route out',
    edits: [['server/sandbox/firewall.ts', "'--internal', ...harden,", '...harden,']],
    tests: [DRIVER],
  },
  {
    name: 'network-keeps-host-gateway',
    claim: 'a cage cannot reach a host service through the bridge gateway',
    edits: [
      [
        'server/sandbox/firewall.ts',
        "const harden = engine.name === 'docker' ? ['-o', 'com.docker.network.bridge.inhibit_ipv4=true'] : [];",
        'const harden: string[] = [];',
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'proxy-allows-all',
    claim: 'the proxy denies a host that is not on the allowlist',
    edits: [
      [
        'server/sandbox/proxy/node-proxy.mjs',
        'if (target === null || !isAllowed(rules, target.host, target.port)) {',
        'if (target === null) {',
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'export-keeps-secrets',
    claim: 'a tracked .env never reaches the cage (the contained scan refuses it)',
    edits: [
      ['server/sandbox/export.ts', 'for (const path of removed) rmSync(path, { recursive: true, force: true });', ''],
    ],
    tests: [DRIVER],
  },
  {
    name: 'export-keeps-secrets-and-scan-off',
    claim: 'a tracked .env never reaches the cage (the canary grep sees it)',
    edits: [
      ['server/sandbox/export.ts', 'for (const path of removed) rmSync(path, { recursive: true, force: true });', ''],
      ['server/sandbox/container.ts', 'if (!scan.clean) throw new CageError', 'if (false) throw new CageError'],
    ],
    tests: [DRIVER],
  },
  {
    name: 'scan-off-alone',
    claim: 'the contained scan is a second layer, invisible while sanitising works',
    edits: [['server/sandbox/container.ts', 'if (!scan.clean) throw new CageError', 'if (false) throw new CageError']],
    tests: [DRIVER],
    survives: true,
  },
  {
    name: 'throwaway-has-network',
    claim: 'the throwaway container has no network',
    edits: [['server/sandbox/container.ts', "'--network',\n        'none',", "'--network',\n        'bridge',"]],
    tests: [DRIVER],
  },
  {
    name: 'mask-first-only',
    claim: 'every protected file is removed from the export, not the first one found',
    edits: [
      [
        'server/sandbox/export.ts',
        "findProtected(dest, { home: '/nonexistent', cwd: dest })",
        "findProtected(dest, { home: '/nonexistent', cwd: dest }, 1)",
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'scan-unparseable-is-clean',
    claim: 'a scan that cannot be read fails closed',
    edits: [
      [
        'server/sandbox/export.ts',
        '      clean: false,\n      issues: [`the contained scan failed',
        '      clean: true,\n      issues: [`the contained scan failed',
      ],
    ],
    tests: [EXPORT],
  },
  {
    name: 'export-on-host',
    claim: 'the source is never read by host git, so a smudge filter in it cannot run on the host',
    edits: [
      [
        'server/sandbox/export.ts',
        '  const archived = await throwaway(',
        "  await new Promise<void>((done) => { execFile('git', ['-C', source, 'archive', '--format=tar', '-o', `${dest}.tar`, 'HEAD'], () => done()); });\n  const archived = await throwaway(",
      ],
      [
        'server/sandbox/export.ts',
        'import { mkdirSync,',
        "import { execFile } from 'node:child_process';\nimport { mkdirSync,",
      ],
    ],
    tests: [DRIVER],
  },
  {
    name: 'cage-source-not-refused',
    claim: 'a cage workdir is never an export source',
    edits: [['server/sandbox/container.ts', 'if (insideCage(this.home, spec.source))', 'if (false)']],
    tests: [DRIVER],
  },
  {
    name: 'cage-cwd-not-refused',
    claim: 'the CLI does not run from inside a cage',
    edits: [['server/cli.ts', 'if (insideCage(home, path))', 'if (false)']],
    tests: [CLI],
  },
  {
    name: 'home-slug-only',
    claim: 'two worker names that slug alike get different homes',
    edits: [
      [
        'server/sandbox/container.ts',
        "return `${slug(worker) || 'worker'}-${createHash('sha256').update(worker).digest('hex').slice(0, 24)}`;",
        'return slug(worker);',
      ],
    ],
    tests: [EXPORT],
  },
  {
    name: 'registry-no-realpath',
    claim: 'a symlinked path is the same factory and the same clone',
    edits: [['server/registry.ts', 'caseKey(realpathSync(resolve(path)))', 'caseKey(resolve(path))']],
    tests: [REGISTRY],
  },
  {
    name: 'registry-new-path-overwrites-shared',
    claim: 'a second clone of a shared repo does not replace the first clone path',
    edits: [['server/registry.ts', 'const repo = existing ?? {', 'const repo = {']],
    tests: [REGISTRY],
  },
  {
    name: 'registry-same-clone-two-ids',
    claim: 'one clone keeps one id with and without a remote',
    edits: [
      [
        'server/registry.ts',
        'const known = Object.values(this.repos).find(',
        'const known = undefined as RepoEntry | undefined; void Object.values(this.repos).find(',
      ],
    ],
    tests: [REGISTRY],
  },
  {
    name: 'atomic-no-rename',
    claim: 'a state file is replaced by rename, never rewritten in place',
    edits: [['server/store/atomic.ts', 'const temp = `${path}.${process.pid}.tmp`;', 'const temp = path;']],
    tests: [ATOMIC],
  },
  {
    name: 'atomic-no-fsync',
    claim: 'the new file is synced before the rename',
    edits: [['server/store/atomic.ts', '    writeSync(fd, data);\n    fsyncSync(fd);', '    writeSync(fd, data);']],
    tests: [ATOMIC],
  },
  {
    name: 'atomic-no-dirsync',
    claim: 'the directory is synced after the rename',
    edits: [['server/store/atomic.ts', '      syncDirectory(dirname(path));\n', '']],
    tests: [ATOMIC],
  },
  {
    name: 'store-sync-off',
    claim: 'every SQLite commit is synced to disk',
    edits: [['server/store/store.ts', "'PRAGMA synchronous = FULL'", "'PRAGMA synchronous = OFF'"]],
    tests: [STORE],
  },
  {
    name: 'store-journal-delete',
    claim: 'SQLite commits through the write-ahead log',
    edits: [['server/store/store.ts', "'PRAGMA journal_mode = WAL'", "'PRAGMA journal_mode = DELETE'"]],
    tests: [STORE],
  },
  {
    name: 'store-no-checksum',
    claim: 'a changed event body is detected',
    edits: [['server/store/store.ts', 'if (sumOf(seq, body) !== row.sum) throw', 'if (false) throw']],
    tests: [STORE],
  },
  {
    name: 'store-no-gap-check',
    claim: 'a missing event is detected',
    edits: [
      ['server/store/store.ts', 'if (n > 0 && (Number(span?.low) !== 1 || Number(span?.high) !== n))', 'if (false)'],
    ],
    tests: [STORE],
  },
  {
    name: 'store-no-transaction',
    claim: 'an event and the state it produced are written together or not at all',
    edits: [
      ['server/store/store.ts', "this.db.exec('BEGIN IMMEDIATE');", ''],
      ['server/store/store.ts', "this.db.exec('COMMIT');", ''],
      ['server/store/store.ts', "this.db.exec('ROLLBACK');", ''],
    ],
    tests: [STORE],
  },
  {
    name: 'prune-keeps-none-closed',
    claim: 'closed commands are trimmed to the newest 200',
    edits: [['server/ledger.ts', 'const DONE_KEPT = 200;', 'const DONE_KEPT = 0;']],
    tests: [STORE],
  },
  {
    name: 'ws-no-push-on-repo',
    claim: 'a registered repo is pushed to the dashboard',
    edits: [['server/hq.ts', 'if (changed) ledger.bump();\n      push();', 'if (changed) ledger.bump();']],
    tests: [HQ],
  },
  {
    name: 'hq-bind-all',
    claim: 'HQ listens on loopback only',
    edits: [['server/hq.ts', "options.host ?? '127.0.0.1'", "options.host ?? '0.0.0.0'"]],
    tests: [HQ],
  },
  {
    name: 'hq-host-any-port',
    claim: 'a Host header must name the port HQ is bound to',
    edits: [
      [
        'server/hq.ts',
        "if (!allowedHosts().has(req.headers.host ?? '')) return false;",
        "if (!/^(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$/.test(req.headers.host ?? '')) return false;",
      ],
    ],
    tests: [HQ],
  },
  {
    name: 'cli-other-hq-unnamed',
    claim: 'a port held by another HQ is named as such',
    edits: [['server/cli.ts', "if (state.state === 'hq') {", 'if (false as boolean) {']],
    tests: [CLI],
  },
];

const only = process.argv.slice(2);
/** @param {string[]} tests */
const vitest = (tests) =>
  spawnSync('pnpm', ['vitest', 'run', ...tests], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 900_000,
  });

/** @type {string[]} */
const lines = [];
/** @param {string} line */
const log = (line) => {
  console.log(line);
  lines.push(line);
};

const baseline = vitest([...new Set(MUTANTS.flatMap((m) => m.tests))]);
log(`baseline ${baseline.status === 0 ? 'PASS' : 'FAIL'}`);
if (baseline.status !== 0) {
  console.error(baseline.stdout.slice(-2000));
  process.exit(1);
}

let bad = 0;
for (const mutant of MUTANTS) {
  if (only.length > 0 && !only.includes(mutant.name)) continue;
  const originals = new Map();
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const text = originals.get(path) ?? readFileSync(path, 'utf8');
      originals.set(path, text);
      const current = readFileSync(path, 'utf8');
      if (!current.includes(find)) throw new Error(`${mutant.name}: pattern not found in ${file}`);
      writeFileSync(path, current.replace(find, replace));
    }
    const result = vitest(mutant.tests);
    const caught = result.status !== 0;
    const expected = mutant.survives ? !caught : caught;
    if (!expected) bad += 1;
    log(
      `${expected ? 'OK  ' : 'BAD '} ${mutant.name}: ${caught ? 'caught' : 'survived'}${mutant.survives ? ' (expected to survive)' : ''}. Claim: ${mutant.claim}`,
    );
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/mutants.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
