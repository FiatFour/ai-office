# Task lifecycle as a checked reducer

This page describes `packages/core/src/lifecycle.ts`, the pure model of how a box, its change (a PR on GitHub, an MR on GitLab) and its shipment move. HQ feeds it hook, webhook, poll and human events. It returns the next state and a list of commands for HQ to carry out. No command can merge, so the rule "HQ never merges" holds because the type has no such command, and a test also checks it.

The model has no I/O, no clock and no randomness. Every timestamp comes in on an event.

## Rerun it

```sh
pnpm test packages/core
LIFECYCLE_EVIDENCE_DIR=/tmp/swarm-P0-7/owner-r2/lanes pnpm test packages/core
LIFECYCLE_SEED=1 pnpm test packages/core
pnpm vitest run --config packages/core/vitest.perf.config.ts
node scripts/mutate-core.mjs all
```

The first prints each invariant with its run count and seed. The second also writes one file per lane. The third reruns every property under another seed (the default is 20261117, fixed, so a failure reproduces). The fourth is the throughput probe. It lives in `packages/core/test/lifecycle.perf.ts`, which the default `pnpm test` never collects, so it cannot be skipped by accident. CI runs it and then `scripts/check-throughput.mjs`, which fails unless three small-state runs and a large-state median were printed with a numeric events per second. The fifth applies 34 deliberately wrong versions of `lifecycle.ts` and reports which property catches each, under four seeds.

## The data shape

| Type | Shape | Notes |
| --- | --- | --- |
| `Login` | `string` branded as `Login`, lower-cased once by `toLogin` | Every event enters through `reduce`, which converts each login field once. The state, the rules and the commands only hold `Login`. A raw string no longer type-checks where a login is wanted. |
| `Box` | Union by `state`: `belt`, `building`, `test`, `qc`, `merge`, `shipping`, `shipped`, `cancelled` | The state is the station. A box holds its task id, shipment id, order number, the worker of the current session, the `builder` (the last login hired, kept after the session ends) and a `cancelled` flag. `qc` also holds the assigned reviewer and whether changes were requested. |
| `Change` | Union by `state`: `open`, `closed`, `merged`, keyed by `repo#number@branch` | Holds the repo, the number (a number, never part of a sorted string), the branch the PR was first seen on, the author and the head sha, the last two stamped with the host time of the event that set them. `merged` absorbs every later event. A PR whose head repo is not its base repo is dropped on arrival. |
| `Shipment` | Union by `state`: `loading`, `blocked`, `departed` | Holds its declared size and member task ids. A single task ships alone, in a shipment named after the task. |
| `State` | `{ config, seq, staff, boxes, changes, checks, reviews, shipments }` | Plain JSON. No `Map`, no `Set`, no `undefined`, so `JSON.parse(JSON.stringify(state))` is the same state. |
| `Event` | `human`, `hook`, `webhook` and `poll` | See the table below. |
| `Command` | `start_cage`, `release_cage`, `request_review`, `send_review_to_author`, `notify_ready`, `close_task`, `dispatch_truck`, `alert_human` | Eight kinds. There is no merge kind. |

`reduce(state, event)` returns `{ state, commands }`. `createReducer(rules)` builds the same function from a rule set. The only rule today is `canReview(reviewer, author)`, which the mutant lane overrides.

### Events

| Source | Event | What it sets |
| --- | --- | --- |
| human | `add_worker` | Puts a login in the staff list that reviewers are drawn from. |
| human | `order` | Creates a box on the belt in its shipment. A shipment declares its size on its first order. |
| human | `hire` | Names the worker for a box on the belt. The box starts building when a cage is free, otherwise it waits. |
| human | `cancel` | Cancels a box that has no merged change. |
| hook | `session_ended` | The worker's session ended. Clears the worker, so a box that was building and has no PR goes back to the belt. |
| webhook | `change`, `review`, `check` | Facts about a change on the host. Each carries the host time `at`. |
| poll | one snapshot of a change | The same facts as the three webhook events, in one object. |

