import type { Command, State } from '../src/lifecycle.js';
import type { Step } from './harness.js';

export const COVERAGE_KEYS = [
  'staleHeadReview',
  'budgetFullWithWaiting',
  'multiBoxDeparted',
  'mergeWhileAtMerge',
  'secondPeerReview',
  'rename',
  'replacementPr',
  'laterPrAfterShip',
  'forkChange',
  'shipped',
  'merge',
  'qc',
  'cancelled',
] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];
export type Hits = Record<CoverageKey, number>;

export const emptyHits = (): Hits => Object.fromEntries(COVERAGE_KEYS.map((key) => [key, 0])) as Hits;

const changesOf = (state: State, repo: string, number: number) =>
  Object.values(state.changes).filter((change) => change.repo === repo && change.number === number);

function hitsOf(step: Step): Set<CoverageKey> {
  const { event, before, after, commands } = step;
  const hit = new Set<CoverageKey>();
  if (event.source === 'webhook' && event.kind === 'review') {
    if (changesOf(before, event.repo, event.number).some((change) => change.head.v !== event.headSha))
      hit.add('staleHeadReview');
    const key = `${event.repo}#${event.number}|${event.headSha}`;
    const groupBefore = Object.keys(before.reviews[key] ?? {});
    const groupAfter = Object.keys(after.reviews[key] ?? {});
    if (groupBefore.length >= 1 && groupAfter.length > groupBefore.length) hit.add('secondPeerReview');
  }
  if (event.source === 'webhook' && event.kind === 'change') {
    if (changesOf(before, event.repo, event.number).some((change) => change.branch !== event.branch)) hit.add('rename');
    if (event.headRepo.toLowerCase() !== event.repo.toLowerCase()) hit.add('forkChange');
    const task = event.branch.startsWith('aw/') ? event.branch.slice(3) : '';
    if (before.boxes[task]?.state === 'shipped') hit.add('laterPrAfterShip');
  }
  const running = Object.values(after.boxes).filter((box) => box.state === 'building').length;
  if (
    running === after.config.budget &&
    Object.values(after.boxes).some((box) => box.state === 'belt' && box.worker !== null)
  )
    hit.add('budgetFullWithWaiting');
  for (const command of commands as readonly Command[]) {
    if (command.kind === 'dispatch_truck' && (after.shipments[command.shipment]?.size ?? 0) >= 2)
      hit.add('multiBoxDeparted');
  }
  for (const box of Object.values(after.boxes)) {
    const prev = before.boxes[box.id];
    if (prev?.state === 'merge' && (box.state === 'shipping' || box.state === 'shipped')) hit.add('mergeWhileAtMerge');
    if (prev?.state === 'cancelled' && prev.reason === 'closed' && box.state !== 'cancelled') hit.add('replacementPr');
    if (box.state === 'shipped') hit.add('shipped');
    if (box.state === 'merge') hit.add('merge');
    if (box.state === 'qc') hit.add('qc');
    if (box.state === 'cancelled') hit.add('cancelled');
  }
  return hit;
}

export function tallySequence(hits: Hits, steps: readonly Step[]) {
  const seen = new Set<CoverageKey>();
  for (const step of steps) for (const key of hitsOf(step)) seen.add(key);
  for (const key of seen) hits[key] += 1;
}

export const coverageLine = (sequences: number, hits: Hits) =>
  `coverage over ${sequences} sequences, sequences that hit each: ${COVERAGE_KEYS.map((key) => `${key}=${hits[key]}`).join(' ')}`;
