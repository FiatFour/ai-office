import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SOURCE = readFileSync(join(ROOT, 'packages/core/src/lifecycle.ts'), 'utf8');
const SUITE = ['packages/core/test/lifecycle.invariants.test.ts', 'packages/core/test/lifecycle.convergence.test.ts'];
const DEFAULT_SEEDS = ['20261117', '1', '424242', '987654321'];

/** @type {{ name: string, edits: [string, string][] }[]} */
const MUTANTS = [
  {
    name: 'adopt_foreign_change',
    edits: [
      [
        'const change = index.get(branchOf(box.id))?.[0];',
        'const change = index.get(branchOf(box.id))?.[0] ?? Object.values(state.changes).sort(compareChange)[0];',
      ],
    ],
  },
  {
    name: 'approvals_count_author',
    edits: [
      [
        'const eligible = (login: Login) => login !== base.builder && rules.canReview(login, author);',
        'const eligible = (_login: Login) => true;',
      ],
    ],
  },
  {
    name: 'approvals_off_by_one',
    edits: [['approvals >= state.config.approvals)', 'approvals >= state.config.approvals - 1)']],
  },
  {
    name: 'arrival_order_wins',
    edits: [
      [
        'if (a === undefined || b.at > a.at || (b.at === a.at && b.v > a.v)) return b;',
        'if (a === undefined || b.v !== a.v) return b;',
      ],
    ],
  },
  {
    name: 'author_may_review_case',
    edits: [
      [
        'canReview: (reviewer, author) => reviewer !== author',
        'canReview: (reviewer, author) => reviewer.toUpperCase() !== author',
      ],
    ],
  },
  {
    name: 'budget_off_by_one',
    edits: [['if (running < state.config.budget) {', 'if (running <= state.config.budget) {']],
  },
  {
    name: 'budget_uncounted_running',
    edits: [
      [
        "      running += 1;\n      placed.set(box.id, { ...base, state: 'building' });",
        "      running += 0;\n      placed.set(box.id, { ...base, state: 'building' });",
      ],
    ],
  },
  {
    name: 'cancel_ignored_on_open_pr',
    edits: [
      [
        "  if (base.cancelled) return { ...base, state: 'cancelled', reason: 'human' };\n  if (change.state === 'closed')",
        "  if (change.state === 'closed')",
      ],
    ],
  },
  {
    name: 'cancelled_human_never_alerts_shipment',
    edits: [["if (shipment.state === 'blocked') others.push(alert('shipment_blocked', shipment.id));", '']],
  },
  { name: 'changes_request_ignored', edits: [['if (!changesRequested && approvals >=', 'if (approvals >=']] },
  {
    name: 'double_start_cage',
    edits: [
      ['if (prev === box) continue;', "if (prev === box && box.state !== 'building') continue;"],
      [
        "if (box.state === 'building' && prev?.state !== 'building' && box.worker !== null) {",
        "if (box.state === 'building' && box.worker !== null) {",
      ],
    ],
  },
  {
    name: 'dup_review_double_counted',
    edits: [
      [
        'const before = get(group, fact.reviewer);\n  const joined = joinStamped(before, incoming);\n  if (joined === before) return state;\n  return { ...state, reviews: put(state.reviews, key, put(group, fact.reviewer, joined)) };',
        'const slot = `%{fact.reviewer}@%{fact.at}`;\n  const before = get(group, slot);\n  const joined = joinStamped(before, incoming);\n  if (joined === before) return state;\n  return { ...state, reviews: put(state.reviews, key, put(group, slot, joined)) };',
      ],
    ],
  },
  {
    name: 'follow_last_change',
    edits: [
      ['const change = index.get(branchOf(box.id))?.[0];', 'const change = index.get(branchOf(box.id))?.at(-1);'],
    ],
  },
  {
    name: 'global_seq',
    edits: [
      ['export type TaskId = string;', 'const GLOBAL = { n: 0 };\nexport type TaskId = string;'],
      ['seq: state.seq,\n    worker: null,', 'seq: GLOBAL.n++,\n    worker: null,'],
    ],
  },
  {
    name: 'keep_building_with_pr',
    edits: [
      [
        'if (change !== undefined) placed.set(box.id, placeOnChange(state, rules, base, change));',
        "if (change !== undefined && box.state === 'building') {\n      running += 1;\n      placed.set(box.id, { ...base, state: 'building' });\n    } else if (change !== undefined) placed.set(box.id, placeOnChange(state, rules, base, change));",
      ],
    ],
  },
  {
    name: 'merge_cmd_disguised_alert',
    edits: [
      [
        "others.push({ kind: 'notify_ready', task: box.id, pr: box.pr });",
        "{ others.push({ kind: 'notify_ready', task: box.id, pr: box.pr }); others.push({ kind: 'alert_human', reason: 'shipment_blocked', subject: `gh pr merge %{box.pr}` }); }",
      ],
    ],
  },
  {
    name: 'merge_cmd_on_ready',
    edits: [
      [
        "others.push({ kind: 'notify_ready', task: box.id, pr: box.pr });",
        "{ others.push({ kind: 'notify_ready', task: box.id, pr: box.pr }); others.push({ kind: 'merge_pr', task: box.id } as unknown as Command); }",
      ],
    ],
  },
  {
    name: 'merged_not_absorbing',
    edits: [
      [
        "  if (a.state === 'merged') return { state: 'merged', at: state === 'merged' ? Math.max(a.at, at) : a.at };\n",
        '',
      ],
    ],
  },
  {
    name: 'mutate_input_state',
    edits: [
      [
        '    boxes[box.id] = next;\n',
        '    boxes[box.id] = next;\n    try { (state.boxes as Record<string, Box>)[box.id] = next; } catch {}\n',
      ],
    ],
  },
  { name: 'never_release_cage', edits: [["releases.push({ kind: 'release_cage', task: box.id });", '']] },
  { name: 'reviewer_ignores_rule', edits: [['.find(eligible) ?? null;', '.find(() => true) ?? null;']] },
  {
    name: 'stale_head_review',
    edits: [
      [
        'const key = `%{hostRef(fact.repo, fact.number)}|%{fact.headSha}`;',
        'const current = Object.values(state.changes).find((c) => c.repo === fact.repo && c.number === fact.number);\n  const key = `%{hostRef(fact.repo, fact.number)}|%{current?.head.v ?? fact.headSha}`;',
      ],
    ],
  },
  {
    name: 'truck_any_merged',
    edits: [
      [
        "const merged = members.every((box) => box !== undefined && (box.state === 'shipping'",
        "const merged = members.some((box) => box !== undefined && (box.state === 'shipping'",
      ],
    ],
  },
  {
    name: 'truck_cancelled_counts',
    edits: [
      [
        "(box.state === 'shipping' || box.state === 'shipped'));\n    const stuck",
        "(box.state === 'shipping' || box.state === 'shipped' || box.state === 'cancelled'));\n    const stuck",
      ],
    ],
  },
  { name: 'truck_ignores_size', edits: [['const status = complete && merged ?', 'const status = merged ?']] },
  {
    name: 'lexicographic_pr_order',
    edits: [
      [
        'LIFE_PREFERENCE[a.state] - LIFE_PREFERENCE[b.state] || compareText(a.repo, b.repo) || a.number - b.number',
        'LIFE_PREFERENCE[a.state] - LIFE_PREFERENCE[b.state] || compareText(keyOf(a), keyOf(b))',
      ],
    ],
  },
  { name: 'merged_not_preferred', edits: [['{ merged: 0, open: 1, closed: 2 }', '{ merged: 1, open: 0, closed: 2 }']] },
  { name: 'closed_beats_open', edits: [['{ merged: 0, open: 1, closed: 2 }', '{ merged: 0, open: 2, closed: 1 }']] },
  { name: 'logins_case_sensitive', edits: [['raw.toLowerCase() as Login', 'raw as Login']] },
  {
    name: 'builder_may_review',
    edits: [['login !== base.builder && rules.canReview(login, author)', 'rules.canReview(login, author)']],
  },
  {
    name: 'fork_change_accepted',
    edits: [['  if (fact.headRepo.toLowerCase() !== fact.repo.toLowerCase()) return state;\n', '']],
  },
  { name: 'starts_before_releases', edits: [['return [...releases, ...others];', 'return [...others, ...releases];']] },
  {
    name: 'duplicate_pr_not_alerted',
    edits: [["if (!known.has(stray)) others.push(alert('duplicate_pr', stray));", '']],
  },
  {
    name: 'builder_forgotten_on_session_end',
    edits: [
      [
        'return { state: withBox(state, { ...box, worker: null }), commands: [] };',
        'return { state: withBox(state, { ...box, worker: null, builder: null }), commands: [] };',
      ],
    ],
  },
];