A webhook or poll event is a fact, not an instruction. Facts join by last write wins on `at`, with the value as tie-break, except that `merged` always wins. A join is commutative, associative and idempotent, so the reducer cannot tell a duplicate or a late delivery from the original. After each event the reducer derives every box's station from the facts that exist. It never moves a box because of the event that arrived.

What a host adapter must supply on a `change` fact or a poll: repo (the base repo), head repo, number, head branch, author login, state, head sha and host time. Review facts carry the reviewer login and the sha they were given on. P0-4's `GitHostEvent` drops the author, reviewer, review commit, head repo and every timestamp, and the P1-2 parser must keep all of them.

### Which change a box follows

A change is identified by repo, number and branch (`repo#number@branch`). A box follows one change on its branch `aw/<task>`, chosen only from the facts, so arrival order cannot change the choice.

1. A merged change wins over an open one, and an open one over a closed one. A merged change is code that landed, so a box can never be pulled back from shipping by a later PR on its branch. A box that has `shipped` is frozen: it keeps the change it shipped on, and the reducer does not look at it again.
2. Within one kind, the lower repo name and then the lower number as a number wins. `r#9` comes before `r#10`. An earlier version compared the keys as strings and put `r#10` first.
3. Every other open or merged change on the branch is a stray. It never moves the box, and `duplicate_pr` is raised once when it appears.

A closed change is history. When the agent opens a replacement PR after a close, the replacement is open, so it outranks the closed one and the box follows it from `cancelled` back to `test`. This is the documented rule that answers "the box and its shipment stay stuck after a cancel". A human `cancel` is different: the box stays cancelled whatever the PR does, until it ships on a merged change.

**A PR whose head branch changes (M1).** On GitHub renaming the head branch closes the PR, and GitLab behaviour is unverified, so the model does not assume a PR keeps its branch. A fact for the same repo and number on another branch is a different change, identified by its own key. The first change keeps its box and keeps its facts. The new one may be followed by the box of the other branch, and `change_branch_moved` is raised so a person sees it. Nothing restarts silently. Reviews are keyed by repo, number and head sha, because a review fact carries no branch, so the two changes share the reviews of one sha. That is a corner of a corner and is not worth another key.

**Fork PRs.** A change whose head repo differs from its base repo (compared without regard to case) is dropped on arrival, like a branch that is not `aw/<task>`. A fork can name its branch `aw/x/y`, so without this rule a stranger's PR could claim a task. The dropped fact raises no alert, because a dropped fact leaves the state unchanged and the reducer emits commands only from a change in state. The adapter must supply the head repo, see G1.

### Logins

GitHub and GitLab logins are case-insensitive. `toLogin` lower-cases a login once, where the event enters `reduce`, and the type `Login` is what the state, the rules and every command hold. `add_worker fiatfour` and an author `FiatFour` are the same account. Aliases, renamed accounts, bot accounts (`app[bot]`) and a human who uses two accounts are not modelled. The host adapter must map each person or app to one canonical login before it builds an event. Commands carry the lower-cased login, so an executor must not use it where the host is case-sensitive.

The builder is a box's `worker`, a name HQ chose with `hire`. The author is the login the host reports on the PR. The model assumes they are the same account and also refuses the hired name as reviewer, because a cage may push under a name that differs from the author the host reports. The refusal survives the end of the session (`builder` is kept when `worker` is cleared). The mapping from a worker name to a host login is a G1 question.

## State diagram

