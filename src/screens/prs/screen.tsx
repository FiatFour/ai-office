import { useEffect, useRef, useState } from 'react';
import { useHq } from '../../floor/useHq.ts';
import { type Detail, fetchDetail, fetchList, type List } from './model.ts';
import { Board } from './view.tsx';
import './prs.css';

/**
 * Reads again on every push from HQ. Pushes can come faster than an answer, so an answer is dropped only when a newer
 * one is already shown, never just because another read started.
 */
const useLatest = <T,>(read: (() => Promise<T>) | null, id: unknown, push: unknown, empty: T): T => {
  const [shown, setShown] = useState<{ id: unknown; value: T }>({ id, value: empty });
  const asked = useRef(0);
  const applied = useRef(0);
  const wanted = useRef(id);
  wanted.current = id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `push` is why this runs again, `read` is new on every render
  useEffect(() => {
    if (read === null) return;
    asked.current += 1;
    const mine = asked.current;
    void read().then((value) => {
      if (mine < applied.current || id !== wanted.current) return;
      applied.current = mine;
      setShown({ id, value });
    });
  }, [id, push]);
  return shown.id === id ? shown.value : empty;
};

const LOADING_LIST: List = { phase: 'loading' };
const LOADING_DETAIL: Detail = { phase: 'loading' };

const Prs = () => {
  const { snapshot } = useHq();
  const list = useLatest(() => fetchList(), 'list', snapshot, LOADING_LIST);
  const [picked, setPicked] = useState<number | null>(null);
  const rows = list.phase === 'rows' ? list.rows : [];
  const selected = rows.some((row) => row.number === picked) ? picked : (rows[0]?.number ?? null);
  // The first PR shown stays picked, so a PR that moves up the list does not take the detail away.
  useEffect(() => {
    if (selected !== picked) setPicked(selected);
  }, [selected, picked]);
  const detail = useLatest(selected === null ? null : () => fetchDetail(selected), selected, snapshot, LOADING_DETAIL);
  return <Board list={list} detail={detail} selected={selected} onSelect={setPicked} search={location.search} />;
};

export const screen = { id: 'prs', ready: '.prs[data-phase="done"]', Component: Prs };
