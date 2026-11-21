/** @typedef {[from: string, to: string] | [from: string, to: string, file: 'O']} Edit  An edit of lifecycle.ts, or of oracle.ts when the third item is 'O'. */

/** @type {{ name: string, edits: Edit[] }[]} */
export const MUTANTS = [
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
        'const eligible = (login: Login) => !base.builders.includes(login) && rules.canReview(login, author);',
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
        '  a.first - b.first ||\n  compareText(a.repo, b.repo) ||\n  a.number - b.number;',
        '  a.first - b.first ||\n  compareText(keyOf(a), keyOf(b));',
      ],
    ],
  },
  {
    name: 'merged_outranks_first_seen',
    edits: [
      [
        "Number(a.state === 'closed') - Number(b.state === 'closed') ||",
        "Number(b.state === 'merged') - Number(a.state === 'merged') || Number(a.state === 'closed') - Number(b.state === 'closed') ||",
      ],
    ],
  },
  {
    name: 'closed_beats_open',
    edits: [
      [
        "Number(a.state === 'closed') - Number(b.state === 'closed') ||",
        "Number(b.state === 'closed') - Number(a.state === 'closed') ||",
      ],
    ],
  },
  { name: 'last_seen_wins', edits: [['  a.first - b.first ||', '  b.first - a.first ||']] },
  { name: 'first_seen_not_min', edits: [['Math.min(before.first, fact.at)', 'fact.at']] },
  {
    name: 'shipping_not_latched',
    edits: [["box.state !== 'shipping' && box.state !== 'shipped'", "box.state !== 'shipped'"]],
  },
  {
    name: 'repo_case_kept',
    edits: [
      ['const repo = event.repo.toLowerCase();', 'const repo = event.repo;'],
      ['headRepo: event.headRepo.toLowerCase(),', 'headRepo: event.headRepo,'],
    ],
  },
  {
    name: 'only_first_builder_kept',
    edits: [
      [
        'const builders = [...new Set([...box.builders, event.worker])].sort();',
        'const builders = box.builders.length > 0 ? box.builders : [event.worker];',
      ],
    ],
  },
  {
    name: 'cancel_shipped_not_refused',
    edits: [
      [
        "    if (box.state === 'shipping' || box.state === 'shipped')\n      return { state, commands: [alert('cancel_refused', box.id)] };\n",
        '',
      ],
    ],
  },
  { name: 'logins_case_sensitive', edits: [['raw.toLowerCase() as Login', 'raw as Login']] },
  {
    name: 'builder_may_review',
    edits: [['!base.builders.includes(login) && rules.canReview(login, author)', 'rules.canReview(login, author)']],
  },
  {
    name: 'fork_change_accepted',
    edits: [['  if (fact.headRepo !== fact.repo) return state;\n', '']],
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
        'return { state: withBox(state, { ...box, worker: null, builders: [] }), commands: [] };',
      ],
    ],
  },

  { name: 'NONE_baseline', edits: [] },
  {
    name: 'R01_votes_any_head',
    edits: [
      [
        'get(state.reviews, `%{hostRef(change.repo, change.number)}|%{change.head.v}`) ?? {},\n  ).filter',
        'Object.assign({}, ...Object.entries(state.reviews).filter(([k]) => k.startsWith(`%{hostRef(change.repo, change.number)}|`)).map(([, g]) => g)),\n  ).filter',
      ],
    ],
  },
  {
    name: 'R02_approvals_only_from_staff',
    edits: [
      [
        '.filter(([reviewer]) => eligible(reviewer as Login));',
        '.filter(([reviewer]) => eligible(reviewer as Login) && Object.hasOwn(state.staff, reviewer));',
      ],
    ],
  },
  {
    name: 'R03_never_promote_shipped',
    edits: [['const finalBoxes = promoteShipped(settled, shipments);', 'const finalBoxes = settled;']],
  },
  {
    name: 'R04_box_in_two_shipments',
    edits: [
      [
        "    return existing.shipment === spec.id\n      ? { state, commands: [] }\n      : { state, commands: [alert('order_conflict', event.task)] };",
        "    if (existing.shipment === spec.id) return { state, commands: [] };\n    const other = get(state.shipments, spec.id);\n    if (other === undefined || other.members.includes(event.task) || other.members.length >= other.size) return { state, commands: [alert('order_conflict', event.task)] };\n    return { state: { ...state, shipments: put(state.shipments, spec.id, { ...other, members: [...other.members, event.task] }) }, commands: [] };",
      ],
    ],
  },
  {
    name: 'R05_budget_per_project',
    edits: [
      [
        "      if (running < state.config.budget) {\n        running += 1;\n        next = { ...base, state: 'building' };\n      } else next = { ...base, state: 'belt' };",
        "      const project = box.id.split('/')[0];\n      const inProject = live.filter((b) => b.id.split('/')[0] === project && (placed.get(b.id) as { state?: string } | undefined)?.state === 'building').length;\n      if (inProject < state.config.budget) {\n        running += 1;\n        next = { ...base, state: 'building' };\n        placed.set(box.id, next);\n      } else next = { ...base, state: 'belt' };",
      ],
    ],
  },
  {
    name: 'R06_cancelled_building_holds_cage',
    edits: [
      [
        "else if (box.cancelled) placed.set(box.id, { ...base, state: 'cancelled', reason: 'human' });",
        "else if (box.cancelled) { if (box.state === 'building') running += 1; placed.set(box.id, { ...base, state: 'cancelled', reason: 'human' }); }",
      ],
    ],
  },
  {
    name: 'R07_late_new_change_uncancels',
    edits: [
      [
        '  return { ...state, changes: put(state.changes, key, change) };\n}',
        "  const owner = get(state.boxes, taskOfBranch(fact.branch) ?? '');\n  const boxes = before === undefined && owner?.cancelled ? put(state.boxes, owner.id, { ...owner, cancelled: false }) : state.boxes;\n  return { ...state, boxes, changes: put(state.changes, key, change) };\n}",
      ],
    ],
  },
  {
    name: 'R08_changes_request_from_anyone',
    edits: [
      [
        "const changesRequested = votes.some(([, vote]) => vote.v === 'changes');",
        "const changesRequested = Object.values(get(state.reviews, `%{hostRef(change.repo, change.number)}|%{change.head.v}`) ?? {}).some((vote) => vote.v === 'changes');",
      ],
    ],
  },
  {
    name: 'R09_change_key_ignores_repo',
    edits: [['`%{repo}#%{number}@%{branch}` as PrKey;', '`#%{number}@%{branch}` as PrKey;']],
  },
  {
    name: 'R10_stale_poll_beats_webhook',
    edits: [
      [
        '    headSha: poll.headSha,\n    at: poll.at,\n  });\n  for (const check of poll.checks)',
        '    headSha: poll.headSha,\n    at: poll.at + 1_000_000,\n  });\n  for (const check of poll.checks)',
      ],
    ],
  },
  {
    name: 'R11_restart_drops_builder_field',
    edits: [
      [
        "    builders: [],\n    cancelled: false,\n    state: 'belt',",
        "    builders: undefined as unknown as [],\n    cancelled: false,\n    state: 'belt',",
      ],
    ],
  },
  {
    name: 'R12_human_cancel_counts_for_truck',
    edits: [
      [
        "const merged = members.every((box) => box !== undefined && (box.state === 'shipping' || box.state === 'shipped'));",
        "const merged = members.every((box) => box !== undefined && (box.state === 'shipping' || box.state === 'shipped' || (box.state === 'cancelled' && box.reason === 'human')));",
      ],
    ],
  },
  {
    name: 'R13_redispatch_departed',
    edits: [
      [
        '    if (prev?.state === shipment.state) continue;',
        "    if (prev?.state === shipment.state && shipment.state !== 'departed') continue;",
      ],
    ],
  },
  {
    name: 'R14_start_cage_wrong_worker',
    edits: [
      [
        "others.push({ kind: 'start_cage', task: box.id, worker: box.worker });",
        "others.push({ kind: 'start_cage', task: box.id, worker: 'nobody' as Login });",
      ],
    ],
  },
  {
    name: 'R15_request_review_wrong_pr',
    edits: [
      [
        "others.push({ kind: 'request_review', task: box.id, pr: box.pr, reviewer: box.reviewer });",
        "others.push({ kind: 'request_review', task: box.id, pr: (Object.keys(after.changes).sort()[0] ?? box.pr) as PrKey, reviewer: box.reviewer });",
      ],
    ],
  },
  {
    name: 'R16_close_task_wrong_pr',
    edits: [
      [
        "others.push({ kind: 'close_task', task: box.id, pr: box.pr });",
        "others.push({ kind: 'close_task', task: box.id, pr: (Object.keys(after.changes).sort()[0] ?? box.pr) as PrKey });",
      ],
    ],
  },
  {
    name: 'R17_order_conflict_silent',
    edits: [
      [
        "    return { state, commands: [alert('order_conflict', event.task)] };\n  }\n  const members",
        '    return { state, commands: [] };\n  }\n  const members',
      ],
    ],
  },
  {
    name: 'R18_unknown_task_silent',
    edits: [
      [
        "if (box === undefined) return { state, commands: [alert('unknown_task', event.task)] };\n  if (event.kind === 'cancel')",
        "if (box === undefined) return { state, commands: [] };\n  if (event.kind === 'cancel')",
      ],
    ],
  },
  {
    name: 'R19_cancel_beats_merge',
    edits: [
      [
        "  if (change.state === 'merged') return { ...base, state: 'shipping', pr: key };\n  if (base.cancelled) return { ...base, state: 'cancelled', reason: 'human' };",
        "  if (base.cancelled) return { ...base, state: 'cancelled', reason: 'human' };\n  if (change.state === 'merged') return { ...base, state: 'shipping', pr: key };",
      ],
    ],
  },
  {
    name: 'R20_hook_login_case_sensitive',
    edits: [
      [
        "if (event.source === 'hook') return { ...event, worker: toLogin(event.worker) };",
        "if (event.source === 'hook') return event as Event<Login>;",
      ],
    ],
  },
  {
    name: 'R21_checks_any_repo',
    edits: [
      [
        'const checks = Object.values(get(state.checks, `%{change.repo}|%{change.head.v}`) ?? {});',
        'const checks = Object.values(Object.assign({}, ...Object.entries(state.checks).filter(([k]) => k.endsWith(`|%{change.head.v}`)).map(([, g]) => g)));',
      ],
    ],
  },
  {
    name: 'R22_reviewer_never_reassigned',
    edits: [
      [
        "const reviewerChanged = prev?.state === 'qc' && prev.reviewer !== box.reviewer;",
        'const reviewerChanged = false;',
      ],
    ],
  },
  {
    name: 'R23_review_login_case_sensitive',
    edits: [
      [
        "if (event.kind === 'review') return { ...event, repo, reviewer: toLogin(event.reviewer) };",
        "if (event.kind === 'review') return { ...event, repo };",
      ],
    ],
  },
  {
    name: 'R24_branch_moved_silent',
    edits: [
      ["if (sibling && get(before.changes, key) === undefined) others.push(alert('change_branch_moved', key));", ''],
    ],
  },
  {
    name: 'R25_hire_on_any_station',
    edits: [["  if (box.state !== 'belt') return { state, commands: [alert('hire_refused', box.id)] };\n", '']],
  },
  {
    name: 'R26_closed_stray_alerted',
    edits: [
      [
        "    .slice(1)\n    .filter((change) => change.state !== 'closed')\n    .map(keyOf);",
        '    .slice(1)\n    .map(keyOf);',
      ],
    ],
  },
  {
    name: 'R27_poll_reviews_ignored',
    edits: [['  for (const review of poll.reviews) {', '  for (const review of [] as typeof poll.reviews) {']],
  },
  {
    name: 'R28_check_failure_ignored_if_any_success',
    edits: [
      [
        "if (checks.length === 0 || !checks.every((check) => check.v === 'success'))",
        "if (checks.length === 0 || !checks.some((check) => check.v === 'success'))",
      ],
    ],
  },
  {
    name: 'W1_builder_may_review_BOTH',
    edits: [
      ['!base.builders.includes(login) && rules.canReview(login, author)', 'rules.canReview(login, author)'],
      ['return login !== entity.author && !box.builders.has(login);', 'return login !== entity.author;', 'O'],
    ],
  },
  {
    name: 'W2_votes_any_head_BOTH',
    edits: [
      [
        'get(state.reviews, `%{hostRef(change.repo, change.number)}|%{change.head.v}`) ?? {},\n  ).filter',
        'Object.assign({}, ...Object.entries(state.reviews).filter(([k]) => k.startsWith(`%{hostRef(change.repo, change.number)}|`)).map(([, g]) => g)),\n  ).filter',
      ],
      [
        '(fact) => fact.repo === entity.repo && fact.number === entity.number && fact.head === entity.head,',
        '(fact) => fact.repo === entity.repo && fact.number === entity.number,',
        'O',
      ],
    ],
  },
  {
    name: 'W3_votes_ignore_repo_BOTH',
    edits: [
      [
        'const hostRef = (repo: string, number: number): string => `%{repo}#%{number}`;',
        'const hostRef = (_repo: string, number: number): string => `#%{number}`;',
      ],
      [
        '(fact) => fact.repo === entity.repo && fact.number === entity.number && fact.head === entity.head,',
        '(fact) => fact.number === entity.number && fact.head === entity.head,',
        'O',
      ],
    ],
  },
  {
    name: 'W4_checks_any_repo_BOTH',
    edits: [
      [
        'const checks = Object.values(get(state.checks, `%{change.repo}|%{change.head.v}`) ?? {});',
        'const checks = Object.values(Object.assign({}, ...Object.entries(state.checks).filter(([k]) => k.endsWith(`|%{change.head.v}`)).map(([, g]) => g)));',
      ],
      ['(fact) => fact.repo === entity.repo && fact.head === entity.head', '(fact) => fact.head === entity.head', 'O'],
    ],
  },
  {
    name: 'W5_logins_case_sensitive_BOTH',
    edits: [
      ['raw.toLowerCase() as Login', 'raw as Login'],
      [
        'const lower = (text: string): string => text.toLowerCase();',
        'const lower = (text: string): string => text;',
        'O',
      ],
    ],
  },
  {
    name: 'W6_approvals_minus_one_BOTH',
    edits: [
      ['approvals >= state.config.approvals)', 'approvals >= state.config.approvals - 1)'],
      ['approvals >= this.config.approvals) result.set', 'approvals >= this.config.approvals - 1) result.set', 'O'],
    ],
  },
  {
    name: 'W7_truck_ignores_size_BOTH',
    edits: [
      ['const status = complete && merged ?', 'const status = merged ?'],
      ['complete && members.every(', 'members.every(', 'O'],
    ],
  },
  {
    name: 'W8_highest_number_wins_BOTH',
    edits: [
      [
        '  compareText(a.repo, b.repo) ||\n  a.number - b.number;',
        '  compareText(a.repo, b.repo) ||\n  b.number - a.number;',
      ],
      ['a.number < b.number', 'a.number > b.number', 'O'],
    ],
  },
  {
    name: 'W9_hire_on_any_station_BOTH',
    edits: [
      ["  if (box.state !== 'belt') return { state, commands: [alert('hire_refused', box.id)] };\n", ''],
      ["    if (box.station !== 'belt') return [{ reason: 'hire_refused', subject: box.task }];\n", '', 'O'],
    ],
  },
  {
    name: 'W10_cancelled_counts_for_truck_BOTH',
    edits: [
      [
        "const merged = members.every((box) => box !== undefined && (box.state === 'shipping' || box.state === 'shipped'));",
        "const merged = members.every((box) => box !== undefined && (box.state === 'shipping' || box.state === 'shipped' || box.state === 'cancelled'));",
      ],
      [
        "members.every((station) => station === 'shipping' || station === 'shipped')",
        "members.every((station) => station === 'shipping' || station === 'shipped' || station === 'cancelled')",
        'O',
      ],
    ],
  },
  {
    name: 'R06b_cancelled_with_worker_leaks_cage',
    edits: [
      [
        "else if (box.cancelled) placed.set(box.id, { ...base, state: 'cancelled', reason: 'human' });",
        "else if (box.cancelled) { if (box.worker !== null) running += 1; placed.set(box.id, { ...base, state: 'cancelled', reason: 'human' }); }",
      ],
    ],
  },
];