```mermaid
stateDiagram-v2
  [*] --> belt: order
  belt --> building: hire, and a cage is free
  building --> belt: session_ended with no PR
  belt --> test: change seen
  building --> test: change seen
  test --> qc: every check on the head is green
  qc --> merge: enough peer approvals, no changes requested
  merge --> qc: a peer asks for changes
  merge --> test: head moves, checks reset
  qc --> test: head moves, checks reset
  belt --> shipping: change merged
  building --> shipping: change merged
  test --> shipping: change merged
  qc --> shipping: change merged
  merge --> shipping: change merged, a human merged it on the host
  shipping --> shipped: every box in the shipment is merged, truck departs
  belt --> cancelled: cancel
  building --> cancelled: cancel
  test --> cancelled: change closed unmerged
  qc --> cancelled: change closed unmerged
  merge --> cancelled: change closed unmerged
  cancelled --> test: change reopened, or an open replacement PR appears
  shipped --> [*]
```

A shipment is `loading` until every declared member exists and is merged, `blocked` while a member is cancelled, and `departed` after that. `departed` is terminal. The reducer never recomputes a departed shipment, a box of a departed shipment is `shipped`, and a later PR on the same branch is a stray with an alert. The property suite checks the transition on every step: a departed shipment is never `loading` again, a shipped box never leaves `shipped`, and `dispatch_truck` appears at most once per shipment over a whole run.

Cages are counted, not numbered. A box holds a cage exactly while it is `building`. A box leaves `building` when its PR appears, when its session ends without one, or when it is cancelled. The model does not send a box back through the belt after a review asks for changes. The author gets the comments (`send_review_to_author`) and the next push is a new head. Whether the revision needs a cage is a question for P1-1.

## Commands come from the change in state

The reducer compares the state before and after an event and emits a command for each transition: `start_cage` and `release_cage` when a box enters or leaves `building`, `request_review` and `send_review_to_author` at `qc`, `notify_ready` when a box reaches `merge`, `close_task` when its change is merged, `dispatch_truck` when a shipment departs and `alert_human` for the cases a person must see. A duplicate event changes no state, so it emits no command. A command that must survive a crash needs an outbox in the state store, see G1 below.

An alert caused by a rejected human or hook event (an order that conflicts with its shipment, a hire for an unknown task) is emitted again if that event is delivered again.

**Order inside one batch.** All `release_cage` commands come before every `start_cage`. One event can free a cage and fill another (a PR appears on a building box, and a waiting box starts). The first version emitted the start first. An executor that runs the batch in order would then have budget plus one cages for a moment.

**How a stopping cage is modelled.** It is not. The model has two cage states for a box, building or not. `release_cage` means "this cage no longer counts", and the reducer frees the slot at once. The command stream property replays every batch in order and asserts that starts minus releases equals the running cages, per task, and never exceeds the budget at any prefix. The reducer's order is therefore safe for an executor that runs commands in order and waits for each release to finish before it runs the next command. An executor that fires the batch in parallel, or lets a release finish later than its start, can overshoot while the old cage stops. That is a P1-1 requirement, and the alternative (a `stopping` station and a `cage_stopped` hook event, so the slot is freed only on the acknowledgement) is a G1 question.

**Every merge is a human event.** There is no merge command. The command stream property also asserts that every command kind is one of the eight, that no string a command carries (task, shipment, change key, login) mentions a merge, that every alert reason is one of nine, and that every alert subject names something that exists in the factory or in the event. A merge disguised as an alert subject therefore fails. A box begins shipping only on a host change fact (webhook or poll) or on the order of a task whose branch already has a merged change, never on a review, a check, a hire, a cancel or a hook event.

## Invariants and how each is checked

The checker is a separate program, `packages/core/test/oracle.ts`. It imports no value from the reducer, only its types. It keeps its own data layout: append-only arrays of the facts and human decisions it has seen, a flat ledger of boxes and shipments, its own lower-casing of logins, and its own grouping of changes by repo, number and branch. After every event it recomputes from scratch what each box, reviewer and shipment must be, and compares that with the reducer's state. It is slow on purpose. A bug in the reducer's `branchIndex`, its login comparison or its key sort cannot pass here as well, because none of that code is shared. The two compare their answers, so a mistake would have to be made the same way twice.

