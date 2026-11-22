// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOST = 'test/contract/githost.recorded.test.ts';
const SANDBOX = 'test/contract/sandbox.real.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[string, string, string]>, test: string, caught: string[] }>} */
const MUTANTS = [
  {
    name: 'find-comment-trusts-any-author',
    claim: 'a marker comment written by another account is not trusted',
    edits: [
      [
        'server/githost/github.ts',
        "(c) => str(c, 'user.login').toLowerCase() === self && str(c, 'body')",
        "(c) => str(c, 'body')",
      ],
    ],
    test: HOST,
    caught: ['a-marker-from-another-account-is-ignored-on-any-page'],
  },
  {
    name: 'pages-stop-after-the-first',
    claim: 'every page of a host listing is read',
    edits: [['server/githost/host.ts', 'if (list.length < PAGE_SIZE) return all;', 'return all;']],
    test: HOST,
    caught: ['every-changed-path-is-listed-across-pages', 'every-page-of-review-comments-is-read'],
  },
  {
    name: 'branch-prefix-not-enforced',
    claim: 'a push to a branch outside aw/<factory>/<task> is refused',
    edits: [
      [
        'server/githost/host.ts',
        "typeof branch === 'string' && BRANCH.test(branch)\n    ? null",
        "typeof branch === 'string'\n    ? null",
      ],
    ],
    test: HOST,
    caught: ['a-branch-outside-the-aw-prefix-is-refused'],
  },
  {
    name: 'push-always-commits',
    claim: 'pushing files the branch already holds writes nothing',
    edits: [['server/githost/github.ts', 'if (changed.length === 0) return parent;', '']],
    test: HOST,
    caught: ['push-and-open-are-idempotent'],
  },
  {
    name: 'signature-always-valid',
    claim: 'a webhook body that does not match its signature is refused',
    edits: [
      [
        'server/githost/host.ts',
        'return expected.length === actual.length && timingSafeEqual(expected, actual);',
        'return true;',
      ],
    ],
    test: HOST,
    caught: ['a-github-signature-is-checked'],
  },
  {
    name: 'cage-keeps-capabilities',
    claim: 'the cage and the throwaway drop every capability',
    edits: [['server/sandbox/firewall.ts', "  '--cap-drop',\n  'ALL',\n", '']],
    test: SANDBOX,
    caught: ['cage-is-hardened', 'throwaway-has-no-network-and-is-hardened'],
  },
  {
    name: 'cage-root-writable',
    claim: 'the cage root filesystem is read-only',
    edits: [['server/sandbox/firewall.ts', "  '--read-only',\n", '']],
    test: SANDBOX,
    caught: ['cage-is-hardened', 'throwaway-has-no-network-and-is-hardened'],
  },
  {
    name: 'throwaway-has-network',
    claim: 'the throwaway container has no network',
    edits: [
      [
        'server/sandbox/container.ts',
        "        '--network',\n        'none',\n        ...hardenedArgs(),",
        '        ...hardenedArgs(),',
      ],
    ],
    test: SANDBOX,
    caught: ['throwaway-has-no-network-and-is-hardened'],
  },
  {
    name: 'protected-files-kept',
    claim: 'every protected file is removed from the export',
    edits: [
      [
        'server/sandbox/export.ts',
        "const removed = findProtected(dest, { home: '/nonexistent', cwd: dest });",
        'const removed = [];',
      ],
    ],
    test: SANDBOX,
    caught: ['export-is-sanitized', 'every-protected-file-is-removed'],
  },
  {
    name: 'cage-source-accepted',
    claim: 'a cage workdir is never an export source',
    edits: [['server/sandbox/container.ts', 'if (insideCage(this.home, spec.source))', 'if (false)']],
    test: SANDBOX,
    caught: ['cage-workdir-is-refused-as-a-source'],
  },
  {
    name: 'remove-all-keeps-the-firewall',
    claim: 'removeAll takes the firewall network and proxy down',
    edits: [
      [
        'server/sandbox/container.ts',
        '    await lowerFirewall(this.engine, this.project, this.hq);\n    const networks',
        '    const networks',
      ],
    ],
    test: SANDBOX,
    caught: ['remove-all-leaves-nothing'],
  },
  {
    name: 'missing-image-hint-dropped',
    claim: 'a missing image names the build command',
    edits: [['server/sandbox/container.ts', 'Build it with: ${this.engine.name} build -t ${this.image}', 'Build it.']],
    test: SANDBOX,
    caught: ['a-missing-image-names-the-build-command'],
  },
];

const only = process.argv.slice(2);
const selected = MUTANTS.filter((mutant) => only.length === 0 || only.includes(mutant.name));
for (const name of only)
  if (!MUTANTS.some((mutant) => mutant.name === name)) throw new Error(`no mutant is named ${name}`);

const lines = [];
let caught = 0;
for (const mutant of selected) {
  const originals = new Map();
  let line;
  try {
    for (const [file, find, replace] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
      if (!current.includes(find)) throw new Error(`pattern not found in ${file}: ${find}`);
      writeFileSync(path, current.replace(find, replace));
    }
    const run = spawnSync('pnpm', ['vitest', 'run', mutant.test], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    const output = `${run.stdout}${run.stderr}`;
    const failing = mutant.caught.filter((id) => new RegExp(`(×|✗|FAIL)[^\\n]*${id}`).test(output));
    const ok = run.status !== 0 && failing.length === mutant.caught.length;
    if (ok) caught += 1;
    line = `${ok ? 'OK  ' : 'BAD '} ${mutant.name}: ${ok ? 'caught by' : `survived or the wrong case failed, wanted ${mutant.caught.join(', ')}, saw failing`} ${failing.join(', ') || 'nothing'}. Claim: ${mutant.claim}`;
  } catch (error) {
    line = `ERR  ${mutant.name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
  lines.push(line);
  console.log(line);
}
lines.push(`caught ${caught}/${selected.length}`);
console.log(lines.at(-1));
const out = process.env.MUTANT_OUT ?? join(mkdtempSync(join(tmpdir(), 'contract-mutants-')), 'mutants.txt');
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${out}`);
process.exit(caught === selected.length ? 0 : 1);
