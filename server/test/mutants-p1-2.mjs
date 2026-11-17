// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STORE = 'server/test/store.test.ts';
const CONTRACT = 'server/test/githost.contract.test.ts';
const CAGES = 'server/test/cages.test.ts';
const BRIEF = 'server/test/merge-brief.test.ts';
const AGENTS = 'server/test/agents.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string]>, tests: string[], survives?: boolean }>} */
const MUTANTS = [
  {
    name: 'id-without-epoch',
    claim: 'a rolled-back database never reissues a command id',
    edits: [['server/ledger.ts', 'id: `${epoch}.${seq}.${index}`,', 'id: `0.${seq}.${index}`,']],
    tests: [STORE],
  },
  {
    name: 'crash-not-an-attempt',
    claim: 'a run that never finished counts as an attempt',
    edits: [['server/ledger.ts', 'attempts: entry.attempts + 1 }));', 'attempts: entry.attempts }));']],
    tests: [STORE],
  },
  {
    name: 'crashed-command-left-pending',
    claim: 'a command that used its attempts while HQ died is marked given up on open',
    edits: [['server/ledger.ts', 'outbox: settle(loaded.outbox.map(crashed))', 'outbox: settle(loaded.outbox)']],
    tests: [STORE],
  },
  {
    name: 'guard-allows-any-write',
    claim: 'a write outside the allowlist, a merge included, is refused',
    edits: [
      [
        'server/githost/host.ts',
        'return rules.some(([m, pattern]) => m === method && pattern.test(pathname));',
        'return true;',
      ],
    ],
    tests: [CONTRACT],
  },
  {
    name: 'skipped-check-passes',
    claim: 'a skipped pipeline or check run never counts as passing',
    edits: [
      [
        'server/githost/host.ts',
        "const state = event.state === 'skipped' ? 'pending' : event.state;",
        "const state = event.state === 'skipped' ? 'success' : event.state;",
      ],
    ],
    tests: [CONTRACT],
  },
  {
    name: 'github-skipped-is-success',
    claim: 'a skipped GitHub check run parses as skipped',
    edits: [['server/githost/github.ts', "  skipped: 'skipped',", "  skipped: 'success',"]],
    tests: [CONTRACT],
  },
  {
    name: 'pr-number-zero',
    claim: 'a PR number must be a positive safe integer',
    edits: [
      [
        'server/githost/host.ts',
        'if (!Number.isSafeInteger(value) || (value as number) < 1)',
        'if (!Number.isInteger(value))',
      ],
    ],
    tests: [CONTRACT],
  },
  {
    name: 'poll-keeps-old-reviews',
    claim: 'a poll keeps only reviews given on the current head',
    edits: [
      [
        'server/githost/host.ts',
        'if (review.commitId !== headSha || review.verdict === null) continue;',
        'if (review.verdict === null) continue;',
      ],
    ],
    tests: [CONTRACT],
  },
  {
    name: 'github-merged-ignored',
    claim: 'a merged GitHub PR reads as merged',
    edits: [
      [
        'server/githost/github.ts',
        "state: bool(pr, 'merged') || optStr(pr, 'merged_at') !== null ? 'merged'",
        "state: optStr(pr, 'merged_at') !== null ? 'merged'",
      ],
    ],
    tests: [CONTRACT],
  },
  {
    name: 'self-review-not-downgraded',
    claim: 'a verdict GitHub refuses on the same account is posted as a comment',
    edits: [['server/githost/github.ts', '/own pull request/i.test', '/never matches/i.test']],
    tests: [CONTRACT, CAGES],
  },
  {
    name: 'author-never-adopts',
    claim: 'a restarted author job adopts the open PR instead of opening a second or running the agent again',
    edits: [
      ['server/modes/cages.ts', 'if (existing !== null) return void (await poll(existing.number));', ''],
      ['server/modes/cages.ts', '(await host.findChange(repo, branch)) ??', ''],
    ],
    tests: [CAGES],
  },
  {
    name: 'author-runs-again-on-restart',
    claim: 'a restarted author job does not run the agent when the PR already exists',
    edits: [['server/modes/cages.ts', 'if (existing !== null) return void (await poll(existing.number));', '']],
    tests: [CAGES],
  },
  {
    name: 'review-posted-twice',
    claim: 'a review HQ already posted on the head is adopted, not posted again',
    edits: [['server/modes/cages.ts', 'const mine = snapshot.reviews.find(', 'const mine = [].find(']],
    tests: [CAGES],
  },
  {
    name: 'brief-posted-twice',
    claim: 'a merge brief already on the PR is adopted, not posted again',
    edits: [['server/modes/cages.ts', '(await host.findComment(repo, job.change.number, marker)) ??', '']],
    tests: [CAGES],
  },
  {
    name: 'no-round-limit',
    claim: 'after three fix rounds HQ stops and files an Action item',
    edits: [['server/modes/cages.ts', 'return rounds > roundLimit ? null :', 'return false ? null :']],
    tests: [CAGES],
  },
  {
    name: 'round-limit-off-by-one',
    claim: 'the limit allows exactly three fix rounds',
    edits: [['server/modes/cages.ts', 'return rounds > roundLimit ? null :', 'return rounds >= roundLimit ? null :']],
    tests: [CAGES],
  },
  {
    name: 'one-account-approval-counted',
    claim: 'with one account an approval is never recorded, so the box waits in qc',
    edits: [
      [
        'server/modes/cages.ts',
        "shared ? (intended === 'changes' ? 'changes' : 'comment') : posted.verdict",
        'shared ? intended : posted.verdict',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'one-account-review-as-author',
    claim: 'with one account HQ attributes its own review to the reviewer worker',
    edits: [['server/modes/cages.ts', 'reviewer: shared ? worker : posted.reviewer,', 'reviewer: posted.reviewer,']],
    tests: [CAGES],
  },
  {
    name: 'website-item-stays-after-allow',
    claim: 'Allow clears the website Action item',
    edits: [['server/modes/cages.ts', 'if (!allowed.has(denial.host)) items.push', 'items.push']],
    tests: [CAGES],
  },
  {
    name: 'allow-any-host',
    claim: 'Allow only answers a website that was blocked',
    edits: [['server/modes/cages.ts', 'if (!denials.has(site)) throw', 'if (false) throw']],
    tests: [CAGES],
  },
  {
    name: 'merge-ready-not-watched',
    claim: 'HQ watches a merge-ready PR and closes the task after a person merges',
    edits: [
      [
        'server/modes/cages.ts',
        "box.state === 'belt' || box.state === 'building'",
        "box.state === 'belt' || box.state === 'building' || box.state === 'merge'",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'hq-merges',
    claim: 'HQ never calls a merge endpoint over a whole run',
    edits: [
      [
        'server/githost/github.ts',
        "  ['POST', new RegExp(`^/repos/${REPO}/pulls$`)],",
        "  ['POST', new RegExp(`^/repos/${REPO}/pulls$`)],\n  ['PUT', /\\/merge$/],",
      ],
      [
        'server/githost/github.ts',
        "const posted = await call('POST', `/repos/${repo}/issues/${number}/comments`, { body: text });",
        "const posted = await call('POST', `/repos/${repo}/issues/${number}/comments`, { body: text });\n      await call('PUT', `/repos/${repo}/pulls/${number}/merge`, {});",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'brief-no-runtime-gap',
    claim: 'the brief names a same-runtime review as a gap',
    edits: [['server/brief/merge-brief.ts', 'if (sameRuntime.length > 0)', 'if (false)']],
    tests: [BRIEF, CAGES],
  },
  {
    name: 'brief-hides-missing',
    claim: 'a missing piece of evidence shows as not collected with a reason',
    edits: [
      [
        'server/brief/merge-brief.ts',
        'lines.length > 0 ? collected(lines) : missing(reason)',
        'lines.length > 0 ? collected(lines) : collected([])',
      ],
    ],
    tests: [BRIEF],
  },
  {
    name: 'claude-tokens-swapped',
    claim: 'tokens are read from the runtime usage field they belong to',
    edits: [
      [
        'server/agents/claude-code.ts',
        "cacheReadTokens: tokens(usage, 'cache_read_input_tokens'),",
        "cacheReadTokens: tokens(usage, 'cache_creation_input_tokens'),",
      ],
    ],
    tests: [AGENTS],
  },
  {
    name: 'claude-git-unhardened',
    claim: 'HQ reads the cage repo with git hardened against agent-written config',
    edits: [['server/agents/claude-code.ts', "'-c', 'core.fsmonitor=false', ", '']],
    tests: [AGENTS],
  },
];

const only = process.argv.slice(2);
/** @param {string[]} tests */
const vitest = (tests) =>
  spawnSync('pnpm', ['vitest', 'run', ...tests], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 600_000,
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
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
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
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/mutants-p1-2.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