Two monitors do the checking. The **stream monitor** looks at transitions and commands and needs no recomputation, so it runs on 100,000 sequences. The **oracle** adds the reference model and runs on 20,000. Both run on a generator that mixes hostile random events (random ids, conflicting shipments, a second PR on one branch, a PR that moves branch, a fork PR, mixed-case logins, PR numbers 1 to 30 and 98 to 101) with generated stories that walk tasks from order to merge: stale reviews, a second peer, changes requested then approved, a rename, a closed PR with a replacement, and shipments of two or three boxes. All sequences use one fixed seed (20261117, or `LIFECYCLE_SEED`) so a failure reproduces.

| Invariant | What is asserted | Lane |
| --- | --- | --- |
| HQ never merges | Every command kind is one of the eight and no string a command carries mentions a merge. Every alert reason is one of the nine and every alert subject names a task, shipment or change that exists, or the task in the event. A box begins shipping only on a host change fact or on an order that finds one. | 2, 100,000 and 20,000 sequences |
| 1 task = 1 branch = 1 PR | A box follows a change that exists, whose branch is `aw/<task>`, and no change belongs to two boxes. | 3 |
| The author and the builder never review | A box in `qc` never has the author or the builder as reviewer. A box in `merge` has at least the configured number of approvals from other logins and no changes request from one. Case does not matter. | 4 |
| A box is at exactly one station | The station is one of eight. A PR station has a change, `belt` and `building` have none, and `building` has a worker. | 5 |
| The truck leaves only when every PR in its shipment is merged | A departed shipment has every declared member, each with a merged change. `dispatch_truck` appears only for a shipment that departs in that step, and only once per shipment in a run. | 6 |
| Nothing exceeds the machine budget | At most `budget` boxes are `building`. | 7 |
| Duplicates and reordering | Duplicating and permuting the webhook and poll events after a fixed setup gives the in-order end state, including when a branch has two changes. A repeated event returns the same state object and no command. | 8 |
| Restart | Cut a sequence at a random point, `JSON.stringify` the state, parse it and continue. The end state and the whole command list equal the uncut run. | 9 |
| The checks are not vacuous | Seven wrong reducers (author may review, truck leaves early, a merge command, a merge hidden in an alert, start before release, a shipped box sent back, a second truck) each get a counterexample from the invariant meant to catch them. | 10 |
| Transitions and command streams | A departed shipment never becomes `loading` again. A box never leaves `shipped`, and `shipping` only goes to `shipped`. `dispatch_truck` and `close_task` appear once per shipment and task. Replaying the commands of the whole run in order, starts minus releases equals the boxes that are building, per task, and never passes the budget at any prefix. `notify_ready` is emitted exactly once when a box enters `merge`. | 11, 100,000 and 20,000 sequences |
| The reducer equals the reference model | Every box's station, change, reviewer, worker, builder and cancelled flag, and every shipment's members and state, equal what the oracle derives from the events. | 12 |
| Purity | `reduce` leaves its input state and event unchanged, and returns the same result when the input is deep-frozen. | 13 |
| Liveness | From the state at the end of a random sequence, a recovery script of human and host events (fill the shipment, hire, open a PR where there is none, make the checks green, approve, merge) ends with every box shipped, or cancelled by a human, or merged in a shipment that holds a human-cancelled box. | 14 |
| The generator reaches the states the other lanes rely on | Each of stale-head review, budget full with a waiting box, a multi-box shipment departing, a merge while at `merge`, a second peer review, a rename, a replacement PR, a later PR after shipment and a fork change occurs in some sequences out of 20,000. Lane 15 fails if one is zero. | 15 |

Reordering holds because the facts are joins and the choice of change is derived from them. A PR that changes branch no longer breaks it, because the branch is part of the change's identity. One case is outside the claim and the lane skips it, counting the skips: two changes on one branch that both merge. The box ships on the first one it saw merged and then stays frozen, so which change it names depends on arrival order. The state is `shipped` either way, and the stray merged change raises `duplicate_pr`. It holds for a webhook that arrives before the order, the hire or the PR it refers to. It does not hold for reordering human events, because a hire that comes before an order means something else.