/** @param {string} source @param {[string, string][]} edits */
function apply(source, edits) {
  let text = source;
  for (const [rawFrom, rawTo] of edits) {
    const from = rawFrom.replaceAll('%{', '$' + '{');
    const to = rawTo.replaceAll('%{', '$' + '{');
    if (!text.includes(from)) throw new Error(`pattern not found: ${from.slice(0, 80)}`);
    text = text.replace(from, () => to);
  }
  return text;
}

/** @param {string} file @param {string} seed @param {string} outFile */
function runSuite(file, seed, outFile) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`, ...SUITE], {
      cwd: ROOT,
      env: { ...process.env, LIFECYCLE_MODULE: file, LIFECYCLE_SEED: seed },
      stdio: 'ignore',
    });
    child.on('exit', resolve);
  });
}

/** @param {string} outFile */
function failures(outFile) {
  const report = JSON.parse(readFileSync(outFile, 'utf8'));
  /** @type {{ lane: string, message: string }[]} */
  const failed = [];
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status === 'failed')
        failed.push({
          lane: test.title.slice(0, 40),
          message: (String(test.failureMessages?.[0] ?? '').split('\n')[0] ?? '').slice(0, 110),
        });
    }
  }
  return failed;
}

const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const seeds = process.argv[3] ? process.argv[3].split(',') : DEFAULT_SEEDS;
const parallel = Number(process.argv[4] ?? 6);
const dir = mkdtempSync(join(tmpdir(), 'mutants-'));
mkdirSync(join(dir, 'out'), { recursive: true });
const jobs = MUTANTS.filter((mutant) => only === null || only.includes(mutant.name));
/** @type {string[]} */
const lines = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const mutant = /** @type {(typeof jobs)[number]} */ (jobs[next++]);
    const file = join(dir, `${mutant.name}.ts`);
    writeFileSync(file, apply(SOURCE, mutant.edits));
    /** @type {string[]} */
    const cells = [];
    for (const seed of seeds) {
      const outFile = join(dir, 'out', `${mutant.name}-${seed}.json`);
      await runSuite(file, seed, outFile);
      const failed = failures(outFile);
      cells.push(
        failed.length === 0
          ? `seed ${seed}: MISSED`
          : `seed ${seed}: CAUGHT by ${failed.map((one) => one.lane).join(' | ')} :: ${failed[0]?.message}`,
      );
    }
    lines.push(`${mutant.name}\n  ${cells.join('\n  ')}`);
    process.stdout.write(`${lines.at(-1)}\n`);
  }
}
await Promise.all(Array.from({ length: parallel }, worker));
const missed = lines.filter((line) => line.includes('MISSED')).length;
process.stdout.write(`\nmutants: ${jobs.length}, with a missed seed: ${missed}\n`);
