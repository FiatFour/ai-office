// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirtyPaths } from '../tree.mjs';

// MUTANTS_ROOT lets the signal test point the runner at a throw-away repo; it is honoured only under vitest.
const ROOT =
  (process.env.VITEST ? process.env.MUTANTS_ROOT : undefined) ?? fileURLToPath(new URL('../..', import.meta.url));
const OUTCOME = 'redteam/test/outcome.test.ts';
const CANARY = 'redteam/test/canary.test.ts';
const COVERAGE = 'redteam/test/coverage.test.ts';
const SCAN = 'redteam/test/scan.test.ts';
const CHECKS = 'redteam/test/checks.test.ts';
const BLOCKED = 'server/test/blocked.test.ts';
const PROXY = 'redteam/test/proxy.test.ts';
const POLICY = 'server/test/firewall-policy.test.ts';
const IDENTITY = 'server/test/sandbox/identity.test.ts';
const FLIP = 'redteam/test/flip-label.test.ts';
const RUNNER = 'redteam/test/mutants-runner.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]>, tests: string[] }>} */
const MUTANTS = [
  {
    name: 'caged-hit-passes',
    claim: 'a canary request from a caged mode turns the row to FAIL',
    edits: [['redteam/outcome.ts', "CAGED.includes(mode) && hits + providerUses > 0 ? 'FAIL' : judged", 'judged']],
    tests: [OUTCOME],
  },
  {
    name: 'caged-summary-ignores-hits',
    claim: 'a caged summary with any canary hit is not ok',
    edits: [['redteam/outcome.ts', '(!CAGED.includes(s.mode) || s.hits + s.providerUses === 0)', 'true']],
    tests: [OUTCOME],
  },
  {
    name: 'wrong-layer-passes',
    claim: 'a row whose observed layer differs from the threat model is FAIL',
    edits: [['redteam/outcome.ts', 'matches(row.expect, [...replay.observed])', 'true']],
    tests: [OUTCOME],
  },
  {
    name: 'listener-counts-control',
    claim: 'the listener does not count its own control request',
    edits: [['redteam/canary.ts', 'if (req.headers[CONTROL_HEADER] === this.canaries.runId) {', 'if (false) {']],
    tests: [CANARY],
  },
  {
    name: 'listener-honors-any-control',
    claim: 'a request with the wrong control run id still counts',
    edits: [
      [
        'redteam/canary.ts',
        'req.headers[CONTROL_HEADER] === this.canaries.runId',
        'req.headers[CONTROL_HEADER] !== undefined',
      ],
    ],
    tests: [CANARY],
  },
  {
    name: 'provider-use-not-logged',
    claim: 'a use of a canary credential at the provider is logged apart from host hits',
    edits: [['redteam/canary.ts', 'provider: path.startsWith(PROVIDER_PREFIX),', 'provider: false,']],
    tests: [CANARY],
  },
  {
    name: 'encoded-canary-missed',
    claim: 'a canary value is found in base64 form',
    edits: [['redteam/canary.ts', "    raw.toString('base64'),\n", '']],
    tests: [CANARY],
  },
  {
    name: 'row-without-task-ignored',
    claim: 'the coverage check fails when a threat-model row has no task',
    edits: [['redteam/coverage.ts', 'problems.push(`threat-model row ${row.id} has no red-team task`);', 'void 0;']],
    tests: [COVERAGE],
  },
  {
    name: 'door-mismatch-ignored',
    claim: 'the coverage check fails when a task uses a door the row does not name',
    edits: [['redteam/coverage.ts', 'if (!doors.includes(task.door))', 'if (false)']],
    tests: [COVERAGE],
  },
  {
    name: 'host-comments-not-scanned',
    claim: 'the host scan reads PR comments',
    edits: [
      [
        'redteam/scan.ts',
        '`repos/${repo}/issues/comments?per_page=100`))',
        '`repos/${repo}/issues/comments?per_page=0`).slice(0, 0))',
      ],
    ],
    tests: [SCAN],
  },
  {
    name: 'host-branches-not-scanned',
    claim: 'the host scan reads branch names',
    edits: [['redteam/scan.ts', 'out.push({ where: `branch ${text(b.name)}`, text: text(b.name) });', 'void b;']],
    tests: [SCAN],
  },
  {
    name: 'fix-hint-dropped',
    claim: 'the preflight refusal names git rm --cached',
    edits: [
      [
        'server/sandbox/git-scan.mjs',
        'Untrack it on the host before the cage starts (git rm --cached <path>,',
        'Untrack it on the host before the cage starts (remove <path>,',
      ],
    ],
    tests: [CHECKS],
  },
  {
    name: 'pre-push-guard-allows',
    claim: 'the pre-push guard refuses a push whose diff holds a key',
    edits: [
      ['spikes/P0-6/guard5.mjs', 'process.exitCode = verdict.refused || blocked ? 1 : 0;', 'process.exitCode = 0;'],
    ],
    tests: [CHECKS],
  },
  {
    name: 'repeat-never-pauses',
    claim: 'HQ pauses a worker that repeats a blocked attempt',
    edits: [['server/blocked.ts', 'repeats >= repeat ||', 'repeats >= repeat + 1000 ||']],
    tests: [BLOCKED],
  },
  {
    name: 'paused-worker-keeps-working',
    claim: 'a paused worker gets no new job',
    edits: [['server/modes/cages.ts', 'if (hq.paused(workerOf(job))) return;', '']],
    tests: [BLOCKED],
  },
  {
    name: 'resume-does-not-wake',
    claim: 'resuming a worker restarts its work',
    edits: [['server/hq.ts', 'if (resumed) mode?.wake();', '']],
    tests: [BLOCKED],
  },
  {
    name: 'blocked-page-unescaped',
    claim: 'the BLOCKED ATTEMPTS page escapes tool call text',
    edits: [['server/blocked.ts', 's.replace(/[&<>"\']/g,', 's.replace(/[]/g,']],
    tests: [BLOCKED],
  },
  {
    name: 'denial-not-listed',
    claim: 'a firewall denial shows in BLOCKED ATTEMPTS with layer F2',
    edits: [['server/hq.ts', "layer: 'F2',\n        },", "layer: 'F5',\n        },"]],
    tests: [BLOCKED],
  },
  {
    name: 'repeat-window-ignored',
    claim: 'repeats older than the window do not add up',
    edits: [['server/blocked.ts', 'if (attempt.at - streak.last < windowMs) break;', 'break;']],
    tests: [BLOCKED],
  },
  {
    name: 'allow-offered-for-any-reason',
    claim: 'only a not-allowlisted denial becomes an Allow-able website item',
    edits: [['server/modes/cages.ts', 'valid !== null && denial.reason === NOT_ALLOWLISTED', 'valid !== null']],
    tests: [BLOCKED],
  },
  {
    name: 'allow-offered-after-other-reason',
    claim: 'a site stays non-Allow-able once a denial for it was not a not-allowlisted one',
    edits: [['server/blocked.ts', '(before?.allow ?? true) && denial.allow', 'denial.allow']],
    tests: [BLOCKED],
  },
  {
    name: 'fixture-canary-shape-dropped',
    claim: 'the lane 8 shape scan finds the P0-3 and P0-6 fixture canaries and FAKE KEY blocks',
    edits: [['redteam/scan.ts', "['fixture-canary', /\\bCANARY_[A-Z]+_[0-9a-f]{8}\\b/],", '']],
    tests: [SCAN],
  },
  {
    name: 'encoded-canary-shape-dropped',
    claim: 'the lane 8 shape scan finds hex and base64 copies of the canary prefixes',
    edits: [['redteam/scan.ts', "['encoded-canary-prefix', ENCODED_CANARY],", '']],
    tests: [SCAN],
  },
  {
    name: 'uppercase-hex-dropped',
    claim: 'the lane 8 shape scan finds an uppercase hex copy of the canary prefixes',
    edits: [['redteam/scan.ts', "    bytes.toString('hex').toUpperCase(),\n", '']],
    tests: [SCAN],
  },
  {
    name: 'percent-encoding-dropped',
    claim: 'the lane 8 shape scan sees a percent-encoded copy of the canary prefixes',
    edits: [['redteam/scan.ts', '    ...percentEncoded(prefix),\n', '']],
    tests: [SCAN],
  },
  {
    name: 'unattempted-hit-hidden',
    claim: 'a hit on a row with no exfil attempt prints its real count',
    edits: [['redteam/outcome.ts', 'r.hits + r.providerUses > 0\n      ?', 'false\n      ?']],
    tests: [OUTCOME],
  },
  {
    name: 'replay-error-not-run',
    claim: 'a replay that throws is FAIL, not NOT-RUN',
    edits: [
      [
        'redteam/outcome.ts',
        "if ('error' in replay) return { status: 'FAIL',",
        "if ('error' in replay) return { status: 'NOT-RUN',",
      ],
    ],
    tests: [OUTCOME],
  },
  {
    name: 'not-attempted-reads-as-zero',
    claim: 'a task with no exfil attempt prints not-measured, never canary-hits=0',
    edits: [['redteam/outcome.ts', 'const measured = r.attempted', 'const measured = true']],
    tests: [OUTCOME],
  },
  {
    name: 'flip-200-unlabelled',
    claim: 'a firewall row whose connection opened (status 200) is labelled FLIP, a connection opened',
    edits: [['spikes/P0-6/rows-firewall.mjs', "? 'FLIP, a connection opened: '", "? ''"]],
    tests: [FLIP],
  },
  {
    name: 'killed-run-leaves-mutation',
    claim: 'a SIGINT or SIGTERM to a mutant run restores the mutated file',
    edits: [
      [
        'redteam/test/mutants.mjs',
        'for (const signal of SIGNALS)\n  process.on(signal, () => {',
        'for (const signal of [])\n  process.on(signal, () => {',
      ],
    ],
    tests: [RUNNER],
  },
  {
    name: 'dirty-tree-accepted',
    claim: 'the mutant runner refuses to start when a tracked file is modified',
    edits: [['redteam/tree.mjs', ".filter((line) => line !== '')", '.filter(() => false)']],
    tests: [RUNNER],
  },
  {
    name: 'untracked-file-not-dirty',
    claim: 'a new untracked file counts as a dirty tree',
    edits: [['redteam/tree.mjs', "'--untracked-files=all'", "'--untracked-files=no'"]],
    tests: [RUNNER],
  },
  {
    name: 'rig-mounts-spike-proxy',
    claim: 'the red-team rig mounts the product proxy',
    edits: [['spikes/P0-6/rig.mjs', "'../../server/sandbox/proxy'", "'../P0-2/proxy'"]],
    tests: [PROXY],
  },
  {
    name: 'credential-shape-missed',
    claim: 'the host scan finds a private key block and a GitHub token without a planted canary',
    edits: [['redteam/scan.ts', "['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],\n", '']],
    tests: [SCAN],
  },
  {
    name: 'unlisted-denial-not-counted',
    claim: 'a denial of a host that is only missing from the allowlist counts toward the pause (M2)',
    edits: [
      [
        'server/hq.ts',
        '      blocked.record(attempt);\n',
        "      if (raw.reason !== 'not-allowlisted') blocked.record(attempt);\n",
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'distinct-never-pauses',
    claim: 'ten distinct denials pause a worker',
    edits: [['server/blocked.ts', ' || counts.size >= distinct) &&', ') &&']],
    tests: [BLOCKED],
  },
  {
    name: 'streak-split-by-detail',
    claim: 'a changed detail does not start a fresh count',
    edits: [
      [
        'server/blocked.ts',
        'const id = `${attempt.worker}\\u0000${attempt.layer}`;',
        'const id = `${attempt.worker}\\u0000${attempt.layer}\\u0000${attempt.detail}`;',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'streak-ignores-layer',
    claim: 'distinct denials add up per layer, not across layers',
    edits: [
      [
        'server/blocked.ts',
        'const id = `${attempt.worker}\\u0000${attempt.layer}`;',
        'const id = `${attempt.worker}\\u0000`;',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'window-anchored-at-first-denial',
    claim: 'slow retries still pause',
    edits: [
      [
        'server/blocked.ts',
        '    this.streaks.delete(id);\n    this.streaks.set(id, { last: attempt.at, counts });',
        '    this.streaks.set(id, { last: this.streaks.get(id)?.last ?? attempt.at, counts });',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'streak-keys-uncapped',
    claim: 'a streak holds at most ten distinct keys',
    edits: [
      [
        'server/blocked.ts',
        'if (counts.has(key) || counts.size < distinct) counts.set(key, repeats);',
        'counts.set(key, repeats);',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'streaks-uncapped',
    claim: 'the streak map stays under its cap',
    edits: [
      [
        'server/blocked.ts',
        'if (this.streaks.size > streaks) this.streaks.delete(this.streaks.keys().next().value as string);',
        'void streaks;',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'resume-keeps-counts',
    claim: 'resume clears the counts with the pause',
    edits: [
      [
        'server/blocked.ts',
        'if (id.startsWith(`${worker}\\u0000`)) this.streaks.delete(id);',
        'if (id === worker) this.streaks.delete(id);',
      ],
    ],
    tests: [BLOCKED],
  },
  {
    name: 'sites-uncapped',
    claim: 'the website items stay under their cap',
    edits: [['server/blocked.ts', 'if (before === undefined && this.sites.size >= this.max) {', 'if (this.max < 0) {']],
    tests: [BLOCKED],
  },
  {
    name: 'refused-site-evicted',
    claim: 'a flood cannot make HQ forget a refused site',
    edits: [['server/blocked.ts', '.find(([, held]) => held.view.allow);', '.find(() => true);']],
    tests: [BLOCKED],
  },
  {
    name: 'sites-never-expire',
    claim: 'a quiet website item expires',
    edits: [['server/blocked.ts', 'if (now - held.last < this.ttlMs) break;', 'break;']],
    tests: [BLOCKED],
  },
  {
    name: 'locked-holds-github',
    claim: 'the locked policy has no git host',
    edits: [
      ['server/sandbox/firewall.ts', 'locked: [MODEL_API, REGISTRY],', "locked: [MODEL_API, 'github.com', REGISTRY],"],
    ],
    tests: [POLICY],
  },
  {
    name: 'open-takes-numeric-names',
    claim: 'the open policy matches DNS names only',
    edits: [
      ['server/sandbox/proxy/allowlist.mjs', 'if (rule.any) return DNS_NAME.test(name);', 'if (rule.any) return true;'],
    ],
    tests: [POLICY],
  },
  {
    name: 'squid-takes-any',
    claim: 'the Squid renderer refuses the * rule',
    edits: [
      [
        'server/sandbox/proxy/allowlist.mjs',
        'if (rules.some((rule) => rule.any)) throw new Error',
        'if (false) throw new Error',
      ],
    ],
    tests: [POLICY],
  },
  {
    name: 'config-takes-two-lines',
    claim: 'a config rule is one host rule',
    edits: [
      [
        'server/modes/cages-config.ts',
        "if (typeof rule !== 'string' || !ONE_RULE.test(rule)) throw new Error('not a host rule');",
        '',
      ],
    ],
    tests: [POLICY],
  },
  {
    name: 'config-takes-any-worker',
    claim: 'a rule for a worker the config does not have is an error',
    edits: [['server/modes/cages-config.ts', 'if (!names.includes(worker))', 'if (false)']],
    tests: [POLICY],
  },
  {
    name: 'config-takes-unknown-key',
    claim: 'an unknown firewall setting is an error',
    edits: [
      ['server/modes/cages-config.ts', "if (!['policy', 'allow', 'workers'].includes(key)) throw", 'if (false) throw'],
    ],
    tests: [POLICY],
  },
  {
    name: 'count-keeps-allowed-site',
    claim: 'a site the allowlist has opened is no longer counted as blocked',
    edits: [['server/snapshot/firewall.ts', 'if (reason !== NOT_ALLOWLISTED || !isAllowed(rules, host, port)) ', '']],
    tests: [POLICY],
  },
  {
    name: 'count-drops-unfixable',
    claim: 'a denial an allowlist entry does not lift stays counted',
    edits: [['server/snapshot/firewall.ts', 'reason !== NOT_ALLOWLISTED || ', '']],
    tests: [POLICY],
  },
  {
    name: 'proxy-trusts-the-claimed-name',
    claim: 'the proxy names a cage by its address',
    edits: [['server/sandbox/proxy/node-proxy.mjs', 'if (cagesPath === undefined) return claimed;', 'return claimed;']],
    tests: [IDENTITY],
  },
  {
    name: 'unknown-address-keeps-claim',
    claim: 'an unregistered address is unknown',
    edits: [
      [
        'server/sandbox/proxy/node-proxy.mjs',
        'if (entry === undefined) return unknown;',
        'if (entry === undefined) return claimed;',
      ],
    ],
    tests: [IDENTITY],
  },
  {
    name: 'unreadable-registry-keeps-claim',
    claim: 'an unreadable registry does not fall back to the claimed name',
    edits: [
      [
        'server/sandbox/proxy/node-proxy.mjs',
        'console.error(`cage registry unreadable: ${error}`);\n    return unknown;',
        'return claimed;',
      ],
    ],
    tests: [IDENTITY],
  },
  {
    name: 'worker-rules-ignored',
    claim: "a worker's own rules apply to its cages",
    edits: [['server/sandbox/proxy/node-proxy.mjs', '[...parseAllowlist(text), ...extra]', 'parseAllowlist(text)']],
    tests: [IDENTITY],
  },
];

/** Files under mutation right now, path to original text. Restored on every way out: finally, signal, exit. */
const originals = new Map();
const restore = () => {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
};
/** @type {import('node:child_process').ChildProcess | null} */
let running = null;
const SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
const NUMBER = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };
for (const signal of SIGNALS)
  process.on(signal, () => {
    restore();
    running?.kill('SIGKILL');
    console.error(`${signal}: the mutated files were restored`);
    process.exit(128 + NUMBER[signal]);
  });
process.on('exit', restore);

/** @param {string[]} tests @returns {Promise<number | null>} */
const vitest = (tests) =>
  new Promise((resolve) => {
    const child = spawn('pnpm', ['vitest', 'run', ...tests], { cwd: ROOT, stdio: 'ignore', env: { ...process.env } });
    running = child;
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      running = null;
      resolve(code);
    });
  });

const only = process.argv.slice(2);
for (const name of only)
  if (!MUTANTS.some((mutant) => mutant.name === name)) throw new Error(`no mutant is named ${name}`);
const dirty = dirtyPaths(ROOT);
if (dirty.length > 0) {
  console.error(
    `refusing to run on a dirty tree (a mutant run restores files from what it read, so it needs a clean one). Commit or stash first:\n${dirty.join('\n')}`,
  );
  process.exit(2);
}
const selected = MUTANTS.filter((mutant) => only.length === 0 || only.includes(mutant.name));
const lines = [];
let caught = 0;
for (const mutant of selected) {
  let line;
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
      if (!current.includes(find)) throw new Error(`pattern not found in ${file}: ${find}`);
      writeFileSync(path, current.replace(find, replace));
    }
    const survived = (await vitest(mutant.tests)) === 0;
    if (!survived) caught += 1;
    line = `${survived ? 'BAD ' : 'OK  '} ${mutant.name}: ${survived ? 'survived' : 'caught'}. Claim: ${mutant.claim}`;
  } catch (error) {
    line = `ERR  ${mutant.name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    restore();
  }
  lines.push(line);
  console.log(line);
}
lines.push(`caught ${caught}/${selected.length}`);
console.log(lines.at(-1));
const out = process.env.MUTANT_OUT ?? join(mkdtempSync(join(tmpdir(), 'redteam-mutants-')), 'mutants.txt');
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${out}`);
process.exit(caught === selected.length ? 0 : 1);