**Dead ends.** The liveness lane is "liveness-lite". It asserts that an exit exists from the states the generator reaches, by running one recovery script, not that every schedule ends. A human-cancelled box is a deliberate end. A shipment that holds one cannot depart, because a shipment's size is fixed. The human's way out is to order the work again under a new shipment. Whether to add a resize event is a G1 question.

## Replay of the P0-4 fixtures

`spikes/P0-4/fixtures/github/` holds single recorded deliveries, not one ordered log, and they come from three different PRs. The test parses each with the P0-4 `parseEvent`, adds the fields the parser drops (author, reviewer, review commit, host time) and replays them in the order they happened on scratch PR #1. Steps the one-account scratch repo cannot produce are labelled `synthetic` in the output: the peer approval, and the merge webhook, which P0-4 lane 10 never recorded. The merge is the recorded `opened` body with `closed` and `merged: true`, the same edit the P0-4 parse test makes.

The recorded review is state `commented`, so the reducer would not count it as an approval whoever wrote it. By itself it proves little about the self-review rule. A second case therefore takes the same recorded body and sets its state to `approved` (labelled `synthetic`), and the box still does not move. The self-review rule is proved by that case and by the property lanes, not by the recorded fixture.

Result: the recorded author review is refused, the box stops at `qc` with `peer-reviewer` assigned, the peer approval moves it to `merge`, and the merge ends it in `shipped` with the change `merged`. The recorded `closed` payload for PR #2 (not merged) cancels its box and blocks its shipment, and the merged variant ships it. `push` and `pull_request_review_comment` map to no event, because a pull request event already carries the new head and a comment says nothing about the verdict. GitLab fixtures are docs examples, not recordings, and GitLab did not run (G0), so they are not replayed.

What the replay found: P0-4's `GitHostEvent` drops `pull_request.user.login`, `review.user.login`, `review.commit_id`, `pull_request.head.repo.full_name` and every timestamp. The reducer needs all five. The P1-2 parser must keep them.

## Numbers

Measured on 2026-11-17 on a WSL2 machine with 24 cores, Node 24.21, no baseline, trunk empty. Nothing else ran during the throughput runs. CI numbers are in the PR.

| Metric | Value | Rule |
| --- | --- | --- |
| Throughput, small states: 1,000,000 generated events in 5,000 runs of 200, each run from an empty state, three runs | 224,044, 246,817 and 244,982 events per second | at least 10,000 |
| Throughput, large state: 24,000 events for 3,000 tasks ordered and merged 25 at a time, the state never reset and nothing pruned | 6,189 events per second with 638 boxes held, 1,401 at 1,260, 656 at 1,886 and 434 at 2,511 | reported, no floor |
| Property suite (41 tests), three runs | 26.4, 24.5 and 23.9 seconds | median at most 120 |

**What the small-state number means.** It is the cost of one event when the factory holds at most six boxes, which is the case the generator reaches. The first version of this model measured about 390,000. The extra work since is the canonical login conversion, the builder rule and the choice of change by rank. A profile of the run puts the time in allocation: `sameShallow` comparing every box, the record copies in `put`, the per-event index of changes by branch, and the command diff. One thread does all of it, which is why more cores do not help. The generated events are random, so most of them change nothing or fail a guard, and the number is a floor for cheap events, not a forecast of real traffic.

**What the large-state number means.** The cost per event grows with the number of boxes and changes the state holds, at about one microsecond per box. The state keeps every box and every change it has seen, and each event copies the records it touches and scans the boxes and changes once or twice. A profile at 2,500 boxes puts 24% in `settle`, 19% in `put`, 13% in `commandsBetween`, 12% in `changesByBranch`, 11% in `promoteShipped` and 8% in `strayKeys`. All are linear passes. Skipping shipped boxes in `settle` and skipping unchanged records raised the 1,000-box result from 1,575 to 4,471 events per second, and what is left is the passes above. HQ's real event rate is a guess (webhooks and polls, a few per second at most), and at that rate 434 events per second at 2,500 held boxes is enough. The state still needs a pruning rule: move a shipped box, its change and the facts of its heads into an archive when the shipment departs. That is the G1 storage question below, and it should keep the large-state number near the small-state one. That is a prediction, not a measurement.

