// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text being mutated
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdit, selectMutants } from '../../scripts/mutate.mjs';
import { parseArgs } from '../../scripts/shard.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STORE = 'server/test/store.test.ts';
const CONTRACT = 'server/test/githost.contract.test.ts';
const RECORDED = 'test/contract/githost.recorded.test.ts';
const CAGES = 'server/test/cages.test.ts';
const BRIEF = 'server/test/merge-brief.test.ts';
const AGENTS = 'server/test/agents.test.ts';
const SANITIZE = 'server/test/sanitize.test.ts';
const KILL = 'server/test/kill-push.test.ts';
const DOCKER = 'server/test/sandbox/cage-shell.test.ts';
const CLI = 'server/test/cli.test.ts';
const SITE = 'server/test/site.test.ts';
const TMP = 'server/test/tmp-cleanup.test.ts';
const CILOG = 'server/test/ci-log.test.ts';
const CHECKOUT = 'server/test/checkout.test.ts';

/** @type {Array<{ name: string, claim: string, edits: Array<[file: string, find: string, replace: string, all?: 'all']>, tests: string[], survives?: boolean }>} */
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
        'const rule = rules.find((r) => r.method === method && r.path.test(tail));',
        'const rule = rules.find((r) => r.method === method && r.path.test(tail)) ?? { method, path: /./, keys: Object.keys(request.body ?? {}) };',
      ],
    ],
    tests: [CONTRACT, RECORDED],
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
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'github-skipped-is-success',
    claim: 'a skipped GitHub check run parses as skipped',
    edits: [['server/githost/github.ts', "  skipped: 'skipped',", "  skipped: 'success',"]],
    tests: [CONTRACT, RECORDED],
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
    tests: [CONTRACT, RECORDED],
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
    tests: [CONTRACT, RECORDED],
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
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'self-review-not-downgraded',
    claim: 'a verdict GitHub refuses on the same account is posted as a comment',
    edits: [['server/githost/github.ts', 'OWN_PULL_REQUEST.test', '/never matches/i.test']],
    tests: [CONTRACT, RECORDED, CAGES],
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
    edits: [
      [
        'server/modes/cages.ts',
        '.filter((r) => r.commitId === head && r.reviewer.toLowerCase() === self)',
        '.filter(() => false)',
      ],
    ],
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
    edits: [['server/modes/cages.ts', 'if (!allowed.has(denial.site)) items.push', 'items.push']],
    tests: [CAGES],
  },
  {
    name: 'allow-any-host',
    claim: 'Allow only answers a website that was blocked',
    edits: [
      [
        'server/modes/cages.ts',
        'if (site === undefined || denials.get(site)?.allow !== true)',
        'if (site === undefined)',
      ],
    ],
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
        "  { method: 'POST', path: route('issues/\\\\d+/comments'), keys: ['body'] },",
        "  { method: 'POST', path: route('issues/\\\\d+/comments'), keys: ['body'] },\n  { method: 'PUT', path: /\\/merge$/, keys: [] },",
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
    edits: [['server/brief/merge-brief.ts', 'if (sameRuntime)', 'if (false)']],
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
    edits: [['server/agents/checkout.ts', "'-c', 'core.fsmonitor=false', ", '']],
    tests: [AGENTS],
  },
  {
    name: 'v-draft-pr',
    claim: 'a PR opens ready, not as a draft',
    edits: [['server/githost/github.ts', 'draft: false,', 'draft: true,']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'v-gitlab-closed-as-merged',
    claim: 'a closed, unmerged MR is not merged',
    edits: [['server/githost/gitlab.ts', "  closed: 'closed',\n  merged", "  closed: 'merged',\n  merged"]],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-github-closed-as-merged',
    claim: 'a closed, unmerged PR is closed',
    edits: [['server/githost/github.ts', "{ open: 'open', closed: 'closed' }", "{ open: 'open', closed: 'merged' }"]],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-outdated-line-null',
    claim: 'an outdated comment falls back to original_line',
    edits: [['server/githost/github.ts', "? optLine(c, 'original_line')", '? null']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'v-gitlab-skipped-success',
    claim: 'a skipped GitLab pipeline is not success',
    edits: [['server/githost/gitlab.ts', "skipped: 'skipped',", "skipped: 'success',"]],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-neutral-failure',
    claim: 'a neutral check run passes',
    edits: [['server/githost/github.ts', "neutral: 'success',", "neutral: 'failure',"]],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-checks-any-head',
    claim: 'a poll keeps only checks on the current head',
    edits: [['server/githost/host.ts', '.filter((check) => check.headSha === headSha)', '.filter(() => true)']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'v-poll-latest-earliest',
    claim: 'the latest review per reviewer wins',
    edits: [['server/githost/host.ts', 'review.at >= seen.at', 'review.at <= seen.at']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'v-guard-pathname-noquery',
    claim: 'a write path with a query is refused',
    edits: [
      [
        'server/githost/host.ts',
        "if (pathname !== path) return 'a write path may not hold a query, a fragment or a dot segment';",
        '',
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-guard-no-%2f',
    claim: 'a configured GitLab project must be a namespace path, so a numeric id or a dot segment is refused',
    edits: [['server/githost/gitlab.ts', 'if (!PROJECT_PATH.test(repo)) throw', 'if (false) throw']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-contents-dotfile',
    claim: 'a pushed file path may not have a hidden segment (.github)',
    edits: [['server/githost/host.ts', " && !segment.startsWith('.')", '']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'v-gitlab-approve-always',
    claim: 'GitLab approves only on an approve verdict',
    edits: [['server/githost/gitlab.ts', "if (draft.verdict === 'approve')\n", 'if (true)\n']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'v-review-stale-head-counted',
    claim: 'the review job checks the head before it posts',
    edits: [
      [
        'server/modes/cages.ts',
        'if (snapshot.change.headSha !== head) return void take(snapshot);\n      const self',
        'const self',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'v-fix-stale-head',
    claim: 'the fix job stops when the head moved',
    edits: [['server/modes/cages.ts', 'if (now.headSha !== job.change.head.v) return;', '']],
    tests: [CAGES],
  },
  {
    name: 'v-asked-all-heads',
    claim: 'a fix round gets only the comments on the head it fixes',
    edits: [['server/modes/cages.ts', '.filter((c) => c.commitId === head && c.author', '.filter((c) => c.author']],
    tests: [CAGES],
  },
  {
    name: 'v-brief-stale-head',
    claim: 'the brief job checks the head before it posts',
    edits: [
      [
        'server/modes/cages.ts',
        'if (snapshot.change.headSha !== head) return void take(snapshot);\n      const [files',
        'const [files',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'v-marker-no-head',
    claim: 'the brief marker binds the head',
    edits: [['server/brief/merge-brief.ts', 'task=${task} head=${headSha} -->', 'task=${task} -->']],
    tests: [BRIEF, CAGES],
  },
  {
    name: 'v-ready-item-any-head',
    claim: 'ready_to_merge shows only for a brief on the current head',
    edits: [
      [
        'server/modes/cages.ts',
        'if (written !== undefined && change?.head.v === written.head)',
        'if (written !== undefined)',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'v-shared-keeps-approve',
    claim: 'with one account an approve verdict is downgraded',
    edits: [
      [
        'server/modes/cages.ts',
        "const verdict = shared ? (intended === 'changes' ? 'changes' : 'comment') : posted.verdict;",
        'const verdict = shared ? intended : posted.verdict;',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'v-max-failures-inf',
    claim: 'a failing job gives up',
    edits: [
      [
        'server/modes/cages.ts',
        'const maxFailures = options.maxFailures ?? 3;',
        'const maxFailures = options.maxFailures ?? 1e9;',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'v-crashed-off-by-one',
    claim: 'a command gives up at exactly 3 attempts',
    edits: [
      [
        'server/ledger.ts',
        "entry.status === 'pending' && entry.attempts >= MAX_ATTEMPTS",
        "entry.status === 'pending' && entry.attempts > MAX_ATTEMPTS",
      ],
    ],
    tests: [STORE],
  },
  {
    name: 'v-begin-after-run',
    claim: 'an attempt is counted before the executor runs',
    edits: [
      [
        'server/hq.ts',
        '      ledger.begin(entry.id);\n      try {\n        await executor(entry);',
        '      try {\n        await executor(entry);\n        ledger.begin(entry.id);',
      ],
    ],
    tests: [STORE, CAGES, 'server/test/hq.test.ts'],
  },
  {
    name: 'v-stream-first-result',
    claim: 'the last result line is used',
    edits: [
      [
        'server/agents/claude-code.ts',
        "lines.findLast((line) => line.type === 'result')",
        "lines.find((line) => line.type === 'result')",
      ],
    ],
    tests: [AGENTS],
  },
  {
    name: 'v-stream-ignore-is-error',
    claim: 'an is_error result fails',
    edits: [['server/agents/claude-code.ts', "result.is_error === true || result.subtype !== 'success'", 'false']],
    tests: [AGENTS],
  },
  {
    name: 'v-codex-succeeds',
    claim: 'the Codex stub fails closed',
    edits: [
      [
        'server/agents/codex.ts',
        "throw new RuntimeUnavailable('the Codex runtime is deferred at gate G0, so no Codex worker can run yet');",
        "return { role: 'author', files: [], message: '', usage: null } as never;",
      ],
    ],
    tests: [AGENTS],
  },
  {
    name: 'v-review-line-zero',
    claim: 'a review comment line must be at least 1',
    edits: [
      [
        'server/agents/runtime.ts',
        'return Number.isSafeInteger(n) && (n as number) >= 1 ? (n as number) : null;',
        'return Number.isSafeInteger(n) ? (n as number) : null;',
      ],
    ],
    tests: [AGENTS],
  },
  {
    name: 'v-allow-case-insensitive',
    claim: 'Allow turns an IDN name into its ASCII form before it matches a denial (M9 replaced exact match)',
    edits: [
      [
        'server/sandbox/site.ts',
        "const host = domainToASCII((split[1] ?? '').replace(/\\.$/, ''));",
        "const host = (split[1] ?? '').toLowerCase().replace(/\\.$/, '');",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'v-brief-drops-not-collected-reason',
    claim: 'not collected shows its reason',
    edits: [
      [
        'server/brief/merge-brief.ts',
        "return [`**${title}**`, `- ${label}: ${section.reason}`, ''];",
        "return [`**${title}**`, `- ${label}`, ''];",
      ],
    ],
    tests: [BRIEF],
  },
  {
    name: 'v-roundlimit-4',
    claim: 'the default round limit is 3',
    edits: [['server/modes/cages.ts', 'const ROUND_LIMIT = 3;', 'const ROUND_LIMIT = 4;']],
    tests: [CAGES],
  },
  {
    name: 'v-findchange-other-branch',
    claim: 'findChange matches the exact branch',
    edits: [['server/githost/github.ts', '.filter((pr) => pr.branch === branch);', ';']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'b1-workorder-raw',
    claim: 'the work order body is quoted in the PR or MR description',
    edits: [['server/modes/cages.ts', '    quoteBlock(ticket.body),\n', '    ticket.body,\n']],
    tests: [SANITIZE, CAGES],
  },
  {
    name: 'b1-review-body-raw',
    claim: 'the reviewer body is quoted',
    edits: [
      [
        'server/modes/cages.ts',
        'body: `${quoteBlock(result.body)}\\n\\n${reviewMarker',
        'body: `${result.body}\\n\\n${reviewMarker',
      ],
    ],
    tests: [SANITIZE, CAGES],
  },
  {
    name: 'b1-line-comment-raw',
    claim: 'each line comment body is quoted',
    edits: [
      [
        'server/modes/cages.ts',
        'comments: result.comments.map((c) => ({ ...c, body: quoteBlock(c.body) })),',
        'comments: result.comments,',
      ],
    ],
    tests: [SANITIZE, CAGES],
  },
  {
    name: 'b1-asked-raw',
    claim: 'the asked: lines of the merge brief are quoted',
    edits: [
      [
        'server/brief/merge-brief.ts',
        "`, asked:\\n${quoteBlock(round.asked.join('\\n'))}`",
        "`, asked: ${round.asked.join('; ')}`",
      ],
    ],
    tests: [SANITIZE, BRIEF, CAGES],
  },
  {
    name: 'b1-title-raw',
    claim: 'the PR or MR title is a plain line',
    edits: [['server/modes/cages.ts', '`${ticket.id}: ${plainLine(ticket.title)}`', '`${ticket.id}: ${ticket.title}`']],
    tests: [SANITIZE, CAGES],
  },
  {
    name: 'b1-files-raw',
    claim: 'changed file names in the brief are code spans',
    edits: [['server/brief/merge-brief.ts', 'const line = inlineCode(file);', 'const line = file;']],
    tests: [SANITIZE],
  },
  {
    name: 'b1-guard-skips-body',
    claim: 'the write guard checks every body, not only the method and path',
    edits: [
      [
        'server/githost/host.ts',
        'return unknownKey(o, rule.keys) ?? textProblem(o) ?? rule.body?.(o, scope) ?? null;',
        'return unknownKey(o, rule.keys) ?? rule.body?.(o, scope) ?? null;',
      ],
    ],
    tests: [CONTRACT, RECORDED, SANITIZE],
  },
  {
    name: 'b1-lookalike-slash',
    claim: 'a Unicode slash lookalike at line start counts as a quick action',
    edits: [
      [
        'server/githost/sanitize.ts',
        "const SLASHES = '/\\u2044\\u2215\\u2571\\u27cb\\u29f8\\u3033';",
        "const SLASHES = '/';",
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'b1-zero-width-prefix',
    claim: 'a zero-width prefix does not hide a quick action',
    edits: [
      [
        'server/githost/sanitize.ts',
        "LEAD.test(line.normalize('NFKC').replace(CONTROL, ''))",
        "LEAD.test(line.normalize('NFKC'))",
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'b1-quote-no-prefix',
    claim: 'every quoted line starts with the marker, never with the quoted text',
    edits: [['server/githost/sanitize.ts', "body.split('\\n').map((line) => `│ ${line}`)", "body.split('\\n')"]],
    tests: [SANITIZE],
  },
  {
    name: 'b1-mention-allowed',
    claim: 'a mention outside code is refused',
    edits: [['server/githost/sanitize.ts', 'if (/@[\\p{L}\\p{N}_]/u.test(prose))', 'if (false)']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'b1-no-length-cap',
    claim: 'a body longer than the cap is refused',
    edits: [['server/githost/sanitize.ts', 'if (text.length > MAX_BODY)', 'if (false)']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm1-split-push',
    claim: 'a round is pushed as one commit, so a kill never leaves a partial round to review',
    edits: [
      [
        'server/githost/github.ts',
        '    async pushFiles(repo, spec) {\n',
        '    async pushFiles(repo, spec) {\n      if (spec.files.length > 1) await this.pushFiles(repo, { ...spec, files: spec.files.slice(0, 1) });\n',
      ],
    ],
    tests: [KILL],
  },
  {
    name: 'm2-brief-marker-any-author',
    claim: 'a brief marker counts only on a comment the HQ account wrote',
    edits: [['server/githost/github.ts', "(c) => str(c, 'user.login').toLowerCase() === self &&", '(c) =>']],
    tests: [CONTRACT, RECORDED, CAGES],
  },
  {
    name: 'm2-gitlab-marker-any-author',
    claim: 'a GitLab note marker counts only on a note the HQ account wrote',
    edits: [['server/githost/gitlab.ts', "(n) => str(n, 'author.username').toLowerCase() === self &&", '(n) =>']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm2-review-marker-any-author',
    claim: 'a review marker counts only on a review the reviewer account wrote',
    edits: [
      [
        'server/modes/cages.ts',
        '.filter((r) => r.commitId === head && r.reviewer.toLowerCase() === self)',
        '.filter((r) => r.commitId === head)',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'm2-asked-any-author',
    claim: 'a fix round gets only line comments the reviewer account wrote',
    edits: [
      ['server/modes/cages.ts', 'c.commitId === head && c.author.toLowerCase() === reviewer)', 'c.commitId === head)'],
    ],
    tests: [CAGES],
  },
  {
    name: 'm4-branch-unchecked',
    claim: 'every branch write is pinned to aw/<factory>/<task>',
    edits: [['server/githost/host.ts', "typeof branch === 'string' && BRANCH.test(branch)\n", 'true\n']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm4-force-push',
    claim: 'a ref update may not force',
    edits: [
      [
        'server/githost/github.ts',
        "(b.force === undefined || b.force === false ? null : 'a ref update may not force')",
        'null',
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm4-symlink-tree',
    claim: 'a pushed tree holds only plain files',
    edits: [['server/githost/github.ts', '!MODES.has(entry.mode) || ', '']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm4-gitlab-any-case',
    claim: 'GitLab write routes match by exact case',
    edits: [
      [
        'server/githost/gitlab.ts',
        'const route = (tail: string) => new RegExp(`^/${tail}$`);',
        "const route = (tail: string) => new RegExp(`^/${tail}$`, 'i');",
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm4-task-id-unchecked',
    claim: 'a ticket id must be <factory>/<task>',
    edits: [['server/modes/cages.ts', 'if (!TASK_ID.test(task)) throw', 'if (false) throw']],
    tests: [CLI],
  },
  {
    name: 'm5-one-page',
    claim: 'every list is read to its last page',
    edits: [['server/githost/host.ts', '    if (list.length < PAGE_SIZE) return all;', '    return all;']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'm6-prompt-in-argv',
    claim: 'the prompt goes to the agent on stdin, not in argv',
    edits: [
      [
        'server/agents/claude-code.ts',
        'const ran = await shell.exec(argv, {\n      input: promptFor(job, notAtHead),',
        'const ran = await shell.exec([...argv, promptFor(job, notAtHead)], {',
      ],
    ],
    tests: [AGENTS],
  },
  {
    name: 'm9-null-body-500',
    claim: 'a JSON null ticket body is a 400',
    edits: [
      [
        'server/modes/cages.ts',
        "if (raw === null || typeof raw !== 'object' || Array.isArray(raw))",
        'if (Array.isArray(raw))',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'm9-allow-ignores-port',
    claim: 'Allow keys a website on host and port',
    edits: [
      [
        'server/sandbox/site.ts',
        'return { site: `${host}:${port}`, host, port };',
        'return { site: `${host}:443`, host, port };',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'm9-allow-unnormalized',
    claim: 'Allow normalizes case, a trailing dot and IDN before it matches a denial',
    edits: [
      [
        'server/sandbox/site.ts',
        "const host = domainToASCII((split[1] ?? '').replace(/\\.$/, ''));",
        "const host = split[1] ?? '';",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'm3-allow-not-written',
    claim: 'Allow writes the rule to the running proxy allowlist',
    edits: [
      [
        'server/sandbox/container.ts',
        'if (!current.includes(rule)) writeAllowlist(allowlistPath, [...current, rule]);',
        '',
      ],
    ],
    tests: [DOCKER],
  },
  {
    name: 'm3-exec-no-stdin',
    claim: 'the cage shell passes stdin to the agent',
    edits: [
      [
        'server/sandbox/container.ts',
        "['exec', '-i', '-w', '/work', view.container",
        "['exec', '-w', '/work', view.container",
      ],
    ],
    tests: [DOCKER],
  },
  {
    name: 'm3-cli-no-mode',
    claim: 'serve --mode cages runs HQ with the cages mode',
    edits: [['server/cli.ts', '...(mode === undefined ? {} : { mode })', '']],
    tests: [CLI],
  },
  {
    name: 'r2-lone-cr-kept',
    claim: 'a lone CR is a line break, both when quoting and when checking',
    edits: [
      [
        'server/githost/sanitize.ts',
        'export const LINE_BREAK = /\\r\\n|[\\n\\r\\v\\f\\u0085\\u2028\\u2029]/;',
        'export const LINE_BREAK = /\\r\\n|[\\n\\v\\f\\u0085\\u2028\\u2029]/;',
      ],
    ],
    tests: [SANITIZE],
  },
  {
    name: 'r2-lead-no-checkbox',
    claim: 'a task-list checkbox before a slash still counts as a quick action',
    edits: [['server/githost/sanitize.ts', '|\\\\d+[.)]|\\\\[[ xX]?\\\\])*', '|\\\\d+[.)])*']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-mention-ascii-lower',
    claim: 'a mention of any letter, digit or case is refused',
    edits: [['server/githost/sanitize.ts', '/@[\\p{L}\\p{N}_]/u.test(prose)', '/@[a-z]/.test(prose)']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-html-letters-only',
    claim: 'any < outside code is refused, comments and closing tags included',
    edits: [['server/githost/sanitize.ts', "prose.includes('<')", '/<[a-z]/.test(prose)']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-link-paren-only',
    claim: 'reference links and definitions are refused, not only [x](y)',
    edits: [['server/githost/sanitize.ts', '/\\]\\s*[([:]/.test(prose)', '/\\]\\(/.test(prose)']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-max-body-ge',
    claim: 'a body of exactly 60,000 characters passes',
    edits: [['server/githost/sanitize.ts', 'if (text.length > MAX_BODY)', 'if (text.length >= MAX_BODY)']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-fence-any-indent',
    claim: 'an indented fence, which a list item can close, hides nothing from the check',
    edits: [['server/githost/sanitize.ts', "if (open[1] !== '') return", 'if (false) return']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-marker-line-loose',
    claim: 'only a marker line with plain values skips the prose check',
    edits: [['server/githost/sanitize.ts', '(?: [a-z]+=[\\w./-]+)* -->$/', '(?: [a-z]+=\\S+)* -->$/']],
    tests: [SANITIZE],
  },
  {
    name: 'r2-title-multiline-ok',
    claim: 'a PR or MR title must be one line',
    edits: [
      [
        'server/githost/host.ts',
        "const ONE_LINE: ReadonlySet<string> = new Set(['title', 'message', 'commit_message']);",
        "const ONE_LINE: ReadonlySet<string> = new Set(['message', 'commit_message']);",
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r2-gitlab-no-project-decode',
    claim: 'every call, reads included, names the configured repo or project and no other',
    edits: [['server/githost/host.ts', "if (path !== '/user' && !path.startsWith(`${scope.home}/`))", 'if (false)']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r2-gh-marker-login-substring',
    claim: 'marker authorship compares the whole login, case-insensitively',
    edits: [
      [
        'server/githost/github.ts',
        "(c) => str(c, 'user.login').toLowerCase() === self && str(c, 'body')",
        "(c) => str(c, 'user.login').toLowerCase().includes(self) && str(c, 'body')",
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r2-maxpages-2',
    claim: 'lists are read up to 5,000 items, not 200',
    edits: [['server/githost/host.ts', 'const MAX_ITEMS = 5_000;', 'const MAX_ITEMS = 200;']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r2-gitlab-always-start-branch',
    claim: 'a GitLab push names start_branch only when it creates the branch',
    edits: [
      ['server/githost/gitlab.ts', '...(branchExists ? {} : { start_branch: spec.base }),', 'start_branch: spec.base,'],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r2-cage-shared-by-workers',
    claim: 'the author and the reviewer of a task never share a cage',
    edits: [['server/agents/cage-shell.ts', 'const key = `${worker}\\n${task}`;', 'const key = task;']],
    tests: [AGENTS],
  },
  {
    name: 'r3-ls-not-a-break',
    claim: 'LS and PS are line breaks',
    edits: [['server/githost/sanitize.ts', '\\u0085\\u2028\\u2029]/;', '\\u0085]/;']],
    tests: [SANITIZE],
  },
  {
    name: 'r3-escaped-backtick-opens',
    claim: 'an escaped backtick does not open a code span',
    edits: [['server/githost/sanitize.ts', '% 2 === 1;', '% 2 === 2;']],
    tests: [SANITIZE],
  },
  {
    name: 'r3-fence-info-backtick',
    claim: 'a backtick in a fence info string means it is not a fence',
    edits: [['server/githost/sanitize.ts', '(`{3,}(?=[^`]*$)|~{3,})', '(`{3,}|~{3,})']],
    tests: [SANITIZE],
  },
  {
    name: 'r3-fence-close-with-info',
    claim: 'a fence closes only on a bare fence line',
    edits: [
      [
        'server/githost/sanitize.ts',
        'const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \\t]*$/;',
        'const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})/;',
      ],
    ],
    tests: [SANITIZE],
  },
  {
    name: 'r3-guard-any-key',
    claim: 'a body key the route does not list is refused',
    edits: [['server/githost/host.ts', '.find((key) => !keys.includes(key));', '.find(() => false);']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gh-pr-any-base',
    claim: 'a PR must target the configured base',
    edits: [['server/githost/github.ts', '(b.base === scope.base ? null :', '(true ? null :']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gl-mr-any-target',
    claim: 'an MR must target the configured base',
    edits: [['server/githost/gitlab.ts', '(b.target_branch === scope.base ? null :', '(true ? null :']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gl-start-branch-any',
    claim: 'a new GitLab branch starts only from the configured base',
    edits: [
      ['server/githost/gitlab.ts', 'body.start_branch !== undefined && body.start_branch !== scope.base', 'false'],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gh-tree-entry-any-key',
    claim: 'a tree entry may not carry a sha or any other extra key',
    edits: [
      [
        'server/githost/github.ts',
        "const extra = unknownKey(entry, ['path', 'mode', 'type', 'content']);",
        'const extra = null;',
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gl-action-any-key',
    claim: 'a GitLab commit action may not set execute_filemode or any other extra key',
    edits: [
      [
        'server/githost/gitlab.ts',
        "const extra = unknownKey(action, ['action', 'file_path', 'content']);",
        'const extra = null;',
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gh-review-comment-any-key',
    claim: 'a review line comment may not carry extra keys',
    edits: [
      [
        'server/githost/github.ts',
        "const extra = unknownKey(c, ['path', 'line', 'side', 'body']);",
        'const extra = null;',
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gl-position-any-key',
    claim: 'a discussion position may not carry extra keys',
    edits: [['server/githost/gitlab.ts', 'body: (b) => unknownKey(b.position, POSITION_KEYS),', 'body: () => null,']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-github-repo-unchecked',
    claim: 'a configured GitHub repo must be <owner>/<name>',
    edits: [['server/githost/github.ts', 'if (!REPO.test(repo)) throw', 'if (false) throw']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-site-raw-unchecked',
    claim: 'Allow refuses multi-line, # and other non-hostname input before IDN mapping',
    edits: [
      [
        'server/sandbox/site.ts',
        "if (split === null || !RAW_NAME.test(split[1] ?? '')) return null;",
        'if (split === null) return null;',
      ],
    ],
    tests: [SITE, CAGES],
  },
  {
    name: 'r3-site-label-unchecked',
    claim: 'Allow refuses a wildcard, an empty label or a label with a leading hyphen',
    edits: [['server/sandbox/site.ts', "!host.split('.').every((label) => LABEL.test(label))", 'false']],
    tests: [SITE, CAGES],
  },
  {
    name: 'r3-driver-allow-unvalidated',
    claim: 'driver.allow uses the same validator as the Allow API',
    edits: [['server/sandbox/container.ts', 'if (siteOf(rule)?.site !== rule) throw', 'if (false) throw']],
    tests: [SITE],
  },
  {
    name: 'r3-wildcard-item-allowable',
    claim: 'the website item for a wildcard CONNECT does not offer Allow',
    edits: [
      [
        'server/modes/cages.ts',
        'allow: (seenBefore?.allow ?? true) && valid !== null && denial',
        'allow: (seenBefore?.allow ?? true) && denial',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'r3-allpages-overflow-unchecked',
    claim: '5,001 items is an error, not a silent read',
    edits: [['server/githost/host.ts', 'if (all.length > max) throw', 'if (false) throw']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-gitlab-paths-one-page',
    claim: 'GitLab changed paths are read across every page of /diffs',
    edits: [
      [
        'server/githost/gitlab.ts',
        'const diffs = await allPages(get, `${project(repo)}/merge_requests/${number}/diffs`);',
        'const diffs = (await get(`${project(repo)}/merge_requests/${number}/diffs`)) as unknown[];',
      ],
    ],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-brief-file-list-unbounded',
    claim: 'the brief caps its file list so a huge PR stays postable',
    edits: [['server/brief/merge-brief.ts', 'if (used > FILE_LIST_BUDGET)', 'if (false)']],
    tests: [BRIEF],
  },
  {
    name: 'r3-brief-no-more-line',
    claim: 'the brief says how many files it did not list',
    edits: [
      [
        'server/brief/merge-brief.ts',
        'return [...lines, `${files.length - lines.length} more files not listed`];',
        'return lines;',
      ],
    ],
    tests: [BRIEF],
  },
  {
    name: 'r3-binary-read-as-text',
    claim: 'a file with a NUL byte is reported as binary, not decoded as text',
    edits: [['server/githost/host.ts', 'if (bytes.includes(0)) return null;', '']],
    tests: [CONTRACT, RECORDED],
  },
  {
    name: 'r3-author-binary-pushed',
    claim: 'an author commit with a binary file fails instead of pushing mangled text',
    edits: [['server/agents/claude-code.ts', 'if (binary !== undefined)', 'if (false)']],
    tests: [AGENTS],
  },
  {
    name: 'r3-review-prompt-binary-shown',
    claim: 'the reviewer prompt says a binary file is not shown',
    edits: [['server/agents/claude-code.ts', 'f.content === null ?', 'false ?']],
    tests: [AGENTS],
  },
  {
    name: 'r3-config-same-login',
    claim: 'the config refuses an author login equal to the reviewer login',
    edits: [['server/modes/cages-config.ts', 'if (author.toLowerCase() === reviewer.toLowerCase())', 'if (false)']],
    tests: [CLI],
  },
  {
    name: 'r3-leaks-no-cleanup',
    claim: 'the P0-3 leaks test removes every temp directory it made',
    edits: [
      ['spikes/P0-3/leaks.test.ts', 'for (const dir of scratchDirs.splice(0)) rmSync', 'for (const dir of []) rmSync'],
    ],
    tests: [TMP],
  },
  {
    name: 'r3-tempdir-no-cleanup',
    claim: 'tempDir records each directory and removes it after the file',
    edits: [['server/test/helpers.ts', '  made.push(dir);\n', '']],
    tests: [TMP],
  },
  {
    name: 'r3-keep-tmp-ignored',
    claim: 'AW_KEEP_TMP=1 keeps the temp directories',
    edits: [['server/test/helpers.ts', "process.env.AW_KEEP_TMP !== '1'", 'true']],
    tests: [TMP],
  },
  {
    name: 'red-never-reaches-author',
    claim: 'a red check starts a fix round',
    edits: [['server/modes/cages.ts', "if (redOn(change).length > 0) return fixRound('ci');", '']],
    tests: [CAGES],
  },
  {
    name: 'red-while-pending',
    claim: 'no fix round while a check is still running',
    edits: [['server/githost/host.ts', "if (head.some((check) => check.state === 'pending')) return [];", '']],
    tests: [CAGES],
  },
  {
    name: 'red-waits-for-skipped',
    claim: 'a skipped check holds no fix round back',
    edits: [
      [
        'server/githost/host.ts',
        "check.state === 'pending')) return [];",
        "check.state !== 'success' && check.state !== 'failure')) return [];",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'red-rounds-not-counted',
    claim: 'a red check spends a round of the limit',
    edits: [['server/modes/cages.ts', '        ...(redHeads.get(ref) ?? []),\n', '']],
    tests: [CAGES],
  },
  {
    name: 'red-limit-silent',
    claim: 'red CI at the round limit files an Action item',
    edits: [
      [
        'server/modes/cages.ts',
        "            if (roundsOf(change) > roundLimit)\n              items.push({\n                kind: 'checks_failed',",
        "            if (roundsOf(change) < 0)\n              items.push({\n                kind: 'checks_failed',",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'red-still-ready-to-merge',
    claim: 'a red head is never shown as ready to merge',
    edits: [
      [
        'server/modes/cages.ts',
        "            continue;\n          }\n        }\n        if (box.state === 'merge')",
        "          }\n        }\n        if (box.state === 'merge')",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'red-on-a-replaced-head',
    claim: 'red of a replaced head says nothing about the new one',
    edits: [
      [
        'server/modes/cages.ts',
        'return seenRed?.head === change.head.v ? seenRed.names : [];',
        'return seenRed?.names ?? [];',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'read-error-is-red',
    claim: 'a host read that fails is never a red check',
    edits: [
      [
        'server/modes/cages.ts',
        '          await poll(change.number);\n        } catch {}',
        "          await poll(change.number);\n        } catch {\n          red.set(changeRef(repo, change.number), { head: change.head.v, names: ['unread'] });\n        }",
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'red-fix-without-recheck',
    claim: 'the fix job reads the checks again before it spends a session',
    edits: [
      ['server/modes/cages.ts', 'if (now.headSha !== job.change.head.v || redOn(job.change).length === 0) return;', ''],
    ],
    tests: [CAGES],
  },
  {
    name: 'red-fix-with-no-failure',
    claim: 'no session starts when the host lists no failing check',
    edits: [['server/modes/cages.ts', '      if (failures.length === 0) return;\n', '']],
    tests: [CAGES],
  },
  {
    name: 'red-fix-without-output',
    claim: 'the author is given the failing jobs',
    edits: [['server/modes/cages.ts', '...(failures === undefined ? {} : { failures }),', '']],
    tests: [CAGES],
  },
  {
    name: 'red-prompt-drops-output',
    claim: 'the prompt of a CI fix round holds the failing jobs',
    edits: [
      [
        'server/agents/claude-code.ts',
        '    if (job.failures !== undefined) return ciPrompt(order, job.round, job.failures);\n',
        '',
      ],
    ],
    tests: [AGENTS],
  },
  {
    name: 'red-prompt-unquoted',
    claim: 'job output reaches the author quoted as data',
    edits: [['server/agents/claude-code.ts', 'quoteBlock(output, MAX_OUTPUT)', 'output']],
    tests: [AGENTS],
  },
  {
    name: 'red-prompt-cut',
    claim: 'the end of the excerpt is not cut off by the quote limit',
    edits: [['server/agents/claude-code.ts', 'quoteBlock(output, MAX_OUTPUT)', 'quoteBlock(output)']],
    tests: [AGENTS],
  },
  {
    name: 'log-keeps-secrets',
    claim: 'token shapes are removed from job output',
    edits: [
      [
        'server/githost/ci-log.ts',
        'SECRETS.reduce((text, [find, put]) => text.replace(find, put), line.slice(0, SCANNED));',
        'line.slice(0, SCANNED);',
      ],
    ],
    tests: [CILOG],
  },
  {
    name: 'log-keeps-private-key',
    claim: 'a private key is removed from job output',
    edits: [['server/githost/ci-log.ts', 'return hidden ? HIDDEN : line;', 'return line;']],
    tests: [CILOG],
  },
  {
    name: 'log-unbounded',
    claim: 'the excerpt has a total bound',
    edits: [['server/githost/ci-log.ts', '    if (used > room) break;\n', '']],
    tests: [CILOG],
  },
  {
    name: 'log-long-line',
    claim: 'one line of the excerpt has a bound',
    edits: [['server/githost/ci-log.ts', 'redact(lines[i] as string).slice(0, LINE)', 'redact(lines[i] as string)']],
    tests: [CILOG],
  },
  {
    name: 'log-keeps-cleanup',
    claim: 'the excerpt ends at the last marked error',
    edits: [
      [
        'server/githost/ci-log.ts',
        'const upTo = marked < 0 ? lines : lines.slice(0, marked + 1);',
        'const upTo = lines;',
      ],
    ],
    tests: [CILOG],
  },
  {
    name: 'log-loses-early-failure',
    claim: 'a failure line above the tail is kept',
    edits: [['server/githost/ci-log.ts', 'filter((line) => FAILED_LINE.test(line)),', 'filter(() => false),']],
    tests: [CILOG],
  },
  {
    name: 'gh-escape-refusal-kept',
    claim: 'a job log with colour codes is still read',
    edits: [
      [
        'server/githost/host.ts',
        "if (request.method === 'GET' && ran.err.includes(ESCAPES_FLAG)) ran = await run([ESCAPES_FLAG]);",
        '',
      ],
    ],
    tests: [CILOG],
  },
  {
    name: 'log-read-error-throws',
    claim: 'a job log that cannot be read still leaves the job named',
    edits: [
      [
        'server/githost/host.ts',
        '  } catch {\n    return null;\n  }\n};\n\nexport const signatureValid',
        '  } catch (error) {\n    throw error;\n  }\n};\n\nexport const signatureValid',
      ],
    ],
    tests: [CILOG],
  },
  {
    name: 'cancelled-logs-first',
    claim: 'the logs of cancelled jobs do not crowd out the failed one',
    edits: [['server/githost/github.ts', '      .sort((a, b) => cancelled(a) - cancelled(b));', '      ;']],
    tests: [CILOG],
  },
  {
    name: 'every-log-read',
    claim: 'only a few job logs are read',
    edits: [['server/githost/github.ts', 'output: index < MAX_LOGS ? ((', 'output: index < MAX_FAILURES ? ((']],
    tests: [CILOG],
  },
  {
    name: 'any-app-log',
    claim: 'only an Actions check run has a job log',
    edits: [
      [
        'server/githost/github.ts',
        "if ((run as { app?: { slug?: unknown } }).app?.slug !== 'github-actions') return null;",
        '',
      ],
    ],
    tests: [CILOG],
  },
  {
    name: 'gitlab-allowed-failure-sent',
    claim: 'a job allowed to fail is not sent to the author',
    edits: [
      ['server/githost/gitlab.ts', '(job as { allow_failure?: unknown }).allow_failure !== true,', 'job !== null,'],
    ],
    tests: [CILOG],
  },
  {
    name: 'gitlab-canceled-unnamed',
    claim: 'a failed pipeline with no failed job is still named',
    edits: [
      [
        'server/githost/gitlab.ts',
        '      if (jobs.length === 0) found.push({ name: pipeline.name, job: null });\n',
        '',
      ],
    ],
    tests: [CILOG],
  },
  {
    name: 'review-tree-of-base',
    claim: 'the reviewer gets the tree of the head under review, not of the base',
    edits: [
      [
        'server/modes/cages.ts',
        'tree: { entries: await host.tree(repo, head),',
        'tree: { entries: await host.tree(repo, options.base),',
      ],
    ],
    tests: [CAGES],
  },
  {
    name: 'review-without-checkout',
    claim: 'the head is checked out before a reviewer session starts',
    edits: [
      [
        'server/agents/claude-code.ts',
        'notAtHead = await checkoutHead(shell, job.change.headSha, job.tree, job.signal);',
        '',
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'review-prompt-hides-differences',
    claim: 'the reviewer is told which paths differ from the head',
    edits: [['server/agents/claude-code.ts', 'input: promptFor(job, notAtHead),', 'input: promptFor(job),']],
    tests: [CHECKOUT],
  },
  {
    name: 'review-prompt-lists-all',
    claim: 'the list of differing paths in the prompt is bounded',
    edits: [['server/agents/claude-code.ts', '.slice(0, LISTED)\n', '.slice(0)\n']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-writes-credentials',
    claim: 'a credential file of the head never reaches the cage',
    edits: [
      [
        'server/agents/checkout.ts',
        '!AGENT_SETTINGS.test(e.path) && !isCredential(e.path)',
        '!AGENT_SETTINGS.test(e.path)',
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-credential-name-only',
    claim: 'a file under a credential folder name is a credential too',
    edits: [
      [
        'server/agents/checkout.ts',
        "isProtectedPath(`/${parts.slice(0, i + 1).join('/')}`",
        "isProtectedPath(`/${parts.join('/')}`",
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-takes-head-settings',
    claim: 'a change cannot set the agent settings of its own reviewer',
    edits: [
      ['server/agents/checkout.ts', '!AGENT_SETTINGS.test(e.path) && !isCredential(e.path)', '!isCredential(e.path)'],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-settings-by-case',
    claim: 'agent settings are matched in any letter case',
    edits: [['server/agents/checkout.ts', 'mcp\\.json$)/i;', 'mcp\\.json$)/;']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-drops-export-settings',
    claim: 'the settings the export holds stay in the cage',
    edits: [['server/agents/checkout.ts', 'const wanted = [...fromHead, ...fromExport];', 'const wanted = fromHead;']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-reports-nothing',
    claim: 'the paths that differ from the head are returned',
    edits: [['server/agents/checkout.ts', 'return notAtHead;', 'return [];']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-reads-every-blob',
    claim: 'HQ reads from the host only the blobs the cage lacks',
    edits: [
      [
        'server/agents/checkout.ts',
        "const known = await git(['cat-file', '--batch-check'], shas.map((sha) => `${sha}\\n`).join(''));",
        "const known = shas.map((sha) => `${sha} missing`).join('\\n');",
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-trusts-blob-bytes',
    claim: 'bytes that are not the blob of the tree fail the checkout',
    edits: [['server/agents/checkout.ts', 'if (written !== sha) throw', 'if (written === null) throw']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-skips-refused-paths',
    claim: 'a path git will not write fails the checkout',
    edits: [['server/agents/checkout.ts', 'if (refused.length > 0)', 'if (refused.length < 0)']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-keeps-leftovers',
    claim: 'export files the head does not have are removed',
    edits: [['server/agents/checkout.ts', "await git(['clean', '-qffdx']);", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-keeps-ignored',
    claim: 'ignored files the head does not have are removed too',
    edits: [['server/agents/checkout.ts', "'-qffdx'", "'-qffd'"]],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-orphan-commit',
    claim: 'the head commit sits on the export, so git diff shows what changed',
    edits: [['server/agents/checkout.ts', "    '-p',\n    exported,\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-git-unbounded',
    claim: 'a git call in the cage that hangs ends the review job instead of holding it',
    edits: [['server/agents/checkout.ts', '      timeoutMs: GIT_TIMEOUT_MS,\n', '']],
    tests: [CHECKOUT],
  },
  {
    name: 'github-tree-lists-folders',
    claim: 'a tree holds files only',
    edits: [
      [
        'server/githost/github.ts',
        ".filter((e) => str(e, 'type') === 'blob')\n        .map((e) => ({ path: str(e, 'path'), mode: str(e, 'mode'), sha: str(e, 'sha') }));",
        ".map((e) => ({ path: str(e, 'path'), mode: str(e, 'mode'), sha: str(e, 'sha') }));",
      ],
    ],
    tests: [RECORDED],
  },
  {
    name: 'github-tree-cut-short',
    claim: 'a GitHub listing that is cut short is refused',
    edits: [
      [
        'server/githost/github.ts',
        "if (bool(listing, 'truncated')) throw",
        "if (bool(listing, 'truncated') && root === '') throw",
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'gitlab-tree-lists-folders',
    claim: 'a GitLab tree holds files only',
    edits: [['server/githost/gitlab.ts', ".filter((e) => str(e, 'type') === 'blob')\n        .map(", '.map(']],
    tests: [RECORDED],
  },
  {
    name: 'gitlab-tree-one-page',
    claim: 'every page of a GitLab tree is read',
    edits: [
      [
        'server/githost/gitlab.ts',
        '      const listed = await allPages(\n        get,\n        `${project(repo)}/repository/tree?ref=${sha}&recursive=true`,\n        undefined,\n        MAX_TREE,\n      );',
        '      const listed = (await get(`${project(repo)}/repository/tree?ref=${sha}&recursive=true&per_page=100`)) as unknown[];',
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'github-blob-as-text',
    claim: 'blob returns the decoded bytes',
    edits: [['server/githost/github.ts', "'content'), 'base64');", "'content'), 'utf8');"]],
    tests: [RECORDED],
  },
  {
    name: 'gitlab-blob-as-text',
    claim: 'a GitLab blob returns the decoded bytes',
    edits: [['server/githost/gitlab.ts', "'content'), 'base64');", "'content'), 'utf8');"]],
    tests: [RECORDED],
  },
  {
    name: 'review-reused-cage',
    claim: 'every review starts from a new cage',
    edits: [['server/agents/claude-code.ts', '      await shell.renew();\n', '']],
    tests: [CHECKOUT],
  },
  {
    name: 'renew-keeps-handle',
    claim: 'the call after a renew starts another cage',
    edits: [['server/agents/cage-shell.ts', '        cages.delete(key);\n        const view', '        const view']],
    tests: [CHECKOUT],
  },
  {
    name: 'renew-keeps-container',
    claim: 'a renew releases the old cage',
    edits: [
      ['server/agents/cage-shell.ts', 'if (view !== null) await (await driver())?.releaseCage(view.id);', 'void view;'],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-gets-author-tools',
    claim: 'a reviewer has no tool that runs code or writes',
    edits: [
      ['server/agents/claude-code.ts', "role === 'reviewer' ? REVIEWER_TOOLS :", "role === 'never' ? REVIEWER_TOOLS :"],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-loads-settings',
    claim: 'a reviewer session loads no settings, so no hooks, and reads inside /work',
    edits: [['server/agents/claude-code.ts', "  '--restricted',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-tool-added',
    claim: 'the reviewer tool set holds only tools that read',
    edits: [['server/agents/claude-code.ts', "'Read,Grep,Glob',", "'Read,Grep,Glob,Bash',"]],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-keeps-mcp',
    claim: 'a reviewer session starts no MCP server',
    edits: [['server/agents/claude-code.ts', "  '--strict-mcp-config',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-bash-not-denied',
    claim: 'Bash is denied to a reviewer by rule too',
    edits: [['server/agents/claude-code.ts', "  'Bash',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-reads-home',
    claim: 'the login home is denied to the reviewer file tools',
    edits: [['server/agents/claude-code.ts', "  'Read(//home/agent/**)',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'reviewer-told-to-run-tests',
    claim: 'the prompt does not ask the reviewer to run code',
    edits: [
      [
        'server/agents/claude-code.ts',
        'You cannot run code or write files, so do not say you ran anything; CI runs the tests.',
        "Run the repository's tests there.",
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-reads-global-config',
    claim: 'HQ git ignores the global config of the home',
    edits: [['server/agents/checkout.ts', "  'GIT_CONFIG_GLOBAL=/dev/null',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-reads-system-config',
    claim: 'HQ git ignores the system config',
    edits: [['server/agents/checkout.ts', "  'GIT_CONFIG_NOSYSTEM=1',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-follows-git-dir-env',
    claim: 'HQ git names the repository itself',
    edits: [['server/agents/checkout.ts', "  '--git-dir=.git',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-follows-core-worktree',
    claim: 'HQ git names the work tree itself',
    edits: [['server/agents/checkout.ts', "  '--work-tree=.',\n", '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-follows-symlinks',
    claim: 'a symbolic link of the head is a plain file',
    edits: [['server/agents/checkout.ts', "'core.symlinks=false',", "'core.symlinks=true',"]],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-converts-eol',
    claim: 'no end-of-line conversion on checkout',
    edits: [['server/agents/checkout.ts', '* -text -ident', '* -ident']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-expands-ident',
    claim: 'no ident expansion on checkout',
    edits: [['server/agents/checkout.ts', ' -ident -filter', ' -filter']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-runs-filters',
    claim: 'no filter runs on checkout',
    edits: [['server/agents/checkout.ts', ' -ident -filter', ' -ident']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-reencodes',
    claim: 'no re-encoding on checkout',
    edits: [['server/agents/checkout.ts', ' !working-tree-encoding', '']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-not-verified',
    claim: 'a checkout that did not happen fails',
    edits: [
      [
        'server/agents/checkout.ts',
        '!== written)\n    throw new AgentFailed(`the files',
        '=== null)\n    throw new AgentFailed(`the files',
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-blobs-uncapped',
    claim: 'the number of blobs read is capped',
    edits: [['server/agents/checkout.ts', 'if (missing.length > MAX_BLOBS)', 'if (missing.length < 0)']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-blob-cap-off-by-one',
    claim: 'the blob cap itself is allowed',
    edits: [['server/agents/checkout.ts', 'if (missing.length > MAX_BLOBS)', 'if (missing.length >= MAX_BLOBS)']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-bytes-uncapped',
    claim: 'the total size of the blobs read is capped',
    edits: [['server/agents/checkout.ts', 'if (bytes > MAX_BLOB_BYTES)', 'if (bytes < 0)']],
    tests: [CHECKOUT],
  },
  {
    name: 'checkout-cap-retried',
    claim: 'a cap failure is marked as not worth a retry',
    edits: [['server/agents/checkout.ts', 'throw new AgentRefused(', 'throw new AgentFailed(']],
    tests: [CHECKOUT],
  },
  {
    name: 'refused-job-retried',
    claim: 'a refused job is not run again',
    edits: [['server/modes/cages.ts', 'error instanceof AgentRefused ? maxFailures : ', '']],
    tests: [CAGES],
  },
  {
    name: 'checkout-same-ignores-mode',
    claim: 'a mode change alone is a difference from the head',
    edits: [['server/agents/checkout.ts', ' && a?.mode === b?.mode', '']],
    tests: [CHECKOUT],
  },
  {
    name: 'github-tree-takes-submodules',
    claim: 'a GitHub submodule has no blob to read',
    edits: [
      [
        'server/githost/github.ts',
        ".filter((e) => str(e, 'type') === 'blob')\n        .map(",
        ".filter((e) => str(e, 'type') !== 'tree')\n        .map(",
      ],
    ],
    tests: [CHECKOUT],
  },
  {
    name: 'gitlab-tree-takes-submodules',
    claim: 'a GitLab submodule has no blob to read',
    edits: [
      [
        'server/githost/gitlab.ts',
        ".filter((e) => str(e, 'type') === 'blob')\n        .map(",
        ".filter((e) => str(e, 'type') !== 'tree')\n        .map(",
      ],
    ],
    tests: [CHECKOUT],
  },
];

class PatternMissing extends Error {}

const { names: only, shard } = parseArgs(process.argv.slice(2));
const chosen = selectMutants(MUTANTS, only, shard);
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

const baseline = vitest([...new Set(chosen.flatMap((m) => m.tests))]);
log(`baseline ${baseline.status === 0 ? 'PASS' : 'FAIL'}`);
if (baseline.status !== 0) {
  console.error(baseline.stdout.slice(-2000));
  process.exit(1);
}

let bad = 0;
for (const mutant of chosen) {
  const originals = new Map();
  try {
    for (const [file, find, replace, all] of mutant.edits) {
      const path = `${ROOT}/${file}`;
      const current = readFileSync(path, 'utf8');
      if (!originals.has(path)) originals.set(path, current);
      try {
        writeFileSync(path, applyEdit(file, current, find, replace, all === 'all'));
      } catch (error) {
        throw new PatternMissing(`${mutant.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const result = vitest(mutant.tests);
    const caught = result.status !== 0;
    const expected = mutant.survives ? !caught : caught;
    if (!expected) bad += 1;
    log(
      `${expected ? 'OK  ' : 'BAD '} ${mutant.name}: ${caught ? 'caught' : 'survived'}${mutant.survives ? ' (expected to survive)' : ''}. Claim: ${mutant.claim}`,
    );
  } catch (error) {
    if (!(error instanceof PatternMissing)) throw error;
    bad += 1;
    log(`BAD  ${error.message}`);
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text);
  }
}
lines.push(`caught ${chosen.length - bad}/${chosen.length}`);
console.log(lines.at(-1));
writeFileSync(
  process.env.MUTANT_OUT ?? join(mkdtempSync(join(tmpdir(), 'mutants-p1-2-')), 'mutants.txt'),
  `${lines.join('\n')}\n`,
);
process.exit(bad === 0 ? 0 : 1);
