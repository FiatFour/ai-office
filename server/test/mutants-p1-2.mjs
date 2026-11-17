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
const SANITIZE = 'server/test/sanitize.test.ts';
const KILL = 'server/test/kill-push.test.ts';
const DOCKER = 'server/test/sandbox/cage-shell.test.ts';
const CLI = 'server/test/cli.test.ts';

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
        'const rule = rules.find((r) => r.method === method && r.path.test(pathname));',
        'const rule = rules.find((r) => r.method === method && r.path.test(pathname)) ?? { method, path: /./ };',
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
    edits: [['server/modes/cages.ts', 'if (site === undefined || !denials.has(site))', 'if (site === undefined)']],
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
        "  { method: 'POST', path: route('issues/\\\\d+/comments') },",
        "  { method: 'POST', path: route('issues/\\\\d+/comments') },\n  { method: 'PUT', path: /\\/merge$/ },",
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
    edits: [['server/agents/claude-code.ts', "'-c', 'core.fsmonitor=false', ", '']],
    tests: [AGENTS],
  },
  {
    name: 'v-draft-pr',
    claim: 'a PR opens ready, not as a draft',
    edits: [['server/githost/github.ts', 'draft: false,', 'draft: true,']],
    tests: [CONTRACT, CAGES],
  },
  {
    name: 'v-gitlab-closed-as-merged',
    claim: 'a closed, unmerged MR is not merged',
    edits: [['server/githost/gitlab.ts', "  closed: 'closed',\n  merged", "  closed: 'merged',\n  merged"]],
    tests: [CONTRACT],
  },
  {
    name: 'v-github-closed-as-merged',
    claim: 'a closed, unmerged PR is closed',
    edits: [['server/githost/github.ts', "{ open: 'open', closed: 'closed' }", "{ open: 'open', closed: 'merged' }"]],
    tests: [CONTRACT],
  },
  {
    name: 'v-outdated-line-null',
    claim: 'an outdated comment falls back to original_line',
    edits: [['server/githost/github.ts', "? optLine(c, 'original_line')", '? null']],
    tests: [CONTRACT, CAGES],
  },
  {
    name: 'v-gitlab-skipped-success',
    claim: 'a skipped GitLab pipeline is not success',
    edits: [['server/githost/gitlab.ts', "skipped: 'skipped',", "skipped: 'success',"]],
    tests: [CONTRACT],
  },
  {
    name: 'v-neutral-failure',
    claim: 'a neutral check run passes',
    edits: [['server/githost/github.ts', "neutral: 'success',", "neutral: 'failure',"]],
    tests: [CONTRACT],
  },
  {
    name: 'v-checks-any-head',
    claim: 'a poll keeps only checks on the current head',
    edits: [['server/githost/host.ts', '.filter((check) => check.headSha === headSha)', '.filter(() => true)']],
    tests: [CONTRACT, CAGES],
  },
  {
    name: 'v-poll-latest-earliest',
    claim: 'the latest review per reviewer wins',
    edits: [['server/githost/host.ts', 'review.at >= seen.at', 'review.at <= seen.at']],
    tests: [CONTRACT, CAGES],
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
    tests: [CONTRACT],
  },
  {
    name: 'v-guard-no-%2f',
    claim: 'the GitLab project id is decoded and each segment checked, so %2F.. is refused',
    edits: [['server/githost/host.ts', 'if (!PROJECT_PATH.test(project)) return', 'if (false) return']],
    tests: [CONTRACT],
  },
  {
    name: 'v-contents-dotfile',
    claim: 'a pushed file path may not have a hidden segment (.github)',
    edits: [['server/githost/host.ts', " && !segment.startsWith('.')", '']],
    tests: [CONTRACT],
  },
  {
    name: 'v-gitlab-approve-always',
    claim: 'GitLab approves only on an approve verdict',
    edits: [['server/githost/gitlab.ts', "if (draft.verdict === 'approve')\n", 'if (true)\n']],
    tests: [CONTRACT, CAGES],
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
    edits: [['server/agents/runtime.ts', '(c.line as number) < 1 ||', '']],
    tests: [AGENTS],
  },
  {
    name: 'v-allow-case-insensitive',
    claim: 'Allow turns an IDN name into its ASCII form before it matches a denial (M9 replaced exact match)',
    edits: [
      [
        'server/modes/cages.ts',
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
    tests: [CONTRACT, CAGES],
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
    edits: [['server/brief/merge-brief.ts', 'input.files.map((file) => inlineCode(file))', 'input.files']],
    tests: [SANITIZE],
  },
  {
    name: 'b1-guard-skips-body',
    claim: 'the write guard checks every body, not only the method and path',
    edits: [
      [
        'server/githost/host.ts',
        'return textProblem(body as Record<string, unknown>) ?? rule.body?.(body as Record<string, unknown>) ?? null;',
        'return rule.body?.(body as Record<string, unknown>) ?? null;',
      ],
    ],
    tests: [CONTRACT, SANITIZE],
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
    tests: [CONTRACT],
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
    tests: [CONTRACT],
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
    tests: [CONTRACT],
  },
  {
    name: 'b1-no-length-cap',
    claim: 'a body longer than the cap is refused',
    edits: [['server/githost/sanitize.ts', 'if (text.length > MAX_BODY)', 'if (false)']],
    tests: [CONTRACT],
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
    tests: [CONTRACT, CAGES],
  },
  {
    name: 'm2-gitlab-marker-any-author',
    claim: 'a GitLab note marker counts only on a note the HQ account wrote',
    edits: [['server/githost/gitlab.ts', "(n) => str(n, 'author.username').toLowerCase() === self &&", '(n) =>']],
    tests: [CONTRACT],
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
    tests: [CONTRACT],
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
    tests: [CONTRACT],
  },
  {
    name: 'm4-symlink-tree',
    claim: 'a pushed tree holds only plain files',
    edits: [['server/githost/github.ts', '!MODES.has(entry.mode) || ', '']],
    tests: [CONTRACT],
  },
  {
    name: 'm4-gitlab-any-case',
    claim: 'GitLab write routes match by exact case',
    edits: [
      ['server/githost/gitlab.ts', 'new RegExp(`^${PROJECT}/${tail}$`)', "new RegExp(`^${PROJECT}/${tail}$`, 'i')"],
    ],
    tests: [CONTRACT],
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
    tests: [CONTRACT],
  },
  {
    name: 'm6-prompt-in-argv',
    claim: 'the prompt goes to the agent on stdin, not in argv',
    edits: [
      [
        'server/agents/claude-code.ts',
        'const ran = await shell.exec(argv, { input: promptFor(job), timeoutMs:',
        'const ran = await shell.exec([...argv, promptFor(job)], { timeoutMs:',
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
        'server/modes/cages.ts',
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
        'server/modes/cages.ts',
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
];

class PatternMissing extends Error {}

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
      if (!current.includes(find)) throw new PatternMissing(`${mutant.name}: pattern not found in ${file}`);
      writeFileSync(path, current.replace(find, replace));
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
writeFileSync(process.env.MUTANT_OUT ?? '/tmp/mutants-p1-2.txt', `${lines.join('\n')}\n`);
process.exit(bad === 0 ? 0 : 1);