The state also holds every check and review for every head it has seen. Nothing is pruned before G1 decides, because pruning earlier would break reordering.

## What the operator decides at G1

**State storage.** The reducer needs one JSON document and one total order of events. Two shapes fit. A snapshot file replaced by an atomic rename, with the event log beside it. Or SQLite with a `state` row and an append-only `events` table written in one transaction. Both give restart equals uncut run, which lane 9 checks. Two things the store must add. An outbox, so a crash between saving the state and carrying out a command does not drop the command, and commands run at least once. And a pruning rule for the check and review facts of heads that a merged or closed change superseded, which cannot be done earlier without breaking reordering.

**Message protocol event schema.** The `Event` union above is a proposal. It names the fields a host adapter must supply: repo, number, branch, author login, reviewer login, head sha and host time. Open points: what the cage hooks send besides `session_ended` (the model has no `session_started`, and `start_cage` has no acknowledgement event), whether a hire should carry a runtime and a role, and whether the human events become Action item answers.

**Checker.** Property tests with fast-check are the default and are what runs here. The reference model in `oracle.ts` is a second, independent implementation of the station rules that the properties compare the reducer against. A TLA+ model would add three things that sampling cannot give. It explores every interleaving of a small instance (three boxes, two workers, a shipment of two) instead of a random sample, so a bug that needs one specific schedule shows up as a trace. It states liveness, such as "a merged change is eventually shipped, and no box waits forever under a free cage", which a property over finite sequences cannot say. The liveness lane here only shows that one recovery script exists from sampled states. And it models HQ, the webhook path, the poller and the human as separate actors with lost, duplicated and reordered messages as steps, which tests the idempotence claim against schedules the generator may never produce. The costs are a second language to keep in step with `lifecycle.ts`, with no check that the two agree unless traces from one are replayed through the other, and a model-checker run in CI. No TLA+ model is written here. The operator picks fast-check, TLA+ or both.

Two defaults to confirm along with it. A box whose review asks for changes stays in `qc` and does not rejoin the belt. And with one GitHub account no approval can come from a peer, so a box waits in `qc` until a second account or an app exists (G0 gap for P1-2).

New G1 questions from this round.

**Worker name versus host login.** `hire` names a worker, and the host reports an author login. The model treats the hired name and the author as the same account (compared without case), and refuses both as reviewer. If a cage pushes under an account other than the name HQ gave it, the adapter must map one to the other, or the hired name must be defined as the host login. The operator decides which side owns the mapping. The same mapping must cover aliases, renamed accounts and bot accounts, none of which the model handles.

**Adopt or replace events.** The model follows a replacement PR on its own when the earlier one was closed (an open change outranks a closed one) and ships on a merged change whatever its number. A human who wants to pick a particular PR out of several open ones on one branch has no event for it, and the lower number wins. The alternative is a human `adopt_change` event that pins a box to one change. It costs a field in the state, and it makes the reorder lane's claim conditional on an order between a human event and the facts. The operator decides whether the automatic rule is enough.

**Fork PRs.** A fork PR is dropped when the head repo differs from the base repo. This needs the host adapter to report the head repo, which P0-4's parser drops. The alternative is to filter forks in the adapter and keep the reducer as it was. Dropping them in both places is safe.

**Cage release acknowledgement.** The model frees a cage when it emits `release_cage`. If the executor needs a `stopping` station and a `cage_stopped` hook event, the budget property changes: a stopping cage still counts.

**A shipment with a human-cancelled member.** It can never depart, and its other boxes stay at `shipping`. A `resize_shipment` event, or a rule that a human cancel removes the member, would let the rest ship.

