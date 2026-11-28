import { type Box, branchOf, type Change, type State, type TaskId } from '@agent-works/core';
import type { ChangeSnapshot, ReviewFact } from '../githost/host.ts';
import { REVIEW_MARK } from '../modes/cages.ts';

/**
 * A merge brief exists only after the approvals are met and the checks are green. Both gates here must pass: HQ's own
 * state, and then a read of the host, which can know about a moved head or a red check before HQ's next poll does.
 */

export type NoBriefWhy =
  | 'no-pr'
  | 'test'
  | 'review'
  | 'changes'
  | 'closed'
  | 'head-moved'
  | 'no-checks'
  | 'checks'
  | 'approvals';

export interface Refusal {
  readonly ok: false;
  readonly why: NoBriefWhy;
  /** The names behind the refusal: the checks that are not green, or who asked for changes. */
  readonly names: readonly string[];
}

const no = (why: NoBriefWhy, names: readonly string[] = []): Refusal => ({ ok: false, why, names });

export interface Candidate {
  readonly ok: true;
  readonly box: Box;
  readonly change: Change;
  /** HQ has seen the merge, so there is nothing left to merge. */
  readonly shipped: boolean;
}

export const hqGate = (state: State, task: TaskId, repo: string): Candidate | Refusal => {
  const box = state.boxes[task];
  if (box === undefined || box.state === 'belt' || box.state === 'building') return no('no-pr');
  if (box.state === 'cancelled') return no('closed');
  if (box.state === 'test') return no('test');
  if (box.state === 'qc') return no(box.changesRequested ? 'changes' : 'review');
  const change = state.changes[box.pr];
  if (change === undefined || change.branch !== branchOf(task) || change.repo.toLowerCase() !== repo.toLowerCase())
    return no('no-pr');
  return { ok: true, box, change, shipped: box.state !== 'merge' };
};

/**
 * Who stands where on one head, by the host's reviews alone. It counts what HQ counts: an approval is an approval on the
 * host. With one shared account the host cannot say which worker asked for changes, so HQ's marker does, and only on a
 * review that HQ's own reviewer login posted. A dismissed review takes the verdict of its reviewer away.
 */
export const standing = (
  reviews: readonly ReviewFact[],
  head: string,
  self: string,
): ReadonlyMap<string, 'approve' | 'changes'> => {
  const verdicts = new Map<string, 'approve' | 'changes'>();
  for (const review of [...reviews].sort((a, b) => a.at - b.at)) {
    if (review.commitId !== head) continue;
    const mark = review.reviewer.toLowerCase() === self ? REVIEW_MARK.exec(review.body) : null;
    const who = (mark?.[1] ?? review.reviewer).toLowerCase();
    if (review.verdict === null) verdicts.delete(who);
    else if (review.verdict === 'changes' || mark?.[2] === 'changes') verdicts.set(who, 'changes');
    else if (review.verdict === 'approve') verdicts.set(who, 'approve');
  }
  return verdicts;
};

export interface Passed {
  readonly ok: true;
  readonly phase: 'ready' | 'merged';
  readonly approvers: readonly string[];
}

export const hostGate = (
  candidate: Candidate,
  snapshot: ChangeSnapshot,
  self: string,
  required: number,
): Passed | Refusal => {
  const head = candidate.change.head.v;
  if (snapshot.change.headSha !== head) return no('head-moved');
  if (snapshot.change.state === 'closed') return no('closed');
  const checks = snapshot.checks.filter((check) => check.headSha === head);
  if (checks.length === 0) return no('no-checks');
  const red = checks.filter((check) => check.state !== 'success');
  if (red.length > 0)
    return no(
      'checks',
      red.map((check) => check.name),
    );
  const builders = new Set<string>([...candidate.box.builders, candidate.change.author.v]);
  const verdicts = [...standing(snapshot.reviews, head, self)].filter(([who]) => !builders.has(who));
  const changes = verdicts.filter(([, verdict]) => verdict === 'changes').map(([who]) => who);
  if (changes.length > 0) return no('changes', changes);
  const approvers = verdicts.map(([who]) => who).sort();
  if (approvers.length < required) return no('approvals', approvers);
  return { ok: true, phase: snapshot.change.state === 'merged' ? 'merged' : 'ready', approvers };
};
