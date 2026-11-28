import type { Brief, BriefAnswer, TimelineEntry } from '../../../server/brief/store.ts';

export type { Brief, BriefAnswer, TimelineEntry };

/** `no-task` is a page opened without `?task=`. `none` is an HQ that runs no factory, so it has no briefs. */
export type Page =
  | { readonly phase: 'loading' }
  | { readonly phase: 'no-task' }
  | { readonly phase: 'none' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'read'; readonly answer: BriefAnswer };

export const taskOf = (search: string): string | null => new URLSearchParams(search).get('task') || null;

export const fetchBrief = async (task: string, ask: typeof fetch = fetch): Promise<Page> => {
  try {
    const res = await ask(`/api/briefs/${encodeURIComponent(task)}`, { cache: 'no-store' });
    if (res.status === 404) return { phase: 'none' };
    if (!res.ok) return { phase: 'error', message: `HTTP ${res.status}` };
    return { phase: 'read', answer: (await res.json()) as BriefAnswer };
  } catch (error) {
    return { phase: 'error', message: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Wraps a read so an answer that arrives after a newer one is already shown is dropped. An old "ready" must never
 * replace a newer "no brief".
 */
export const newestOnly = <T>(read: () => Promise<T>, show: (value: T) => void) => {
  let asked = 0;
  let shown = 0;
  return async (): Promise<void> => {
    asked += 1;
    const mine = asked;
    const value = await read();
    if (mine < shown) return;
    shown = mine;
    show(value);
  };
};

/** What the reader ticks before they merge. A step the work order or the worker named gets its own line. */
export const checklistOf = (brief: Brief): readonly { readonly id: string; readonly step: string | null }[] => [
  { id: 'read', step: null },
  ...(brief.beforeMerge.state === 'collected'
    ? brief.beforeMerge.lines.map((step, i) => ({ id: `step-${i}`, step }))
    : [{ id: 'setup', step: null }]),
  { id: 'diff', step: null },
];

export const HOSTS = {
  github: { name: 'GitHub', kind: 'PR', sign: '#' },
  gitlab: { name: 'GitLab', kind: 'MR', sign: '!' },
} as const;

/** The host's own page of check runs. Only GitHub's address for it is known here. */
export const checksUrl = (brief: Brief): string | null =>
  brief.url === null || brief.host !== 'github' ? brief.url : `${brief.url}/checks`;
