import { useEffect, useMemo, useState } from 'react';
import { useHq } from '../../floor/useHq.ts';
import { fetchBrief, newestOnly, type Page, taskOf } from './model.ts';
import { Board } from './view.tsx';
import './merge-brief.css';

/** HQ pushes only when its own state changes, so an open page also asks on a timer and sees a host that moved. */
const REREAD_MS = 15_000;

const usePage = (task: string | null, push: unknown): Page => {
  const [page, setPage] = useState<Page>(task === null ? { phase: 'no-task' } : { phase: 'loading' });
  const read = useMemo(() => (task === null ? null : newestOnly(() => fetchBrief(task), setPage)), [task]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `push` is why this runs again
  useEffect(() => {
    void read?.();
  }, [read, push]);
  useEffect(() => {
    if (read === null) return;
    const timer = setInterval(() => void read(), REREAD_MS);
    return () => clearInterval(timer);
  }, [read]);
  return page;
};

const NOTHING: ReadonlySet<string> = new Set();

const MergeBrief = () => {
  const { snapshot } = useHq();
  const page = usePage(taskOf(location.search), snapshot);
  const head = page.phase === 'read' && page.answer.state === 'brief' ? page.answer.brief.head : null;
  // Ticks belong to one head: a new commit has not been looked at.
  const [kept, setKept] = useState<{ head: string | null; ticked: ReadonlySet<string> }>({
    head: null,
    ticked: NOTHING,
  });
  const ticked = kept.head === head ? kept.ticked : NOTHING;
  const onTick = (id: string) => {
    const next = new Set(ticked);
    if (!next.delete(id)) next.add(id);
    setKept({ head, ticked: next });
  };
  return <Board page={page} ticked={ticked} onTick={onTick} search={location.search} />;
};

export const screen = { id: 'merge-brief', ready: '.mb[data-phase="done"]', Component: MergeBrief };
