import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DRIVER = 'server/test/sandbox/driver.test.ts';

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
        'const id = repoIdFrom(remote, spec.path);',
        'const id = repoIdFrom(remote, spec.path) + factory.id;',
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
